import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  initOpenRouterPricing,
  fetchLiveOpenRouterModels,
  getLiveModelPriceByCanonicalSlug,
  getPricingCacheStatus,
  formatPriceNumber,
} from "./openrouter.js";
import {
  initOpenRouterPopularity,
  fetchOpenRouterPopularity,
  getPopularityCacheStatus,
  getPopularityLastError,
  getTopPopular,
  getModelPopularity,
  popularityAttribution,
  formatTokens,
  formatShare,
  windowLabel,
} from "./popularity.js";
import {
  applyModelSelectorPricingPatch,
  setActiveThemeGetter,
} from "./selector-patch.js";
import {
  SORT_PRESETS,
  cycleSortSpec,
  formatSortSpec,
  getSortSpec,
  isDefaultSort,
  setSortSpec,
} from "./ranking.js";
import { CONFIG_PATH, getSortKey } from "./config.js";

/**
 * First-level subcommand documentation. Drives both the lazy autocompletion
 * (AGENTS.md §4) and the help banner. `<keyword>` is free-form and therefore
 * intentionally omitted.
 */
const COMMAND_DOCS: Record<string, string> = {
  refresh: "force a live reload of pricing and popularity from the OpenRouter API",
  popular: "rank models by real OpenRouter token usage (top 50/day dataset)",
  sort: "change the model-picker ordering (provider | source | rating | price)",
  help: "show this help and the current cache status",
};

function notify(
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

function helpText(): string {
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
  ].join("\n");
}

