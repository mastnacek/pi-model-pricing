/**
 * Characterization tests for the fetch half of `popularity.ts`.
 *
 * `fetch` is stubbed on globalThis, so no network access happens and the
 * aggregation, error reporting and cache writing can all be pinned exactly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pmp-fetch-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
process.env.OPENROUTER_API_KEY = "test-key";

const CACHE_DIR = join(AGENT_DIR, "cache");
const CACHE_FILE = join(CACHE_DIR, "openrouter-popularity-cache.json");

const pop = await import("../popularity.js");
const cfg = await import("../config.js");

/** Two days of rows, one aggregated `other` row, one model ranked twice. */
const ROWS = [
	{ date: "2026-01-01", model_permaslug: "acme/alpha", total_tokens: "1000" },
	{ date: "2026-01-01", model_permaslug: "beta/bravo", total_tokens: "500" },
	{ date: "2026-01-02", model_permaslug: "acme/alpha", total_tokens: "300" },
	{ date: "2026-01-02", model_permaslug: "other", total_tokens: "9999" },
	{ date: "2026-01-02", model_permaslug: "beta/bravo", total_tokens: "100" },
];

function okResponse(data, meta = {}) {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		json: async () => ({ data, meta }),
	};
}

function seedCache(payload) {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(CACHE_FILE, JSON.stringify({ version: 1, ...payload }), "utf8");
}

// --- key gate ----------------------------------------------------------------

test("a missing API key is reported instead of attempted", async (t) => {
	const spy = t.mock.method(globalThis, "fetch", async () => okResponse(ROWS));
	delete process.env.OPENROUTER_API_KEY;

	const result = await pop.fetchOpenRouterPopularity(true);
	assert.equal(result, null, "nothing to return yet");
	assert.match(pop.getPopularityLastError(), /no OpenRouter API key available/);
	assert.equal(spy.mock.callCount(), 0, "no request without a key");

	process.env.OPENROUTER_API_KEY = "test-key";
});

// --- failures ----------------------------------------------------------------

test("a non-ok response surfaces the status and keeps the old index", async (t) => {
	t.mock.method(globalThis, "fetch", async () => ({
		ok: false,
		status: 401,
		statusText: "Unauthorized",
		json: async () => ({}),
	}));

	await pop.fetchOpenRouterPopularity(true);
	assert.equal(pop.getPopularityLastError(), "OpenRouter rankings API error: 401 Unauthorized");
	assert.equal(pop.getPopularityRefreshCount(), 0, "a failure is not a refresh");
});

test("a thrown fetch is caught, recorded and does not wedge the fetching flag", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("network down");
	});

	await pop.fetchOpenRouterPopularity(true);
	assert.equal(pop.getPopularityLastError(), "network down");

	// A later attempt must still run: the finally block cleared isFetching.
	const spy = t.mock.method(globalThis, "fetch", async () => okResponse(ROWS));
	await pop.fetchOpenRouterPopularity(true);
	assert.equal(spy.mock.callCount(), 1);
});

// --- success -----------------------------------------------------------------

