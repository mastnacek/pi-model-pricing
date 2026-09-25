/**
 * OpenRouter popularity layer for pi-model-pricing.
 *
 * Source: `GET https://openrouter.ai/api/v1/datasets/rankings-daily`
 * — the same dataset that powers https://openrouter.ai/rankings. Up to 51 rows
 * per day: the top 50 public models by total token usage (`prompt_tokens +
 * completion_tokens`), plus one aggregated `other` row that we ignore.
 *
 * Requires a valid OpenRouter API key (same key as inference, so it also works
 * for the alias providers created by pi-openrouter-accounts).
 *
 * Data is licensed CC BY 4.0 and must be attributed:
 *   "Source: OpenRouter (openrouter.ai/rankings), as of {meta.as_of}."
 *
 * Consequence worth knowing: popularity is only defined for models that reached
 * the daily top 50 at least once inside the window. A model missing from the
 * dataset is *not* unpopular-by-measurement — it simply never entered the top
 * 50, so no badge is shown instead of a misleading "0".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getOpenRouterApiKey } from "./openrouter.js";
import { agentDir, popularityTtlMs } from "./config.js";

import type {
  CachePayload,
  ModelPopularity,
  PopularityCacheStatus,
  PopularityIndex,
  RawRow,
} from "./src/popularity/types.js";
import { buildEntries, buildIndex, normalizeSlug } from "./src/popularity/aggregate.js";

// Re-exported so every existing importer keeps working unchanged.
export type { ModelPopularity, PopularityCacheStatus } from "./src/popularity/types.js";

export function popularityAttribution(status = getPopularityCacheStatus()): string {
  const asOf = status.asOf ? new Date(status.asOf).toISOString() : "unknown";
  return `Source: OpenRouter (openrouter.ai/rankings), as of ${asOf}. Licensed under CC BY 4.0.`;
}

const CACHE_DIR = path.join(agentDir(), "cache");

const CACHE_FILE = path.join(CACHE_DIR, "openrouter-popularity-cache.json");

const ENDPOINT = "https://openrouter.ai/api/v1/datasets/rankings-daily";

let index: PopularityIndex | null = null;

let lastFetchTimestamp: number | null = null;

let isFetching = false;

let lastError: string | null = null;
/** Incremented on every successful fetch, so callers can detect new data. */

let refreshCount = 0;

/* ------------------------------------------------------------------ */
/* Slug normalization                                                  */
/* ------------------------------------------------------------------ */

/**
 * Split a permaslug into a base and a `:variant` suffix, then strip a trailing
 * `YYYYMMDD` revision date from the base while preserving the variant.
 * Used only as a *fallback* join: exact permaslug / canonical_slug matching runs
 * first, because date-stripping alone collides across revisions of the same
 * model family (e.g. `deepseek-v4-flash-20260423` vs `...-20260731`).
 */

function loadCacheFromDisk(): boolean {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const data: CachePayload = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!data || !Array.isArray(data.entries) || typeof data.timestamp !== "number") {
      return false;
    }
    index = buildIndex(data.entries, {
      windowStart: data.windowStart,
      windowEnd: data.windowEnd,
      asOf: data.asOf,
    });
    lastFetchTimestamp = data.timestamp;
    return Date.now() - data.timestamp < popularityTtlMs();
  } catch {
    return false;
  }
}

function saveCacheToDisk(): void {
  if (!index || !lastFetchTimestamp) return;
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const payload: CachePayload = {
      timestamp: lastFetchTimestamp,
      version: 1,
      entries: index.ranked,
      windowStart: index.windowStart,
      windowEnd: index.windowEnd,
      asOf: index.asOf,
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.error("[pi-model-pricing] Failed to save popularity cache:", err);
  }
}

/* ------------------------------------------------------------------ */
/* Fetch                                                               */
/* ------------------------------------------------------------------ */

export async function fetchOpenRouterPopularity(
  force = false,
): Promise<PopularityIndex | null> {
  if (
    !force &&
    index &&
    lastFetchTimestamp &&
    Date.now() - lastFetchTimestamp < popularityTtlMs()
  ) {
    return index;
  }
  if (isFetching) return index;

  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    lastError = "no OpenRouter API key available (rankings-daily is key-gated)";
    return index;
  }

  isFetching = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(ENDPOINT, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "pi-model-pricing/1.1.0",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      // 401 = bad key, 429 = the documented 30/min + 500/day budget. Keep the
      // previous index rather than blanking the UI.
      throw new Error(`OpenRouter rankings API error: ${res.status} ${res.statusText}`);
    }

    const json: { data?: RawRow[]; meta?: Record<string, unknown> } = await res.json();
    const rows = Array.isArray(json.data) ? json.data : [];
    if (rows.length > 0) {
      const built = buildEntries(rows);
      const meta = json.meta ?? {};
      index = buildIndex(built.entries, {
        windowStart:
          typeof meta.start_date === "string" ? meta.start_date : built.windowStart,
        windowEnd: typeof meta.end_date === "string" ? meta.end_date : built.windowEnd,
        asOf: typeof meta.as_of === "string" ? meta.as_of : undefined,
      });
      lastFetchTimestamp = Date.now();
      lastError = null;
      refreshCount += 1;
      saveCacheToDisk();
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error("[pi-model-pricing] Error fetching OpenRouter popularity:", lastError);
    if (!index) loadCacheFromDisk();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    isFetching = false;
  }

  return index;
}

