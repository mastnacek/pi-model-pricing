import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface ModelPricingCost {
  input: number; // USD per 1M tokens
  output: number; // USD per 1M tokens
  cacheRead?: number; // USD per 1M tokens
  cacheWrite?: number; // USD per 1M tokens
}

export interface LiveModelPrice {
  id: string;
  name: string;
  cost: ModelPricingCost;
  contextLength?: number;
  isFree: boolean;
  updatedAt: number;
}

interface CachePayload {
  timestamp: number;
  count: number;
  models: Record<string, LiveModelPrice>;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL
const CACHE_DIR = path.join(os.homedir(), ".pi", "agent", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "openrouter-pricing-cache.json");
const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");

let memoryPriceMap: Record<string, LiveModelPrice> = {};
let lastFetchTimestamp: number | null = null;
let isFetching = false;

function getOpenRouterApiKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) {
    return process.env.OPENROUTER_API_KEY;
  }
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
      if (auth.openrouter?.apiKey) {
        return auth.openrouter.apiKey;
      }
    }
  } catch {}
  return undefined;
}

export function formatPriceNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || isNaN(n)) return "?";
  if (n === 0) return "0";
  if (n < 0.001) return n.toFixed(4);
  if (n < 0.01) return n.toFixed(3);
  if (n < 0.1) return n.toFixed(3).replace(/0+$/, "");
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2).replace(/\.?0+$/, "");
}

function loadCacheFromDisk(): boolean {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const data: CachePayload = JSON.parse(raw);
    if (!data || !data.models || typeof data.timestamp !== "number")
      return false;

    memoryPriceMap = data.models;
    lastFetchTimestamp = data.timestamp;

    const isExpired = Date.now() - data.timestamp > CACHE_TTL_MS;
    return !isExpired;
  } catch {
    return false;
  }
}

function saveCacheToDisk(): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const payload: CachePayload = {
      timestamp: lastFetchTimestamp || Date.now(),
      count: Object.keys(memoryPriceMap).length,
      models: memoryPriceMap,
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.error("[pi-model-pricing] Failed to save cache to disk:", err);
  }
}

/**
 * Fetch live model pricing from OpenRouter API.
 * Never hardcoded — queries https://openrouter.ai/api/v1/models
 */
export async function fetchLiveOpenRouterModels(
  force = false,
): Promise<Record<string, LiveModelPrice>> {
  if (!force && Object.keys(memoryPriceMap).length > 0) {
    if (lastFetchTimestamp && Date.now() - lastFetchTimestamp < CACHE_TTL_MS) {
      return memoryPriceMap;
    }
  }

  if (isFetching) {
    return memoryPriceMap;
  }

  isFetching = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "pi-model-pricing/1.0.0",
    };
    const apiKey = getOpenRouterApiKey();
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`OpenRouter API error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    const list = json?.data || [];
    const newMap: Record<string, LiveModelPrice> = {};
    const now = Date.now();

    for (const m of list) {
      if (!m.id) continue;
      // Pricing values are per single token in USD -> multiply by 1M for $/1M tokens
      const promptRate = Number(m.pricing?.prompt ?? 0) * 1_000_000;
      const completionRate = Number(m.pricing?.completion ?? 0) * 1_000_000;
      const cacheReadRate =
        Number(m.pricing?.input_cache_read ?? 0) * 1_000_000;
      const cacheWriteRate =
        Number(m.pricing?.input_cache_write ?? 0) * 1_000_000;

      const cost: ModelPricingCost = {
        input: promptRate,
        output: completionRate,
        cacheRead: cacheReadRate,
        cacheWrite: cacheWriteRate,
      };

      const isFree = promptRate === 0 && completionRate === 0;

      const item: LiveModelPrice = {
        id: m.id,
        name: m.name || m.id,
        cost,
        contextLength: m.context_length,
        isFree,
        updatedAt: now,
      };

      newMap[m.id.toLowerCase()] = item;
    }

    if (Object.keys(newMap).length > 0) {
      memoryPriceMap = newMap;
      lastFetchTimestamp = now;
      saveCacheToDisk();
    }
  } catch (err) {
    console.error(
      "[pi-model-pricing] Error fetching live OpenRouter pricing:",
      err,
    );
    // If memory is empty, try loading stale cache
    if (Object.keys(memoryPriceMap).length === 0) {
      loadCacheFromDisk();
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    isFetching = false;
  }

  return memoryPriceMap;
}

/**
 * Look up live model pricing by ID and optional provider.
 */
export function getLiveModelPrice(
  modelId: string,
  provider?: string,
): LiveModelPrice | undefined {
  if (!modelId) return undefined;
  const lowerId = modelId.toLowerCase();

  // 1. Direct match: e.g. "anthropic/claude-3.5-sonnet"
  if (memoryPriceMap[lowerId]) {
    return memoryPriceMap[lowerId];
  }

  // 2. Provider prefixed match: e.g. provider="openrouter", id="anthropic/claude-3.5-sonnet"
  if (
    provider &&
    provider.toLowerCase() === "openrouter" &&
    memoryPriceMap[lowerId]
  ) {
    return memoryPriceMap[lowerId];
  }

  // 3. Model under native provider: e.g. provider="anthropic", id="claude-3-5-sonnet" -> "anthropic/claude-3-5-sonnet"
  if (provider && provider.toLowerCase() !== "openrouter") {
    const combinedKey = `${provider.toLowerCase()}/${lowerId}`;
    if (memoryPriceMap[combinedKey]) {
      return memoryPriceMap[combinedKey];
    }
  }

  // 4. Strip provider prefix if id contains slash (e.g. "openrouter/anthropic/claude...")
  if (lowerId.startsWith("openrouter/")) {
    const stripped = lowerId.slice("openrouter/".length);
    if (memoryPriceMap[stripped]) {
      return memoryPriceMap[stripped];
    }
  }

  // 5. Partial suffix match for common models
  const keys = Object.keys(memoryPriceMap);
  for (const k of keys) {
    if (k.endsWith("/" + lowerId) || k === lowerId) {
      return memoryPriceMap[k];
    }
  }

  return undefined;
}

/**
 * Initialize pricing: loads disk cache immediately, refreshes in background if needed.
 */
export async function initOpenRouterPricing(): Promise<void> {
  const isFresh = loadCacheFromDisk();
  if (!isFresh || Object.keys(memoryPriceMap).length === 0) {
    // Non-blocking fetch
    void fetchLiveOpenRouterModels(true);
  }
}

export function getPricingCacheStatus(): {
  loaded: boolean;
  count: number;
  timestamp: number | null;
  ageMinutes: number | null;
} {
  const count = Object.keys(memoryPriceMap).length;
  const ageMinutes = lastFetchTimestamp
    ? Math.round((Date.now() - lastFetchTimestamp) / 60000)
    : null;
  return {
    loaded: count > 0,
    count,
    timestamp: lastFetchTimestamp,
    ageMinutes,
  };
}
