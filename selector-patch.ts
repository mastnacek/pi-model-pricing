import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import { Text, Spacer, fuzzyFilter, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { ensurePopularityFresh, formatTokens } from "./popularity.js";
import {
  cycleSortSpec,
  formatSortSpec,
  getSortSpec,
  resolveModelCost,
  resolvePopularity,
  sortModelItems,
} from "./ranking.js";
import { getSortKey } from "./config.js";
import {
  colorize,
  formatDetailPopularityLines,
  formatDetailPricingLines,
  formatRowPopularityBadge,
  formatRowPriceBadge,
  popularityStatusText,
  setActiveThemeGetter,
} from "./src/selector-render.js";

// Re-exported so existing importers keep working unchanged.
export { setActiveThemeGetter } from "./src/selector-render.js";

let isPatched = false;
/** Guards the once-per-process popularity kickstart from the selector. */
let popularityKickstarted = false;

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
          cycleSortSpec();
          this.filterModels(this.searchInput.getValue());
          // Re-ordering invalidates whatever position the cursor held: keeping
          // it would scroll the viewport into the middle of the new order (and
          // after a change of key the highlighted row means nothing anyway).
          // Jump back to the first row so the new ranking is read from the top.
          this.selectedIndex = 0;
          this.updateList();
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