export default function (pi: ExtensionAPI): void {
  let activeContext: ExtensionContext | null = null;

  // Track active theme for native styling in the model selector
  setActiveThemeGetter(() => activeContext?.ui?.theme);

  // Initialize live pricing loader (loads disk cache immediately, refreshes in background)
  void initOpenRouterPricing();

  // Initialize OpenRouter popularity (token-volume rankings; key-gated)
  void initOpenRouterPopularity();

  // Apply the patch to ModelSelectorComponent so /model and Ctrl+P show live pricing
  applyModelSelectorPricingPatch();

  // Global shortcut mirrors the in-picker key, so the ordering can be changed
  // without opening the selector. Overlays swallow keys, so the selector needs
  // its own interceptor (see selector-patch.ts).
  try {
    pi.registerShortcut(getSortKey() as never, {
      description: "Cycle pi-model-pricing model ranking",
      handler: async (ctx: ExtensionContext) => {
        const applied = cycleSortSpec();
        notify(
          ctx,
          `Model ranking: ${formatSortSpec(applied)}${
            isDefaultSort(applied) ? " (Pi's own order)" : ""
          }`,
          "info",
        );
      },
    });
  } catch (err) {
    // A conflicting or malformed key must not break extension loading.
    console.error("[pi-model-pricing] Could not register sort shortcut:", err);
  }

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    activeContext = ctx;
    setActiveThemeGetter(() => ctx.ui?.theme);
  });

  // Drop the captured context on shutdown so no stale UI/theme handle survives
  // a session replacement (AGENTS.md §5/§6).
  pi.on("session_shutdown", () => {
    activeContext = null;
    setActiveThemeGetter(() => undefined);
  });

  // Register command /model-pricing
  pi.registerCommand("model-pricing", {
    description:
      "Inspect live model pricing from OpenRouter API (/model-pricing [refresh | help | <query>])",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const tokens = prefix.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(prefix);

      // Second level: `/model-pricing sort <spec>`.
      if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
        const first = (tokens[0] ?? "").toLowerCase();
        if (first !== "sort") return null;
        const typed = tokens.slice(1).join(" ").toLowerCase();
        const items = SORT_PRESETS.filter((preset) =>
          preset.value.toLowerCase().startsWith(typed),
        ).map((preset) => ({
          value: `sort ${preset.value}`,
          label: `sort ${preset.label}`,
          description: preset.description,
        }));
        return items.length > 0 ? items : null;
      }

      const typed = (tokens[0] ?? "").toLowerCase();
      const items = Object.entries(COMMAND_DOCS)
        .filter(([key]) => key.toLowerCase().startsWith(typed))
        .map(([value, description]) => ({ value, label: value, description }));

      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      activeContext = ctx;
      const trimmed = (args || "").trim();
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? "").toLowerCase();
      const rest = tokens.slice(1);

      if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
        notify(ctx, helpText(), "info");
        return;
      }

      if (sub === "refresh") {
        notify(ctx, "Fetching live pricing + popularity from OpenRouter API...", "info");
        try {
          const models = await fetchLiveOpenRouterModels(true);
          const count = Object.keys(models).length;
          await fetchOpenRouterPopularity(true);
          const popularity = getPopularityCacheStatus();
          const popularityLine = popularity.loaded
            ? `Popularity: ${popularity.count} ranked models (${windowLabel(popularity)}, ${popularity.windowStart} → ${popularity.windowEnd})`
            : `Popularity: unavailable${getPopularityLastError() ? ` (${getPopularityLastError()})` : ""}`;
          notify(
            ctx,
            `Updated ${count} models from OpenRouter live API!\n${popularityLine}`,
            "info",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notify(ctx, `Failed to refresh: ${msg}`, "error");
        }
        return;
      }

      if (sub === "sort") {
        // No argument → show current spec; "cycle"/"next" → advance presets;
        // anything else is parsed as a sort spec (unknown keys are dropped).
        const requested = rest.join(" ").trim();
        let applied: string;
        if (!requested) {
          const spec = getSortSpec();
          notify(
            ctx,
            [
              `Sort: ${formatSortSpec(spec)}${isDefaultSort(spec) ? " (Pi's own order)" : ""}`,
              `Key in picker: ${getSortKey()} — press it to cycle.`,
              "",
              "Modes:",
              ...SORT_PRESETS.map((p) => `  ${p.label.padEnd(16)} ${p.description}`),
              "",
              "Composite specs work too: provider,price · source,rating · -rating",
            ].join("\n"),
            "info",
          );
          return;
        }
        if (requested === "cycle" || requested === "next") {
          applied = cycleSortSpec();
        } else {
          applied = setSortSpec(requested);
        }
        notify(
          ctx,
          `Model ranking: ${formatSortSpec(applied)}${
            isDefaultSort(applied) ? " (Pi's own order)" : ""
          }\nApplies to the next /model open (press ${getSortKey()} there to cycle).`,
          "info",
        );
        return;
      }

      if (sub === "popular" || sub === "popularity" || sub === "top") {
        // Ensure the price catalog is loaded so each row can carry a rate.
        await fetchLiveOpenRouterModels(false);
        await fetchOpenRouterPopularity(false);
        const status = getPopularityCacheStatus();
        if (!status.loaded) {
          notify(
            ctx,
            `Popularity data unavailable${getPopularityLastError() ? `: ${getPopularityLastError()}` : ". The rankings dataset requires an OpenRouter API key (OPENROUTER_API_KEY or auth.json)."}`,
            "warning",
          );
          return;
        }
        const requested = Number.parseInt(rest[0] ?? "", 10);
        const limit = Number.isFinite(requested) && requested > 0 ? requested : 15;
        const top = getTopPopular(limit);
        const window = windowLabel(status);
        const lines = [
          `Top ${top.length} models by OpenRouter token usage (${window}: ${status.windowStart} → ${status.windowEnd})`,
          "",
        ];
        for (const entry of top) {
          // Popularity rows are keyed on canonical permaslugs, not catalog ids.
          const price = getLiveModelPriceByCanonicalSlug(entry.slug);
          const priceText = price
            ? price.isFree
              ? "free"
              : `$${formatPriceNumber(price.cost.input)}/$${formatPriceNumber(price.cost.output)} per 1M`
            : "price not in catalog";
          lines.push(
            `#${entry.globalRank}  ${entry.slug}`,
            `    ${formatTokens(entry.tokens)} tokens (${window}) · ${formatShare(entry.share)} of ranked traffic · ${priceText}`,
          );
        }
        lines.push("", popularityAttribution(status));
        if (ctx.hasUI && ctx.ui?.editor) {
          await ctx.ui.editor("OpenRouter Popularity", lines.join("\n"));
        } else if (ctx.hasUI) {
          ctx.ui.notify(lines.join("\n"), "info");
        } else {
          console.log(lines.join("\n"));
        }
        return;
      }

      const status = getPricingCacheStatus();
      const popularityStatus = getPopularityCacheStatus();
      // Query search — the whole argument is treated as the keyword.
      const models = await fetchLiveOpenRouterModels(false);
      await fetchOpenRouterPopularity(false);
      const lower = trimmed.toLowerCase();
      const matches = Object.values(models).filter(
        (m) =>
          m.id.toLowerCase().includes(lower) ||
          m.name.toLowerCase().includes(lower),
      );

      if (matches.length === 0) {
        notify(ctx, `No OpenRouter models found matching "${trimmed}"`, "warning");
        return;
      }

      const lines = [
        `Found ${matches.length} models for "${trimmed}" (OpenRouter live pricing):`,
        "",
      ];
      for (const m of matches.slice(0, 25)) {
        const freeTag = m.isFree ? " [FREE]" : "";
        const inP = `$${formatPriceNumber(m.cost.input)}/1M in`;
        const outP = `$${formatPriceNumber(m.cost.output)}/1M out`;
        lines.push(`• ${m.id}${freeTag}`);
        lines.push(`  ${m.name} | ${inP} | ${outP}`);
        if (popularityStatus.loaded) {
          const popularity = getModelPopularity(m.id, m.canonicalSlug);
          lines.push(
            popularity
              ? `  🔥 #${popularity.globalRank} of ${popularityStatus.count} · ${formatTokens(popularity.tokens)} tokens (${windowLabel(popularityStatus)}) · ${formatShare(popularity.share)} of ranked traffic`
              : `  🔥 not in the top-50 daily ranking (${windowLabel(popularityStatus)})`,
          );
        }
      }
      if (matches.length > 25) {
        lines.push(`  ...and ${matches.length - 25} more`);
      }

      if (ctx.hasUI && ctx.ui?.editor) {
        await ctx.ui.editor("OpenRouter Model Pricing", lines.join("\n"));
      } else if (ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        console.log(lines.join("\n"));
      }

      // Status reminder (only in the non-search default path was it shown before;
      // keep parity by surfacing cache age with the results header in UI mode).
      if (ctx.hasUI && status.ageMinutes !== null && status.ageMinutes > 60) {
        notify(
          ctx,
          `Pricing cache is ${status.ageMinutes}m old — run /model-pricing refresh.`,
          "warning",
        );
      }
    },
  });
}