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
import * as os from "node:os";
import * as path from "node:path";
import { getOpenRouterApiKey } from "./openrouter.js";

export interface ModelPopularity {
  /** Dataset permaslug this entry was matched from (may include a `:variant`). */
  slug: string;
  /** Total tokens over the whole window. */
  tokens: number;
  /** Average tokens per day the model was ranked. */
  tokensPerDay: number;
  /** Number of days the model appeared in the daily top 50. */
  daysRanked: number;
  /** Best (lowest) daily rank achieved inside the window. */
  bestRank: number;
  /** Rank by total tokens across every ranked model in the window. */
  globalRank: number;
  /** Fraction (0..1) of all ranked model tokens in the window. */
  share: number;
  /** How the catalog model was joined to the dataset row. */
  matchedBy: "canonical" | "id" | "normalized";
}

export interface PopularityCacheStatus {
  loaded: boolean;
  count: number;
  timestamp: number | null;
  ageMinutes: number | null;
  windowStart?: string;
  windowEnd?: string;
  asOf?: string;
}

/** Canonical attribution required by OpenRouter's CC BY 4.0 license. */
export function popularityAttribution(status = getPopularityCacheStatus()): string {
  const asOf = status.asOf ? new Date(status.asOf).toISOString() : "unknown";
  return `Source: OpenRouter (openrouter.ai/rankings), as of ${asOf}. Licensed under CC BY 4.0.`;
}

interface RawRow {
  date?: string;
  model_permaslug?: string;
  total_tokens?: string;
}

/** Aggregated per-slug data before global ranking is applied. */
interface SlugAggregate {
  slug: string;
  tokens: number;
  days: Array<{ date: string; rank: number; tokens: number }>;
}

interface PopularityIndex {
  /** Dataset slug -> entry (exact match target). */
  bySlug: Map<string, ModelPopularity>;
  /** Normalized (date-stripped, variant-preserving) key -> entry. */
  byKey: Map<string, ModelPopularity>;
  /** All entries, sorted by total tokens descending. */
  ranked: ModelPopularity[];
  windowStart?: string;
  windowEnd?: string;
  asOf?: string;
  generatedAt: number;
}

interface CachePayload {
  timestamp: number;
  version: 1;
  entries: ModelPopularity[];
  windowStart?: string;
  windowEnd?: string;
  asOf?: string;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "openrouter-popularity-cache.json");
const ENDPOINT = "https://openrouter.ai/api/v1/datasets/rankings-daily";

let index: PopularityIndex | null = null;
let lastFetchTimestamp: number | null = null;
let isFetching = false;
let lastError: string | null = null;

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
function normalizeSlug(slug: string): string {
  const colon = slug.indexOf(":");
  const base = colon >= 0 ? slug.slice(0, colon) : slug;
  const variant = colon >= 0 ? slug.slice(colon) : "";
  return `${base.replace(/-\d{8}$/, "")}${variant}`;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

function buildEntries(rows: RawRow[]): {
  entries: ModelPopularity[];
  windowStart?: string;
  windowEnd?: string;
} {
  const byDate = new Map<string, RawRow[]>();
  let windowStart: string | undefined;
  let windowEnd: string | undefined;

  for (const row of rows) {
    const date = typeof row.date === "string" ? row.date : undefined;
    const slug = typeof row.model_permaslug === "string" ? row.model_permaslug : undefined;
    if (!date || !slug || slug === "other") continue;
    if (!windowStart || date < windowStart) windowStart = date;
    if (!windowEnd || date > windowEnd) windowEnd = date;
    const bucket = byDate.get(date);
    if (bucket) bucket.push(row);
    else byDate.set(date, [row]);
  }

  const aggregates = new Map<string, SlugAggregate>();

  for (const [date, bucket] of byDate) {
    // Defensive re-sort: the API already orders rows by total_tokens desc, but
    // rank derivation must not depend on that guarantee.
    const ranked = bucket
      .map((row) => ({
        slug: row.model_permaslug as string,
        tokens: Number(row.total_tokens ?? 0),
      }))
      .sort((a, b) => b.tokens - a.tokens || a.slug.localeCompare(b.slug));

    ranked.forEach((entry, i) => {
      const existing = aggregates.get(entry.slug);
      const record = { date, rank: i + 1, tokens: entry.tokens };
      if (existing) {
        existing.tokens += entry.tokens;
        existing.days.push(record);
      } else {
        aggregates.set(entry.slug, {
          slug: entry.slug,
          tokens: entry.tokens,
          days: [record],
        });
      }
    });
  }

  const totalTokens = [...aggregates.values()].reduce((sum, a) => sum + a.tokens, 0);
  const sorted = [...aggregates.values()].sort(
    (a, b) => b.tokens - a.tokens || a.slug.localeCompare(b.slug),
  );

  const entries: ModelPopularity[] = sorted.map((agg, i) => ({
    slug: agg.slug,
    tokens: agg.tokens,
    tokensPerDay: agg.days.length > 0 ? agg.tokens / agg.days.length : 0,
    daysRanked: agg.days.length,
    bestRank: agg.days.reduce((min, d) => Math.min(min, d.rank), Number.MAX_SAFE_INTEGER),
    globalRank: i + 1,
    share: totalTokens > 0 ? agg.tokens / totalTokens : 0,
    matchedBy: "canonical",
  }));

  return { entries, windowStart, windowEnd };
}

function buildIndex(
  entries: ModelPopularity[],
  meta: { windowStart?: string; windowEnd?: string; asOf?: string },
): PopularityIndex {
  const bySlug = new Map<string, ModelPopularity>();
  const byKey = new Map<string, ModelPopularity>();
  for (const entry of entries) {
    bySlug.set(entry.slug, entry);
    const key = normalizeSlug(entry.slug);
    // A collision here means two revisions of one family. Keep the busier one
    // rather than an arbitrary first-write winner.
    const prev = byKey.get(key);
    if (!prev || entry.tokens > prev.tokens) byKey.set(key, entry);
  }
  return {
    bySlug,
    byKey,
    ranked: entries,
    windowStart: meta.windowStart,
    windowEnd: meta.windowEnd,
    asOf: meta.asOf,
    generatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* Disk cache                                                          */
/* ------------------------------------------------------------------ */

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
    return Date.now() - data.timestamp < CACHE_TTL_MS;
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
    Date.now() - lastFetchTimestamp < CACHE_TTL_MS
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
  const isFresh = loadCacheFromDisk();
  if (!isFresh) {
    void fetchOpenRouterPopularity(true);
  }
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
  return {
    loaded: index !== null,
    count: index?.ranked.length ?? 0,
    timestamp: lastFetchTimestamp,
    ageMinutes: lastFetchTimestamp
      ? Math.round((Date.now() - lastFetchTimestamp) / 60000)
      : null,
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