/**
 * Characterization tests for the pure half of `popularity.ts` — the formatting
 * helpers, plus the reads that must be safe before any data is loaded.
 *
 * The cache path is derived from `agentDir()` at module load, so the agent dir
 * has to be redirected before the dynamic import below.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pmp-format-"));
delete process.env.OPENROUTER_API_KEY;

const {
	formatShare,
	formatTokens,
	getModelPopularity,
	getPopularityCacheStatus,
	getPopularityLastError,
	getPopularityRefreshCount,
	getTopPopular,
	isPopularityStale,
	popularityAttribution,
	windowLabel,
} = await import("../popularity.js");

// --- formatTokens ------------------------------------------------------------

test("formatTokens renders magnitude suffixes and clamps junk to 0", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(-5), "0");
	assert.equal(formatTokens(Number.NaN), "0");
	assert.equal(formatTokens(Number.POSITIVE_INFINITY), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1000), "1K");
	assert.equal(formatTokens(1500), "2K");
	assert.equal(formatTokens(1e6), "1M");
	assert.equal(formatTokens(2.5e6), "3M");
	assert.equal(formatTokens(1e9), "1.0B");
	assert.equal(formatTokens(1.5e9), "1.5B");
	assert.equal(formatTokens(1e12), "1.00T");
	assert.equal(formatTokens(2.25e12), "2.25T");
});

test("formatTokens rounds sub-thousand values past the K threshold", () => {
	// Pinned quirk: the rounding happens after the threshold test, so 999.6
	// prints as a bare "1000" rather than "1K".
	assert.equal(formatTokens(999.6), "1000");
});

// --- formatShare -------------------------------------------------------------

test("formatShare picks precision by magnitude and never clamps", () => {
	assert.equal(formatShare(0), "0%");
	assert.equal(formatShare(-1), "0%");
	assert.equal(formatShare(Number.NaN), "0%");
	assert.equal(formatShare(0.005), "0.50%");
	assert.equal(formatShare(0.009), "0.90%");
	assert.equal(formatShare(0.01), "1.0%");
	assert.equal(formatShare(0.5), "50.0%");
	assert.equal(formatShare(1), "100.0%");
	// Pinned quirk: a share above 1 is rendered as-is, not clamped to 100%.
	assert.equal(formatShare(1.5), "150.0%");
});

// --- windowLabel -------------------------------------------------------------

test("windowLabel counts inclusive days and falls back to 'window'", () => {
	assert.equal(windowLabel({}), "window");
	assert.equal(windowLabel({ windowStart: "2026-01-01" }), "window");
	assert.equal(windowLabel({ windowStart: "2026-01-01", windowEnd: "2026-01-01" }), "1d");
	assert.equal(windowLabel({ windowStart: "2026-01-01", windowEnd: "2026-01-30" }), "30d");
	assert.equal(windowLabel({ windowStart: "2026-01-01", windowEnd: "2026-02-01" }), "32d");
	assert.equal(windowLabel({ windowStart: "nonsense", windowEnd: "2026-01-01" }), "window");
});

test("windowLabel defaults to the live cache status", () => {
	assert.equal(windowLabel(), "window", "nothing is loaded yet");
});

// --- popularityAttribution ---------------------------------------------------

test("popularityAttribution carries the CC BY 4.0 notice", () => {
	assert.equal(
		popularityAttribution({ asOf: "2026-01-30T00:00:00Z" }),
		"Source: OpenRouter (openrouter.ai/rankings), as of 2026-01-30T00:00:00.000Z. Licensed under CC BY 4.0.",
	);
	assert.equal(
		popularityAttribution({}),
		"Source: OpenRouter (openrouter.ai/rankings), as of unknown. Licensed under CC BY 4.0.",
	);
});

// --- reads before anything is loaded ----------------------------------------

test("an unloaded cache reports itself as empty and stale", () => {
	const status = getPopularityCacheStatus();
	assert.equal(status.loaded, false);
	assert.equal(status.stale, true);
	assert.equal(status.count, 0);
	assert.equal(status.timestamp, null);
	assert.equal(status.ageMinutes, null);
	assert.equal(status.ttlHours, 24, "default TTL is 24h");
	assert.equal(status.windowStart, undefined);
	assert.equal(status.asOf, undefined);

	assert.equal(isPopularityStale(), true);
});

test("lookups and counters are inert with no index loaded", () => {
	assert.deepEqual(getTopPopular(), []);
	assert.deepEqual(getTopPopular(3), []);
	assert.equal(getModelPopularity("acme/alpha"), undefined);
	assert.equal(getModelPopularity(undefined), undefined);
	assert.equal(getModelPopularity("acme/alpha", "acme/alpha"), undefined);
	assert.equal(getPopularityLastError(), null);
	assert.equal(getPopularityRefreshCount(), 0);
});

test("popularityAttribution defaults to the live status", () => {
	assert.match(popularityAttribution(), /as of unknown\. Licensed under CC BY 4\.0\.$/);
});
