/**
 * Model ranking / ordering for the Pi model selector.
 *
 * Sort spec grammar (config `sort`, or `/model-pricing sort <spec>`):
 *
 *   default            Pi's own order (no re-sorting)
 *   rating             OpenRouter popularity rank, most used first
 *   price              cheapest input rate first (output breaks ties)
 *   -price             most expensive first
 *   provider           group by Pi provider id (openrouter, openrouter-work…)
 *   source             models with live OpenRouter data before registry fallback
 *   context            smallest context window first
 *   name               model name, A→Z
 *   <key>,<key>,…      composite, evaluated left to right
 *
 * Any key may be prefixed with `-` for descending, e.g. `-rating,price`.
 * Unknown keys are ignored so a stale config never breaks the selector.
 *
 * `source` is the provenance of the numbers rendered next to a row:
 *   live      → matched in the live OpenRouter catalog (authoritative)
 *   registry  → model's own registered cost (no live match)
 *   unknown   → neither; nothing trustworthy to sort on
 */

import { getLiveModelPrice, formatPriceNumber } from "./openrouter.js";
import { getModelPopularity, type ModelPopularity } from "./popularity.js";
import {
  DEFAULT_SORT,
  loadConfig,
  updateConfig,
} from "./config.js";

export interface ModelCostResolution {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  isFree: boolean;
  source: "openrouter-live" | "builtin-registry" | "unknown";
}

export type SortKey =
  | "default"
  | "rating"
  | "price"
  | "provider"
  | "source"
  | "context"
  | "name";

interface SortToken {
  key: SortKey;
  descending: boolean;
}

const VALID_KEYS: ReadonlySet<string> = new Set([
  "default",
  "rating",
  "price",
  "provider",
  "source",
  "context",
  "name",
]);

