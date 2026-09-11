import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  initOpenRouterPricing,
  fetchLiveOpenRouterModels,
  getPricingCacheStatus,
  formatPriceNumber,
} from "./openrouter.js";
import { applyModelSelectorPricingPatch, setActiveThemeGetter } from "./selector-patch.js";

export default function (pi: ExtensionAPI) {
  let activeContext: ExtensionContext | null = null;

  // Track active theme for native styling in the model selector
  setActiveThemeGetter(() => activeContext?.ui?.theme);

  // Initialize live pricing loader (loads disk cache immediately, refreshes in background)
  void initOpenRouterPricing();

  // Apply the patch to ModelSelectorComponent so /model and Ctrl+P show live pricing
  applyModelSelectorPricingPatch();

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    setActiveThemeGetter(() => ctx.ui?.theme);
  });

  // Register command /model-pricing
  pi.registerCommand("model-pricing", {
    description: "Inspect live model pricing from OpenRouter API (/model-pricing [refresh | <query>])",
    handler: async (args: string, ctx: ExtensionContext) => {
      activeContext = ctx;
      const sub = (args || "").trim();

      if (sub === "refresh") {
        ctx.ui.notify("Fetching live pricing from OpenRouter API...", "info");
        try {
          const models = await fetchLiveOpenRouterModels(true);
          const count = Object.keys(models).length;
          ctx.ui.notify(`Updated ${count} models from OpenRouter live API!`, "info");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Failed to refresh: ${msg}`, "error");
        }
        return;
      }

      const status = getPricingCacheStatus();
      if (sub.length > 0) {
        // Query search
        const models = await fetchLiveOpenRouterModels(false);
        const lower = sub.toLowerCase();
        const matches = Object.values(models).filter(
          (m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower)
        );

        if (matches.length === 0) {
          ctx.ui.notify(`No OpenRouter models found matching "${sub}"`, "warning");
          return;
        }

        const lines = [
          `Found ${matches.length} models for "${sub}" (OpenRouter live pricing):`,
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

        if (ctx.ui?.editor) {
          await ctx.ui.editor("OpenRouter Model Pricing", lines.join("\n"));
        } else {
          for (const l of lines) {
            ctx.ui.notify(l, "info");
          }
        }
        return;
      }

      // Status overview
      const ageStr = status.ageMinutes === null ? "unknown" : `${status.ageMinutes}m ago`;
      const infoMsg = [
        `OpenRouter Live Pricing Status:`,
        `• Models indexed: ${status.count}`,
        `• Cache updated: ${status.timestamp ? new Date(status.timestamp).toLocaleTimeString() : "never"} (${ageStr})`,
        `• Source: https://openrouter.ai/api/v1/models (never hardcoded)`,
        "",
        `Commands:`,
        `• /model-pricing refresh     - Force live reload from OpenRouter API`,
        `• /model-pricing <keyword>   - Search models and compare pricing`,
        `• /model (or Ctrl+P)         - Built-in selector with live price badges`,
      ].join("\n");

      if (ctx.ui?.editor) {
        await ctx.ui.editor("OpenRouter Pricing Status", infoMsg);
      } else {
        ctx.ui.notify(infoMsg, "info");
      }
    },
  });
}
