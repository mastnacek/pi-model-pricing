/**
 * Pure aggregation: dataset rows -> ranked entries -> lookup index.
 *
 * No filesystem, no network and no module state — every input is a parameter.
 */

import type { ModelPopularity, PopularityIndex, RawRow, SlugAggregate } from "./types.js";

export function normalizeSlug(slug: string): string {
  const colon = slug.indexOf(":");
  const base = colon >= 0 ? slug.slice(0, colon) : slug;
  const variant = colon >= 0 ? slug.slice(colon) : "";
  return `${base.replace(/-\d{8}$/, "")}${variant}`;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export function buildEntries(rows: RawRow[]): {
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

export function buildIndex(
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
