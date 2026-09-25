/**
 * Data shapes for the OpenRouter popularity layer.
 *
 * Split out of `popularity.ts`. The four private shapes are exported so the
 * aggregation module and the state-holding module can share them; they are not
 * re-exported by the public entry point.
 */

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
  /** True when the cache is missing or older than the configured TTL. */
  stale: boolean;
  count: number;
  timestamp: number | null;
  ageMinutes: number | null;
  ttlHours: number;
  windowStart?: string;
  windowEnd?: string;
  asOf?: string;
}

/** Canonical attribution required by OpenRouter's CC BY 4.0 license. */

export interface RawRow {
  date?: string;
  model_permaslug?: string;
  total_tokens?: string;
}

/** Aggregated per-slug data before global ranking is applied. */

export interface SlugAggregate {
  slug: string;
  tokens: number;
  days: Array<{ date: string; rank: number; tokens: number }>;
}

export interface PopularityIndex {
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

export interface CachePayload {
  timestamp: number;
  version: 1;
  entries: ModelPopularity[];
  windowStart?: string;
  windowEnd?: string;
  asOf?: string;
}