test("a successful fetch aggregates rows and writes the cache", async (t) => {
	t.mock.method(globalThis, "fetch", async () =>
		okResponse(ROWS, {
			start_date: "2026-01-01",
			end_date: "2026-01-02",
			as_of: "2026-01-02T12:00:00Z",
		}),
	);

	const before = pop.getPopularityRefreshCount();
	const index = await pop.fetchOpenRouterPopularity(true);
	assert.ok(index);
	assert.equal(pop.getPopularityLastError(), null);
	assert.equal(pop.getPopularityRefreshCount(), before + 1, "a success bumps the counter");

	const status = pop.getPopularityCacheStatus();
	assert.equal(status.count, 2, "the aggregated 'other' row is dropped");
	assert.equal(status.windowStart, "2026-01-01");
	assert.equal(status.windowEnd, "2026-01-02");
	assert.equal(status.asOf, "2026-01-02T12:00:00Z");
	assert.equal(status.stale, false);

	const alpha = pop.getModelPopularity("acme/alpha");
	assert.equal(alpha.tokens, 1300, "tokens summed across days");
	assert.equal(alpha.daysRanked, 2);
	assert.equal(alpha.tokensPerDay, 650);
	assert.equal(alpha.bestRank, 1);
	assert.equal(alpha.globalRank, 1, "busiest model ranks first");
	assert.equal(alpha.share, 1300 / 1900, "window total is alpha 1300 + bravo 600");

	const bravo = pop.getModelPopularity("beta/bravo");
	assert.equal(bravo.tokens, 600);
	assert.equal(bravo.globalRank, 2);
	assert.equal(bravo.share, 600 / 1900);

	assert.deepEqual(pop.getTopPopular(1).map((e) => e.slug), ["acme/alpha"]);

	assert.ok(existsSync(CACHE_FILE), "cache written to disk");
	const written = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
	assert.equal(written.entries.length, 2);
	assert.equal(written.asOf, "2026-01-02T12:00:00Z");
});

test("the built window is used when the API sends no meta dates", async (t) => {
	t.mock.method(globalThis, "fetch", async () => okResponse(ROWS));
	await pop.fetchOpenRouterPopularity(true);
	const status = pop.getPopularityCacheStatus();
	assert.equal(status.windowStart, "2026-01-01");
	assert.equal(status.windowEnd, "2026-01-02");
});

test("an empty data array leaves the existing index alone", async (t) => {
	t.mock.method(globalThis, "fetch", async () => okResponse([]));
	const before = pop.getPopularityRefreshCount();
	await pop.fetchOpenRouterPopularity(true);
	assert.equal(pop.getPopularityRefreshCount(), before, "no data means no refresh");
	assert.equal(pop.getPopularityCacheStatus().count, 2, "previous index kept");
});

// --- freshness ---------------------------------------------------------------

test("a fresh index short-circuits without touching the network", async (t) => {
	const spy = t.mock.method(globalThis, "fetch", async () => okResponse(ROWS));
	const result = await pop.fetchOpenRouterPopularity(false);
	assert.ok(result, "the cached index is returned");
	assert.equal(spy.mock.callCount(), 0, "still inside the TTL");
});

test("ensurePopularityFresh fetches only when stale and reports new data", async (t) => {
	// Force staleness: an index loaded from a 3-day-old cache under a 24h TTL.
	seedCache({ timestamp: Date.now() - 3 * 86400_000, entries: [] });
	await pop.initOpenRouterPopularity();
	assert.equal(pop.isPopularityStale(), true);

	const spy = t.mock.method(globalThis, "fetch", async () => okResponse(ROWS));
	let refreshed = 0;
	pop.ensurePopularityFresh(() => {
		refreshed += 1;
	});
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(spy.mock.callCount(), 1, "stale index triggers a background refresh");
	assert.equal(refreshed, 1, "new data calls the callback");
	assert.equal(pop.isPopularityStale(), false, "the fresh fetch replaced the stale cache");

	// Now fresh: a second call must not fetch again.
	pop.ensurePopularityFresh(() => {
		refreshed += 1;
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(spy.mock.callCount(), 1);
	assert.equal(refreshed, 1);
});

test("a failed refresh does not invoke the callback", async (t) => {
	seedCache({ timestamp: Date.now() - 3 * 86400_000, entries: [] });
	await pop.initOpenRouterPopularity();
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("boom");
	});

	let refreshed = 0;
	pop.ensurePopularityFresh(() => {
		refreshed += 1;
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(refreshed, 0, "no new data, no callback");
	assert.equal(pop.getPopularityLastError(), "boom");
});

test("initOpenRouterPopularity never hits the network", async (t) => {
	const spy = t.mock.method(globalThis, "fetch", async () => okResponse(ROWS));
	await pop.initOpenRouterPopularity();
	assert.equal(spy.mock.callCount(), 0, "extension load must stay offline");
	// Keep cfg referenced so the import is not flagged as unused.
	assert.equal(typeof cfg.reloadConfig, "function");
});