export async function initOpenRouterPopularity(): Promise<void> {
  // Load the cached ranking only. Deliberately does NOT hit the network at
  // extension load: the daily refresh is triggered by the model selector opening
  // (see `ensurePopularityFresh`), per the once-a-day requirement.
  loadCacheFromDisk();
}

/** True when there is no usable cache or it is older than the configured TTL. */

export function isPopularityStale(): boolean {
  if (!index || !lastFetchTimestamp) return true;
  return Date.now() - lastFetchTimestamp >= popularityTtlMs();
}

/**
 * Daily refresh trigger. Called when the model selector opens; refreshes in the
 * background only when stale, and invokes `onRefreshed` only if new data
 * actually arrived (so callers can safely re-render without churn).
 */

export function ensurePopularityFresh(onRefreshed?: () => void): void {
  if (!isPopularityStale() || isFetching) return;
  const before = refreshCount;
  void fetchOpenRouterPopularity(true).then(() => {
    if (refreshCount !== before) onRefreshed?.();
  });
}

/** Monotonic counter of successful fetches; lets callers detect new data. */

export function getPopularityRefreshCount(): number {
  return refreshCount;
}

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve popularity for a catalog model.
 *
 * `canonicalSlug` (from `/api/v1/models`) is the reliable join key because the
 * dataset is keyed on canonical permaslugs. `modelId` covers providers that
 * expose the permaslug directly. A `:variant` suffix is transferred onto the
 * canonical slug, since the catalog strips it from `canonical_slug` while the
 * dataset ranks variants as separate rows.
 */

export function getModelPopularity(
  modelId: string | undefined,
  canonicalSlug?: string | undefined,
): ModelPopularity | undefined {
  if (!index || !modelId) return undefined;

  const colon = modelId.indexOf(":");
  const variant = colon >= 0 ? modelId.slice(colon) : "";
  const baseId = colon >= 0 ? modelId.slice(0, colon) : modelId;

  const exact: Array<{ slug: string; matchedBy: ModelPopularity["matchedBy"] }> = [];
  if (canonicalSlug) {
    exact.push({ slug: `${canonicalSlug}${variant}`, matchedBy: "canonical" });
    exact.push({ slug: canonicalSlug, matchedBy: "canonical" });
  }
  exact.push({ slug: modelId, matchedBy: "id" });
  if (variant) exact.push({ slug: `${baseId}${variant}`, matchedBy: "id" });

  for (const candidate of exact) {
    const hit = index.bySlug.get(candidate.slug);
    if (hit) return { ...hit, matchedBy: candidate.matchedBy };
  }

  for (const candidate of exact) {
    const hit = index.byKey.get(normalizeSlug(candidate.slug));
    if (hit) return { ...hit, matchedBy: "normalized" };
  }

  return undefined;
}

/** Top `limit` models by total tokens inside the cached window. */

export function getTopPopular(limit = 15): ModelPopularity[] {
  if (!index) return [];
  return index.ranked.slice(0, Math.max(0, limit));
}

export function getPopularityCacheStatus(): PopularityCacheStatus {
  const ageMinutes = lastFetchTimestamp
    ? Math.round((Date.now() - lastFetchTimestamp) / 60000)
    : null;
  return {
    loaded: index !== null,
    stale: isPopularityStale(),
    count: index?.ranked.length ?? 0,
    timestamp: lastFetchTimestamp,
    ageMinutes,
    ttlHours: Math.round(popularityTtlMs() / 3600000),
    windowStart: index?.windowStart,
    windowEnd: index?.windowEnd,
    asOf: index?.asOf,
  };
}

/** Last fetch error, surfaced by `/model-pricing` so a 401/429 is not silent. */

export function getPopularityLastError(): string | null {
  return lastError;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return Math.round(n).toString();
}

export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const pct = share * 100;
  return pct >= 1 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`;
}

/** Window length in whole days, for labels like "30d". */

export function windowLabel(status = getPopularityCacheStatus()): string {
  if (!status.windowStart || !status.windowEnd) return "window";
  const start = Date.parse(`${status.windowStart}T00:00:00Z`);
  const end = Date.parse(`${status.windowEnd}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return "window";
  const days = Math.round((end - start) / 86400000) + 1;
  return `${days}d`;
}
