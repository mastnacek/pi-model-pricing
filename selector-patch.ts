import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import { Text, Spacer, fuzzyFilter } from "@earendil-works/pi-tui";
import { getLiveModelPrice, formatPriceNumber } from "./openrouter.js";

let isPatched = false;
let activeThemeGetter: (() => any) | null = null;

export function setActiveThemeGetter(getter: () => any) {
  activeThemeGetter = getter;
}

function colorize(colorName: string, text: string): string {
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

function resolveModelCost(model: any): {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  isFree: boolean;
  source: "openrouter-live" | "builtin-registry" | "unknown";
} {
  // 1. Check live OpenRouter pricing first (always priority for fresh live data)
  const live = getLiveModelPrice(model.id, model.provider);
  if (live) {
    // Keep model's internal cost property in sync with live OpenRouter rates
    if (!model.cost || model.provider === "openrouter") {
      model.cost = { ...live.cost };
    }
    return {
      input: live.cost.input,
      output: live.cost.output,
      cacheRead: live.cost.cacheRead,
      cacheWrite: live.cost.cacheWrite,
      isFree: live.isFree,
      source: "openrouter-live",
    };
  }

  // 2. Fallback to model's registered cost if available
  if (model.cost && (typeof model.cost.input === "number" || typeof model.cost.output === "number")) {
    const isFree = (model.cost.input ?? 0) === 0 && (model.cost.output ?? 0) === 0;
    return {
      input: model.cost.input ?? 0,
      output: model.cost.output ?? 0,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
      isFree,
      source: "builtin-registry",
    };
  }

  return {
    input: 0,
    output: 0,
    isFree: true,
    source: "unknown",
  };
}

function formatRowPriceBadge(model: any): string {
  const info = resolveModelCost(model);
  if (info.isFree) {
    return colorize("success", "[free]");
  }
  const inStr = `$${formatPriceNumber(info.input)}`;
  const outStr = `$${formatPriceNumber(info.output)}`;
  return colorize("dim", `[in:${inStr}/out:${outStr}]`);
}

function formatDetailPricingLines(model: any): string[] {
  const info = resolveModelCost(model);
  const lines: string[] = [];

  if (info.source === "unknown") {
    lines.push(colorize("muted", "  Pricing: Local / Unknown rate"));
  } else if (info.isFree) {
    const srcNote = info.source === "openrouter-live" ? " (OpenRouter live)" : "";
    lines.push(colorize("success", `  Pricing: Free ($0.00 / 1M tokens)${srcNote}`));
  } else {
    let text = `  Pricing: $${formatPriceNumber(info.input)}/1M in · $${formatPriceNumber(info.output)}/1M out`;
    if (info.cacheRead || info.cacheWrite) {
      text += ` (Cache: $${formatPriceNumber(info.cacheRead || 0)} read / $${formatPriceNumber(info.cacheWrite || 0)} write)`;
    }
    if (info.source === "openrouter-live") {
      text += colorize("dim", " · live OpenRouter");
    }
    lines.push(colorize("muted", text));
  }

  if (model.contextWindow) {
    lines.push(colorize("muted", `  Context: ${model.contextWindow.toLocaleString()} tokens`));
  }

  return lines;
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

  // Patch updateList to inject token pricing on each row and detail view
  proto.updateList = function () {
    if (!this.listContainer || !this.filteredModels) {
      return originalUpdateList.call(this);
    }

    this.listContainer.clear();
    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible)
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

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

      const line = `${cursor}${currentMarker}${modelText} ${providerBadge} ${priceBadge}${defaultBadge}`;
      this.listContainer.addChild(new Text(line, 0, 0));
    }

    // Scroll indicator
    if (startIndex > 0 || endIndex < this.filteredModels.length) {
      const scrollInfo = colorize("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
      this.listContainer.addChild(new Text(scrollInfo, 0, 0));
    }

    // Error or empty state
    if (this.errorMessage) {
      const errorLines = this.errorMessage.split("\n");
      for (const l of errorLines) {
        this.listContainer.addChild(new Text(colorize("error", l), 0, 0));
      }
    } else if (this.filteredModels.length === 0) {
      this.listContainer.addChild(new Text(colorize("muted", "  No matching models"), 0, 0));
    } else {
      const selected = this.filteredModels[this.selectedIndex];
      if (selected?.model) {
        this.listContainer.addChild(new Spacer(1));
        this.listContainer.addChild(new Text(colorize("muted", `  Model Name: ${selected.model.name}`), 0, 0));

        // Display extended pricing and context info
        const detailLines = formatDetailPricingLines(selected.model);
        for (const dl of detailLines) {
          this.listContainer.addChild(new Text(dl, 0, 0));
        }
      }
    }

    if (this.refreshStatusMessage) {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(
        new Text(colorize(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0)
      );
    }
  };

  // Patch filterModels so users can search for "free", "paid", or prices
  proto.filterModels = function (query: string) {
    if (!query) {
      return originalFilterModels.call(this, query);
    }

    const filtered = fuzzyFilter(this.activeModels, query, (item: any) => {
      const defaultText = this.isDefaultModel(item.model) ? " default" : "";
      const priceInfo = resolveModelCost(item.model);
      const priceSearch = priceInfo.isFree
        ? " free $0 0$"
        : ` paid $${priceInfo.input} $${priceInfo.output}`;

      return `${item.id} ${item.provider} ${item.model.name ?? ""}${defaultText} ${priceSearch}`;
    });

    if (typeof this.isDefaultSearch === "function" && this.isDefaultSearch(query)) {
      const defaultItems = this.activeModels.filter((item: any) => this.isDefaultModel(item.model));
      const defaultKeys = new Set(defaultItems.map((item: any) => `${item.provider}\0${item.id}`));
      this.filteredModels = [
        ...defaultItems,
        ...filtered.filter((item: any) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
      ];
    } else {
      this.filteredModels = filtered;
    }

    this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
    this.updateList();
  };
}
