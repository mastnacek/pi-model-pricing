/**
 * Characterization tests for the disk-cache half of `popularity.ts`: what a
 * seeded cache file produces, how the catalog joins to dataset slugs, and how
 * the TTL drives staleness.
 *
 * Runs in its own process, so the module's single mutable index starts empty.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pmp-cache-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
delete process.env.OPENROUTER_API_KEY;

const CACHE_DIR = join(AGENT_DIR, "cache");
const CACHE_FILE = join(CACHE_DIR, "openrouter-popularity-cache.json");
const CONFIG_FILE = join(AGENT_DIR, "pi-model-pricing.json");

const pop = await import("../popularity.js");
const cfg = await import("../config.js");

/** A cache entry with the fields the index and lookups actually read. */
function entry(slug, tokens, over = {}) {
	return {
		slug,
		tokens,
		tokensPerDay: tokens,
		daysRanked: 1,
		bestRank: 1,
		globalRank: 1,
		share: 1,
		matchedBy: "canonical",
		...over,
	};
}

function seedCache(payload) {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(CACHE_FILE, JSON.stringify({ version: 1, ...payload }), "utf8");
}

// --- loading -----------------------------------------------------------------

test("initOpenRouterPopularity is a no-op when no cache file exists", async () => {
	await pop.initOpenRouterPopularity();
	assert.equal(pop.getPopularityCacheStatus().loaded, false);
	assert.equal(pop.isPopularityStale(), true);
});

test("a seeded cache populates the index and the status", async () => {
	const ts = Date.now();
	seedCache({
		timestamp: ts,
		entries: [entry("acme/alpha", 1300), entry("acme/bravo", 500), entry("acme/charlie", 200)],
		windowStart: "2026-01-01",
		windowEnd: "2026-01-30",
		asOf: "2026-01-30T00:00:00Z",
	});
	await pop.initOpenRouterPopularity();

	const status = pop.getPopularityCacheStatus();
	assert.equal(status.loaded, true);
	assert.equal(status.count, 3);
	assert.equal(status.timestamp, ts);
	assert.equal(status.ageMinutes, 0);
	assert.equal(status.windowStart, "2026-01-01");
	assert.equal(status.windowEnd, "2026-01-30");
	assert.equal(status.asOf, "2026-01-30T00:00:00Z");
	assert.equal(status.stale, false, "just written, so fresh under the 24h TTL");
	assert.equal(pop.isPopularityStale(), false);
	assert.equal(pop.windowLabel(), "30d");
});

test("getTopPopular slices the stored order without re-sorting", async () => {
	// Pinned: the cache order is trusted verbatim; a hand-edited cache that is not
	// sorted by tokens comes back in file order.
	seedCache({ timestamp: Date.now(), entries: [entry("acme/bravo", 5), entry("acme/alpha", 900)] });
	await pop.initOpenRouterPopularity();
	assert.deepEqual(pop.getTopPopular().map((e) => e.slug), ["acme/bravo", "acme/alpha"]);
	assert.deepEqual(pop.getTopPopular(1).map((e) => e.slug), ["acme/bravo"]);
	assert.deepEqual(pop.getTopPopular(0), []);
	assert.deepEqual(pop.getTopPopular(-5), []);
});

test("a corrupt cache file is ignored without discarding a loaded index", async () => {
	seedCache({ timestamp: Date.now(), entries: [entry("acme/alpha", 100)] });
	await pop.initOpenRouterPopularity();
	assert.equal(pop.getPopularityCacheStatus().count, 1);

	writeFileSync(CACHE_FILE, "{ not json", "utf8");
	await pop.initOpenRouterPopularity();
	assert.equal(pop.getPopularityCacheStatus().count, 1, "previous index survives");

	writeFileSync(CACHE_FILE, JSON.stringify({ entries: [] }), "utf8");
	await pop.initOpenRouterPopularity();
	assert.equal(pop.getPopularityCacheStatus().count, 1, "no timestamp means no load");
});

test("an empty but well-formed cache loads as an empty index", async () => {
	// Pinned quirk: entries: [] with a valid timestamp is accepted, so the status
	// flips to loaded=true while count stays 0.
	seedCache({ timestamp: Date.now(), entries: [] });
	await pop.initOpenRouterPopularity();
	const status = pop.getPopularityCacheStatus();
	assert.equal(status.loaded, true);
	assert.equal(status.count, 0);
});

// --- joins -------------------------------------------------------------------

test("getModelPopularity reports how it matched", async () => {
	seedCache({
		timestamp: Date.now(),
		entries: [
			entry("acme/alpha", 100),
			entry("acme/beta", 80),
			entry("acme/gamma:free", 60),
			entry("acme/delta", 40),
		],
	});
	await pop.initOpenRouterPopularity();

	assert.equal(pop.getModelPopularity("acme/alpha").matchedBy, "id");
	assert.equal(pop.getModelPopularity("acme/alpha", "acme/alpha").matchedBy, "canonical");
	// The dataset slug for a variant keeps the suffix, so it is found exactly.
	assert.equal(pop.getModelPopularity("acme/gamma:free", "acme/gamma").matchedBy, "canonical");
	assert.equal(pop.getModelPopularity("acme/gamma:free", "acme/gamma").slug, "acme/gamma:free");
	// A dated revision normalises back onto the base slug.
	assert.equal(pop.getModelPopularity("acme/delta-20260101").matchedBy, "normalized");
	assert.equal(pop.getModelPopularity("acme/delta-20260101").slug, "acme/delta");
	assert.equal(pop.getModelPopularity("acme/unknown"), undefined);
	assert.equal(pop.getModelPopularity(""), undefined, "empty id is not a join key");
});

test("a normalized key collision keeps the busier revision", async () => {
	seedCache({
		timestamp: Date.now(),
		entries: [entry("acme/epsilon-20260101", 10), entry("acme/epsilon-20260731", 90)],
	});
	await pop.initOpenRouterPopularity();
	assert.equal(pop.getModelPopularity("acme/epsilon").slug, "acme/epsilon-20260731");
});

// --- TTL ---------------------------------------------------------------------

test("the configured TTL decides staleness and is surfaced in hours", async () => {
	writeFileSync(CONFIG_FILE, JSON.stringify({ popularityTtlHours: 1 }), "utf8");
	cfg.reloadConfig();
	assert.equal(pop.getPopularityCacheStatus().ttlHours, 1);

	seedCache({ timestamp: Date.now() - 2 * 3600_000, entries: [entry("acme/alpha", 1)] });
	await pop.initOpenRouterPopularity();
	assert.equal(pop.isPopularityStale(), true, "2h old under a 1h TTL");
	assert.equal(pop.getPopularityCacheStatus().ageMinutes, 120);

	seedCache({ timestamp: Date.now() - 60_000, entries: [entry("acme/alpha", 1)] });
	await pop.initOpenRouterPopularity();
	assert.equal(pop.isPopularityStale(), false, "1 minute old is inside the TTL");
});

test("a nonsense TTL falls back to the 24h default", () => {
	writeFileSync(CONFIG_FILE, JSON.stringify({ popularityTtlHours: -3 }), "utf8");
	cfg.reloadConfig();
	assert.equal(pop.getPopularityCacheStatus().ttlHours, 24);
});