/** Model-shape-agnostic view of a selector row. */
export interface SortableModel {
  id: string;
  provider: string;
  model: {
    id: string;
    name?: string;
    provider: string;
    contextWindow?: number;
    cost?: { input?: number; output?: number };
    [key: string]: unknown;
  };
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Cost of a model, preferring the live OpenRouter catalogue over the built-in
 * registry. Keeps `model.cost` in sync when the live rate wins, which is what
 * Pi's own footer/pricing display reads.
 */
export function resolveModelCost(model: SortableModel["model"]): ModelCostResolution {
  const live = getLiveModelPrice(model.id, model.provider);
  if (live) {
    if (!model.cost || model.provider === "openrouter") {
      model.cost = { ...live.cost };
    }
    return {
      input: live.cost.input,
      output: live.cost.output,
      cacheRead: live.cost.cacheRead,
      cacheWrite: live.cost.cacheWrite,
      isFree: live.isFree,
      source: "openrouter-live",
    };
  }

  if (
    model.cost &&
    (typeof model.cost.input === "number" || typeof model.cost.output === "number")
  ) {
    const isFree = (model.cost.input ?? 0) === 0 && (model.cost.output ?? 0) === 0;
    return {
      input: model.cost.input ?? 0,
      output: model.cost.output ?? 0,
      isFree,
      source: "builtin-registry",
    };
  }

  return { input: 0, output: 0, isFree: true, source: "unknown" };
}

/** Popularity for a selector row, joined via the live catalogue's canonical slug. */
export function resolvePopularity(
  model: SortableModel["model"],
): ModelPopularity | undefined {
  const live = getLiveModelPrice(model.id, model.provider);
  return getModelPopularity(model.id, live?.canonicalSlug);
}

export function formatCostSummary(cost: ModelCostResolution): string {
  if (cost.isFree) return "free";
  return `$${formatPriceNumber(cost.input)}/$${formatPriceNumber(cost.output)} per 1M`;
}

/* ------------------------------------------------------------------ */
/* Sort spec                                                           */
/* ------------------------------------------------------------------ */

export function parseSortSpec(raw: string | undefined): SortToken[] {
  if (!raw) return [];
  const tokens: SortToken[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const descending = trimmed.startsWith("-");
    const key = (descending ? trimmed.slice(1) : trimmed).toLowerCase();
    if (!VALID_KEYS.has(key) || key === "default") continue;
    tokens.push({ key: key as SortKey, descending });
  }
  return tokens;
}

/** Human-readable form, e.g. "rating ↓" or "provider ↑, price ↑". */
export function formatSortSpec(raw: string | undefined): string {
  const tokens = parseSortSpec(raw);
  if (tokens.length === 0) return "default";
  return tokens
    .map((t) => `${t.key} ${t.descending ? "↓" : "↑"}`)
    .join(", ");
}

export const SORT_PRESETS: Array<{ value: string; label: string; description: string }> = [
  { value: DEFAULT_SORT, label: DEFAULT_SORT, description: "Pi's own order (no re-sorting)" },
  { value: "rating", label: "rating", description: "most used first (OpenRouter token volume)" },
  { value: "price", label: "price", description: "cheapest input rate first" },
  { value: "-price", label: "-price", description: "most expensive input rate first" },
  { value: "provider,price", label: "provider,price", description: "group by provider, then cheapest" },
  { value: "source,rating", label: "source,rating", description: "live OpenRouter data first, then most used" },
  { value: "-rating", label: "-rating", description: "least used first" },
  { value: "context", label: "context", description: "smallest context window first" },
  { value: "name", label: "name", description: "model name, A→Z" },
];

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

const SOURCE_ORDER: Record<ModelCostResolution["source"], number> = {
  "openrouter-live": 0,
  "builtin-registry": 1,
  unknown: 2,
};

function compareByKey(
  a: SortableModel,
  b: SortableModel,
  key: SortKey,
): number {
  switch (key) {
    case "rating": {
      const ra = resolvePopularity(a.model);
      const rb = resolvePopularity(b.model);
      // Unranked models sort last in either direction: "descending" must not
      // promote models we simply have no usage data for.
      if (!ra && !rb) return 0;
      if (!ra) return 1;
      if (!rb) return -1;
      if (ra.globalRank !== rb.globalRank) return ra.globalRank - rb.globalRank;
      return rb.tokens - ra.tokens;
    }
    case "price": {
      const ca = resolveModelCost(a.model);
      const cb = resolveModelCost(b.model);
      if (ca.input !== cb.input) return ca.input - cb.input;
      return ca.output - cb.output;
    }
    case "provider":
      return a.provider.localeCompare(b.provider);
    case "source": {
      const sa = SOURCE_ORDER[resolveModelCost(a.model).source];
      const sb = SOURCE_ORDER[resolveModelCost(b.model).source];
      return sa - sb;
    }
    case "context":
      return (a.model.contextWindow ?? 0) - (b.model.contextWindow ?? 0);
    case "name":
      return (a.model.name ?? a.id).localeCompare(b.model.name ?? b.id);
    default:
      return 0;
  }
}

export function compareModels(
  a: SortableModel,
  b: SortableModel,
  tokens: SortToken[],
): number {
  for (const token of tokens) {
    if (token.key === "rating" && token.descending) {
      // Rank descending is "least used first"; unranked still goes last.
      const ra = resolvePopularity(a.model);
      const rb = resolvePopularity(b.model);
      if (!ra && !rb) continue;
      if (!ra) return 1;
      if (!rb) return -1;
      if (ra.globalRank !== rb.globalRank) return rb.globalRank - ra.globalRank;
      continue;
    }
    const result = compareByKey(a, b, token.key);
    if (result !== 0) return token.descending ? -result : result;
  }
  return 0;
}

/** Stable sort of selector rows; returns a new array. */
export function sortModelItems<T extends SortableModel>(items: T[], raw?: string): T[] {
  const tokens = parseSortSpec(raw ?? getSortSpec());
  if (tokens.length === 0) return items;
  return [...items].sort((a, b) => compareModels(a, b, tokens));
}

/* ------------------------------------------------------------------ */
/* Config accessors                                                    */
/* ------------------------------------------------------------------ */

export function getSortSpec(): string {
  const raw = loadConfig().sort;
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_SORT;
  return raw.trim();
}

export function setSortSpec(raw: string, isGlobal = false): string {
  const next = raw.trim().length > 0 ? raw.trim() : DEFAULT_SORT;
  updateConfig({ sort: next }, isGlobal);
  return next;
}

/**
 * Advance through SORT_PRESETS. A spec outside the presets (hand-written in the
 * config) cycles to the first preset instead of getting stuck.
 */
export function cycleSortSpec(isGlobal = false): string {
  const current = getSortSpec();
  const index = SORT_PRESETS.findIndex((preset) => preset.value === current);
  const next = SORT_PRESETS[(index + 1) % SORT_PRESETS.length];
  return setSortSpec(next.value, isGlobal);
}

export function isDefaultSort(raw?: string): boolean {
  return parseSortSpec(raw ?? getSortSpec()).length === 0;
}

/** Row key used to keep the highlighted model stable across re-sorting. */
export function rowKey(item: SortableModel): string {
  return `${item.provider}\0${item.id}`;
}

export { formatPriceNumber };