/**
 * `/model-pricing` command documentation, UI notify helper and help banner.
 * Extracted from index.ts so the composition root stays under the file limit.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH, getSortKey } from "../config.js";
import { getPricingCacheStatus } from "../openrouter.js";
import {
  getPopularityCacheStatus,
  getPopularityLastError,
  windowLabel,
} from "../popularity.js";
import { formatSortSpec, getSortSpec, isDefaultSort } from "../ranking.js";

/**
 * First-level subcommand documentation. Drives both the lazy autocompletion
 * (AGENTS.md §4) and the help banner. `<keyword>` is free-form and therefore
 * intentionally omitted.
 */
export const COMMAND_DOCS: Record<string, string> = {
  "--global": "save the following setting globally (~/.pi/agent/)",
  refresh: "force a live reload of pricing and popularity from the OpenRouter API",
  popular: "rank models by real OpenRouter token usage (top 50/day dataset)",
  sort: "change the model-picker ordering (provider | source | rating | price)",
  help: "show this help and the current cache status",
};

export function notify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
  } else {
    console.log(message);
  }
}

export function helpText(): string {
  const status = getPricingCacheStatus();
  const ageStr =
    status.ageMinutes === null ? "unknown" : `${status.ageMinutes}m ago`;
  const popularity = getPopularityCacheStatus();
  const popularityAge =
    popularity.ageMinutes === null ? "never" : `${popularity.ageMinutes}m ago`;
  const populationStatus = popularity.loaded
    ? `Popularity: ${popularity.count} ranked models, window ${windowLabel(popularity)} (${popularity.windowStart} → ${popularity.windowEnd}), fetched ${popularityAge}, TTL ${popularity.ttlHours}h${popularity.stale ? " (stale — refreshes on next picker open)" : ""}.`
    : `Popularity: unavailable${getPopularityLastError() ? ` (${getPopularityLastError()})` : " — needs an OpenRouter API key"}.`;
  const kind = isDefaultSort() ? "default" : "custom";
  return [
    "pi-model-pricing — Live OpenRouter token pricing + popularity",
    "",
    "Commands:",
    "  /model-pricing                 — show cache status and model count",
    "  /model-pricing refresh         — force a live reload from the OpenRouter API",
    "  /model-pricing popular [n]     — top n models by real token usage (default 15)",
    "  /model-pricing sort [spec]     — show, set or cycle the picker ordering",
    "  /model-pricing <keyword>       — search models and compare input/output prices",
    "  /model-pricing help            — show this help",
    "",
    "Ranking keys (comma-separate, prefix - for descending):",
    "  rating    most used first (OpenRouter token volume)",
    "  price     cheapest input rate first",
    "  provider  group by Pi provider (openrouter, openrouter-work, …)",
    "  source    live OpenRouter data before registry fallback",
    "  context   smallest context window first   ·  name  A→Z",
    "  examples: rating · -price · provider,price · source,rating",
    "Model selector: /model (or Ctrl+P) shows live price and 🔥 popularity badges.",
    `Sorting: ${formatSortSpec(getSortSpec())} (${kind}) — press ${getSortKey()} inside the picker to cycle.`,
    `Config: ${CONFIG_PATH}`,
    `Pricing: ${status.count} models, updated ${status.timestamp ? new Date(status.timestamp).toLocaleTimeString() : "never"} (${ageStr}).`,
    populationStatus,
    "Popularity source: https://openrouter.ai/rankings (CC BY 4.0).",
    "",
    "Add `--global` to `sort` to persist into ~/.pi/agent/pi-model-pricing.json",
    "(all sessions); without it the setting goes to <cwd>/.pi/pi-model-pricing.json.",
  ].join("\n");
}
