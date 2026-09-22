import { createRequire } from "node:module";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import { Text, Spacer, fuzzyFilter, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { formatPriceNumber } from "./openrouter.js";
import {
  formatTokens,
  formatShare,
  getPopularityCacheStatus,
  ensurePopularityFresh,
  windowLabel,
} from "./popularity.js";
import {
  cycleSortSpec,
  formatSortSpec,
  getSortSpec,
  resolveModelCost,
  resolvePopularity,
  rowKey,
  sortModelItems,
  type SortableModel,
} from "./ranking.js";
import { getSortKey } from "./config.js";

let isPatched = false;
let activeThemeGetter: (() => any) | null = null;
let fallbackTheme: any = null;
/** Guards the once-per-process popularity kickstart from the selector. */
let popularityKickstarted = false;

/** Human-readable freshness of the popularity cache, for the list header. */
function popularityStatusText(): string {
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

try {
  const req = createRequire(import.meta.url);
  const themeMod = req(
    "/home/jara/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",
  );
  if (themeMod?.theme) {
    fallbackTheme = themeMod.theme;
  }
} catch (err) {
  void err;
}

export function setActiveThemeGetter(getter: () => any) {
  activeThemeGetter = getter;
}

function colorize(colorName: string, text: string): string {
  try {
    const theme =
      (activeThemeGetter ? activeThemeGetter() : null) ?? fallbackTheme;
    if (theme && typeof theme.fg === "function") {
      return theme.fg(colorName, text);
    }
  } catch (err) {
    // Theme not yet initialized or fg method threw; fallback to uncolored text
    void err;
  }
  return text;
}

function formatRowPriceBadge(model: any): string {
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
function formatRowPopularityBadge(model: any): string {
  const popularity = resolvePopularity(model);
  if (!popularity) return "";
  return colorize("warning", ` 🔥#${popularity.globalRank}`);
}

function formatDetailPricingLines(model: any): string[] {
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
function formatDetailPopularityLines(model: any): string[] {
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

export function applyModelSelectorPricingPatch(themeGetter?: () => any): void {
  if (themeGetter) {
    setActiveThemeGetter(themeGetter);
  }

  if (isPatched) {
    return;
  }
  isPatched = true;

  const proto = (ModelSelectorComponent as any).prototype;
  if (!proto) return;

  const originalUpdateList = proto.updateList;
  const originalFilterModels = proto.filterModels;

  let isFirstUpdateList = true;

  // Patch updateList to inject token pricing on each row and detail view
  proto.updateList = function () {
    if (!this.listContainer || !this.filteredModels) {
      return originalUpdateList.call(this);
    }

    // Daily refresh trigger: the selector opening is the "model selection"
    // moment, so kick the ranking fetch here instead of at extension load.
    if (isFirstUpdateList) {
      isFirstUpdateList = false;
      if (!popularityKickstarted) {
        popularityKickstarted = true;
        ensurePopularityFresh((): void => {
          try {
            this.filterModels(this.searchInput.getValue());
          } catch (err) {
            void err;
          }
        });
      }
    }

    this.listContainer.clear();
    this.listContainer.addChild(
      new Text(
        colorize(
          "muted",
          `  sort: ${formatSortSpec(getSortSpec())}  (${getSortKey()} to cycle)  ${popularityStatusText()}`,
        ),
        0,
        0,
      ),
    );
    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        this.filteredModels.length - maxVisible,
      ),
    );
    const endIndex = Math.min(
      startIndex + maxVisible,
      this.filteredModels.length,
    );

    // Show visible slice of filtered models with price badges
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredModels[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const isCurrent = modelsAreEqual(this.currentModel, item.model);
      const isDefault = this.isDefaultModel(item.model);

      const defaultBadge = isDefault ? colorize("muted", " · default") : "";
      const cursor = isSelected ? colorize("accent", "→ ") : "  ";
      const currentMarker = isCurrent ? colorize("accent", "✓ ") : "  ";
      const modelText = isSelected ? colorize("accent", item.id) : item.id;
      const providerBadge = colorize("muted", `[${item.provider}]`);
      const priceBadge = formatRowPriceBadge(item.model);
      const popularityBadge = formatRowPopularityBadge(item.model);

      const line = `${cursor}${currentMarker}${modelText} ${providerBadge} ${priceBadge}${popularityBadge}${defaultBadge}`;
      this.listContainer.addChild(new Text(line, 0, 0));
    }

    // Scroll indicator
    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      const scrollInfo = colorize(
        "muted",
        `  (${this.selectedIndex + 1}/${this.filteredModels.length})`,
      );
      this.listContainer.addChild(new Text(scrollInfo, 0, 0));
    }

    // Error or empty state
    if (this.errorMessage) {
      const errorLines = this.errorMessage.split("\n");
      for (const l of errorLines) {
        this.listContainer.addChild(new Text(colorize("error", l), 0, 0));
      }
    } else if (this.filteredModels.length === 0) {
      this.listContainer.addChild(
        new Text(colorize("muted", "  No matching models"), 0, 0),
      );
    } else {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected?.model) {
        this.listContainer.addChild(new Spacer(1));
        this.listContainer.addChild(
          new Text(
            colorize("muted", `  Model Name: ${selected.model.name}`),
            0,
            0,
          ),
        );

        // Display extended pricing and context info
        const detailLines = [
          ...formatDetailPricingLines(selected.model),
          ...formatDetailPopularityLines(selected.model),
        ];
        for (const dl of detailLines) {
          this.listContainer.addChild(new Text(dl, 0, 0));
        }
      }
    }

    if (this.refreshStatusMessage) {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(
        new Text(
          colorize(
            this.refreshStatusSuccess ? "success" : "muted",
            `  ${this.refreshStatusMessage}`,
          ),
          0,
          0,
        ),
      );
    }
  };

  // Patch filterModels so users can search for "free", "paid", or prices,
  // and so the configured sort spec is applied to the resulting list.
  proto.filterModels = function (query: string) {
    if (!query) {
      // Pi's own filter pass, then our ordering. Sorting must happen here too:
      // the empty-query path is the common case (the picker opening).
      originalFilterModels.call(this, query);
      this.filteredModels = sortModelItems(this.filteredModels, getSortSpec());
      this.updateList();
      return;
    }

    const filtered = fuzzyFilter(this.activeModels, query, (item: any) => {
      const defaultText = this.isDefaultModel(item.model) ? " default" : "";
      const priceInfo = resolveModelCost(item.model);
      const priceSearch = priceInfo.isFree
        ? " free $0 0$"
        : ` paid $${priceInfo.input} $${priceInfo.output}`;

      // Only ranked models carry these tokens, so filtering on "popular" or
      // "hot" narrows the list to models that reached the daily top 50.
      const popularity = resolvePopularity(item.model);
      const popularitySearch = popularity
        ? ` popular hot rank#${popularity.globalRank} ${formatTokens(popularity.tokens)}`
        : "";

      return `${item.id} ${item.provider} ${item.model.name ?? ""}${defaultText} ${priceSearch}${popularitySearch}`;
    });

    if (
      typeof this.isDefaultSearch === "function" &&
      this.isDefaultSearch(query)
    ) {
      const defaultItems = this.activeModels.filter((item: any) =>
        this.isDefaultModel(item.model),
      );
      const defaultKeys = new Set(
        defaultItems.map((item: any) => `${item.provider}\0${item.id}`),
      );
      this.filteredModels = [
        ...defaultItems,
        ...filtered.filter(
          (item: any) => !defaultKeys.has(`${item.provider}\0${item.id}`),
        ),
      ];
    } else {
      this.filteredModels = filtered;
    }

    // Re-order the filtered rows. With the default spec this is a no-op, which
    // preserves Pi's own ordering (including the default-model-first branch).
    this.filteredModels = sortModelItems(this.filteredModels, getSortSpec());

    this.selectedIndex = query
      ? 0
      : Math.min(
          this.selectedIndex,
          Math.max(0, this.filteredModels.length - 1),
        );
    this.updateList();
  };

  const originalHandleInput = proto.handleInput;
  if (typeof originalHandleInput === "function") {
    // Cycle the sort spec without leaving the picker. Registered as a component
    // input interceptor rather than a global shortcut because overlays swallow
    // keys before global shortcuts see them.
    proto.handleInput = function (keyData: string) {
      try {
        // getSortKey() is a user-editable config string, hence the cast; an
        // unparseable key simply never matches instead of throwing.
        if (matchesKey(keyData, getSortKey() as KeyId)) {
          const previous = this.filteredModels?.[this.selectedIndex];
          const previousKey = previous ? rowKey(previous as SortableModel) : null;
          cycleSortSpec();
          this.filterModels(this.searchInput.getValue());
          if (previousKey) {
            const nextIndex = this.filteredModels.findIndex(
              (item: any) => rowKey(item as SortableModel) === previousKey,
            );
            if (nextIndex >= 0) {
              this.selectedIndex = nextIndex;
              this.updateList();
            }
          }
          return;
        }
      } catch (err) {
        // Never let a sort failure swallow the user's keystroke.
        void err;
      }
      return originalHandleInput.call(this, keyData);
    };
  }
}
