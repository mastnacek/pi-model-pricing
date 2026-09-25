/**
 * Rendering helpers for the model-selector patch: theme lookup, colouring and
 * the pricing/popularity badges and detail lines.
 *
 * Split out of `selector-patch.ts`. The theme state lives here because only this
 * module reads it; `selector-patch.ts` hands the getter in via
 * `setActiveThemeGetter` and re-exports it unchanged.
 */
import { formatPriceNumber } from "../openrouter.js";
import { formatShare, formatTokens, getPopularityCacheStatus, windowLabel } from "../popularity.js";
import { resolveModelCost, resolvePopularity } from "../ranking.js";

/**
 * The active theme, supplied by `index.ts` from `ctx.ui.theme` — the documented way
 * for an extension to reach it. Until a session context exists this is null, so
 * `colorize` returns unstyled text, which is what the TUI expects before initTheme().
 */
let activeThemeGetter: (() => any) | null = null;

/** Human-readable freshness of the popularity cache, for the list header. */
export function popularityStatusText(): string {
  const status = getPopularityCacheStatus();
  if (!status.loaded) {
    return status.stale ? "🔥 loading…" : "🔥 unavailable";
  }
  const age =
    status.ageMinutes === null
      ? "unknown age"
      : status.ageMinutes >= 60
        ? `${Math.round(status.ageMinutes / 60)}h old`
        : `${status.ageMinutes}m old`;
  const suffix = status.stale ? " · refreshing…" : "";
  return `🔥 ${status.count} ranked · ${age}${suffix}`;
}

export function setActiveThemeGetter(getter: () => any) {
  activeThemeGetter = getter;
}

export function colorize(colorName: string, text: string): string {
  try {
    const theme = activeThemeGetter ? activeThemeGetter() : null;
    if (theme && typeof theme.fg === "function") {
      return theme.fg(colorName, text);
    }
  } catch (err) {
    // Theme not yet initialized or fg method threw; fallback to uncolored text
    void err;
  }
  return text;
}

export function formatRowPriceBadge(model: any): string {
  const info = resolveModelCost(model);
  if (info.isFree) {
    return colorize("success", " ✨ free");
  }
  const inStr = `$${formatPriceNumber(info.input)}`;
  const outStr = `$${formatPriceNumber(info.output)}`;

  const sep = colorize("dim", " ┊ ");
  const inLabel = colorize("dim", "in ");
  const inPrice = colorize("customMessageLabel", inStr);
  const outLabel = colorize("dim", "out ");
  const outPrice = colorize("warning", outStr);

  return ` ${inLabel}${inPrice}${sep}${outLabel}${outPrice}`;
}


/** Compact rank badge for a model-picker row; empty when the model is not ranked. */
export function formatRowPopularityBadge(model: any): string {
  const popularity = resolvePopularity(model);
  if (!popularity) return "";
  return colorize("warning", ` 🔥#${popularity.globalRank}`);
}


export function formatDetailPricingLines(model: any): string[] {
  const info = resolveModelCost(model);
  const lines: string[] = [];

  if (info.source === "unknown") {
    lines.push(colorize("muted", "  💸 Pricing: Local / Unknown rate"));
  } else if (info.isFree) {
    const srcNote =
      info.source === "openrouter-live" ? " (OpenRouter live)" : "";
    lines.push(
      colorize("success", `  ✨ Pricing: Free ($0.00 / 1M tokens)${srcNote}`),
    );
  } else {
    const inPart = `${colorize("dim", "in ")}${colorize("customMessageLabel", `$${formatPriceNumber(info.input)}/1M`)}`;
    const dot = colorize("dim", " ┊ ");
    const outPart = `${colorize("dim", "out ")}${colorize("warning", `$${formatPriceNumber(info.output)}/1M`)}`;
    let text = `  💸 Pricing: ${inPart}${dot}${outPart}`;

    if (info.cacheRead || info.cacheWrite) {
      const readVal = colorize(
        "customMessageLabel",
        `$${formatPriceNumber(info.cacheRead || 0)}/1M`,
      );
      const writeVal = colorize(
        "warning",
        `$${formatPriceNumber(info.cacheWrite || 0)}/1M`,
      );
      text += ` ${colorize("dim", "(cache r:")} ${readVal} ${colorize("dim", "w:")} ${writeVal}${colorize("dim", ")")}`;
    }
    if (info.source === "openrouter-live") {
      text += ` ${colorize("dim", "┊ live OpenRouter")}`;
    }
    lines.push(text);
  }

  if (model.contextWindow) {
    lines.push(
      colorize(
        "muted",
        `  🧠 Context: ${model.contextWindow.toLocaleString()} tokens`,
      ),
    );
  }

  return lines;
}


/**
 * Popularity detail lines. Rendered only when the rankings index is available,
 * because an absent row means "never reached the daily top 50", not "unused".
 */
export function formatDetailPopularityLines(model: any): string[] {
  const status = getPopularityCacheStatus();
  if (!status.loaded) return [];

  const window = windowLabel(status);
  const popularity = resolvePopularity(model);

  if (!popularity) {
    return [
      colorize(
        "muted",
        `  📈 Popularity: outside the top-50 daily ranking (${window})`,
      ),
    ];
  }

  const rank = colorize(
    "warning",
    `#${popularity.globalRank} of ${status.count}`,
  );
  const tokens = colorize(
    "customMessageLabel",
    `${formatTokens(popularity.tokens)} tokens`,
  );
  const share = colorize("dim", `${formatShare(popularity.share)} of ranked traffic`);
  const best = colorize("dim", `best daily rank #${popularity.bestRank}`);
  const days = colorize("dim", `${popularity.daysRanked} day(s) ranked`);

  return [
    `  📈 Popularity: ${rank} ┊ ${tokens} (${window}) ┊ ${share}`,
    `     ${best} ┊ ${days} ┊ ${colorize("dim", "Source: openrouter.ai/rankings")}`,
  ];
}
