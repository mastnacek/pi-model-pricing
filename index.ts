import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  initOpenRouterPricing,
  fetchLiveOpenRouterModels,
  getPricingCacheStatus,
  formatPriceNumber,
} from "./openrouter.js";
import {
  applyModelSelectorPricingPatch,
  setActiveThemeGetter,
} from "./selector-patch.js";

/**
 * First-level subcommand documentation. Drives both the lazy autocompletion
 * (AGENTS.md §4) and the help banner. `<keyword>` is free-form and therefore
 * intentionally omitted.
 */
const COMMAND_DOCS: Record<string, string> = {
  refresh: "force a live reload of model pricing from the OpenRouter API",
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
  return [
    "pi-model-pricing — Live OpenRouter token pricing",
    "",
    "Commands:",
    "  /model-pricing                 — show cache status and model count",
    "  /model-pricing refresh         — force a live reload from the OpenRouter API",
    "  /model-pricing <keyword>       — search models and compare input/output prices",
    "  /model-pricing help            — show this help",
    "",
    "Model selector: /model (or Ctrl+P) shows live price badges.",
    `Cache: ${status.count} models, updated ${status.timestamp ? new Date(status.timestamp).toLocaleTimeString() : "never"} (${ageStr}).`,
  ].join("\n");
}

export default function (pi: ExtensionAPI): void {
  let activeContext: ExtensionContext | null = null;

  // Track active theme for native styling in the model selector
  setActiveThemeGetter(() => activeContext?.ui?.theme);

  // Initialize live pricing loader (loads disk cache immediately, refreshes in background)
  void initOpenRouterPricing();

  // Apply the patch to ModelSelectorComponent so /model and Ctrl+P show live pricing
  applyModelSelectorPricingPatch();

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

      // Only the first token is completable; `<keyword>` is free-form.
      if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
        return null;
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
      const sub = (trimmed.split(/\s+/)[0] ?? "").toLowerCase();

      if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
        notify(ctx, helpText(), "info");
        return;
      }

      if (sub === "refresh") {
        notify(ctx, "Fetching live pricing from OpenRouter API...", "info");
        try {
          const models = await fetchLiveOpenRouterModels(true);
          const count = Object.keys(models).length;
          notify(
            ctx,
            `Updated ${count} models from OpenRouter live API!`,
            "info",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notify(ctx, `Failed to refresh: ${msg}`, "error");
        }
        return;
      }

      const status = getPricingCacheStatus();
      // Query search — the whole argument is treated as the keyword.
      const models = await fetchLiveOpenRouterModels(false);
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