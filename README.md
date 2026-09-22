# pi-model-pricing

Live model **token pricing + popularity** extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

Fetches up-to-date rates from the OpenRouter API (never hardcoded), joins them with OpenRouter's real token-usage rankings, and displays both inside Pi's native model selector (`/model` / `Ctrl+P`) and via `/model-pricing`.

---

## Features

- **Never hardcoded**: live rates from `https://openrouter.ai/api/v1/models` and live usage from `https://openrouter.ai/api/v1/datasets/rankings-daily`.
- **Persistent local caches** in `~/.pi/agent/cache/` with TTLs (1 h pricing, 6 h popularity).
- **Native `/model` & `Ctrl+P` enhancement**:
  - **Inline badges on every row**:
    - `→ anthropic/claude-sonnet-4.5 [openrouter] [in:$3/out:$15] 🔥#4 · default`
    - `cohere/north-mini-code:free [openrouter] ✨ free 🔥#22`
  - **Rich detail panel**:
    - Exact rates: `$X.XX/1M in · $Y.XX/1M out`
    - Cache rates: `cache r: $Z/1M w: $W/1M`
    - Popularity: `📈 Popularity: #3 of 80 ┊ 48.88T tokens (30d) ┊ 10.0% of ranked traffic`
    - `best daily rank #1 ┊ 27 day(s) ranked`
    - Context window and live source indicator
  - **Search & filter**:
    - `free` / `$0` → free models; `paid` → paid models; numbers → price match
    - `popular` / `hot` → only models that reached OpenRouter's daily top 50
- **Dedicated command `/model-pricing`**:
  - `/model-pricing` — cache status: pricing model count and popularity window
  - `/model-pricing refresh` — force a live reload of both datasets
  - `/model-pricing popular [n]` — top `n` models by real token usage (default 15)
  - `/model-pricing <query>` — search models with prices **and** popularity rank
  - `/model-pricing help` — usage reference

---

## Popularity data — what it is and what it is not

Source: `GET /api/v1/datasets/rankings-daily`, the same dataset behind <https://openrouter.ai/rankings>.

- The endpoint returns the **top 50 public models per day** by total tokens (`prompt_tokens + completion_tokens`), plus one aggregated `other` row that is ignored. Default window: the last 30 completed UTC days.
- Requires a **valid OpenRouter API key** — the same key used for inference. Resolution order: `OPENROUTER_API_KEY`, then `auth.json`. Both `apiKey`, `key` and OAuth-minted `access` credential shapes are supported, so keys created by `/login` or by `pi-openrouter-accounts` work.
- Rate limits: 30 requests/min and 500/day per account. This extension caches for 6 h, so normal use is far below the budget. A `429`/`401` keeps the previous index rather than blanking the UI; run `/model-pricing help` to see the last error.
- Joined to catalog models by `canonical_slug` (+ `:variant`), because the dataset keys rows on canonical permaslugs while the catalog exposes dated `canonical_slug` fields. A date-stripped fallback join exists for rows that only differ by revision date.
- **Absence means "not in the top 50", not "unused".** A model with no popularity row shows `outside the top-50 daily ranking` instead of a misleading `#0`. With a 30-day window roughly 80 of ~440 catalog models qualify.
- A variant without its own dataset row (e.g. `:batch`) inherits its base model's popularity; `:free` variants are ranked separately by OpenRouter and matched exactly.
- `globalRank` is computed by sorting matched models by total tokens inside the window; `share` is that model's fraction of ranked traffic.

**Attribution (CC BY 4.0 — required when republishing this data):**

> Source: OpenRouter (openrouter.ai/rankings), as of {`meta.as_of`}. Licensed under CC BY 4.0.

The extension prints this line with `/model-pricing popular`; the detail panel shows the short `Source: openrouter.ai/rankings` form.

---

## Installation

### Option 1: Global Pi Extension (Local)

Place a symlink in your Pi extensions directory:

```bash
ln -s /path/to/pi-model-pricing ~/.pi/agent/extensions/pi-model-pricing
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/path/to/pi-model-pricing/index.ts"
  ]
}
```

### Option 2: Git Package

```json
{
  "packages": [
    "git:github.com/mastnacek/pi-model-pricing"
  ]
}
```

---

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | extension entry point, `/model-pricing` command |
| `openrouter.ts` | live pricing fetch, disk cache, slug → price lookup |
| `popularity.ts` | rankings-daily fetch, aggregation, matching, formatting |
| `selector-patch.ts` | patches `ModelSelectorComponent` rows, detail panel and filters |

## Caveats

- The selector patch monkey-patches `ModelSelectorComponent.prototype`. A Pi release that renames `updateList` / `filterModels` silently disables the badges (no crash) — re-check after engine upgrades.
- Popularity needs an API key; without one pricing badges still work and popularity is simply absent.
- Token counts come from each upstream provider's own tokenizer, so cross-model comparisons are approximate.

---

## License

MIT © [mastnacek](https://github.com/mastnacek)

Rankings data © OpenRouter, licensed CC BY 4.0; attributed in the UI and in `/model-pricing popular`.