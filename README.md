# pi-model-pricing

Live model **token pricing + popularity** extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

Fetches live rates from the OpenRouter API (never hardcoded), joins them with OpenRouter's real token-usage rankings, and renders both inside Pi's native model selector (`/model` / `Ctrl+P`) — with configurable **ranking** by provider, source, rating or price.

---

## Features

- **Never hardcoded.** Prices come from `https://openrouter.ai/api/v1/models`; popularity from `https://openrouter.ai/api/v1/datasets/rankings-daily`.
- **Once-a-day popularity load.** The ranking cache is read from disk at startup with no network call, and refreshed in the background the first time the model picker opens once the cache is older than 24 h (`popularityTtlHours`, configurable). Prices keep a shorter 1 h TTL (`pricingTtlHours`).
- **Configurable ranking** by `provider`, `source`, `rating`, `price` (+ `context`, `name`), composable and directional, changeable with a keystroke inside the picker.
- **Native `/model` & `Ctrl+P` enhancement**:
  - **Inline badges per row**: `→ z-ai/glm-5.3-flash [openrouter] in $0.15 ┊ out $0.5 🔥#3 · default`
  - **Detail panel**: exact rates, cache rates, `📈 Popularity: #3 of 80 ┊ 48.88T tokens (30d) ┊ 10.0% of ranked traffic`, `best daily rank #1 ┊ 27 day(s) ranked`, context window
  - **Search & filter**: `free` / `$0`, `paid`, price numbers, and `popular` / `hot` for models that reached the daily top 50
  - **Sort header**: `sort: rating ↑  (alt+s to cycle)  🔥 80 ranked · 3h old`
- **Dedicated command `/model-pricing`**: status, `refresh`, `popular [n]`, `sort [spec]`, keyword search, `help`.

---

## When data is loaded

| Dataset | Source | TTL | Trigger |
| --- | --- | --- | --- |
| Pricing | `/api/v1/models` | 1 h | extension load (cache), then lazily on use |
| Popularity | `/api/v1/datasets/rankings-daily` | **24 h** | cache read at startup; **network refresh on first model-picker open when stale** |

Both are cached under `$PI_CODING_AGENT_DIR/cache/` (default `~/.pi/agent/cache/`) and survive restarts. A stale cache is still rendered immediately — the refresh happens in the background and the list re-renders when new data lands. `/model-pricing refresh` forces both immediately.

---

## Ranking / sorting

Press **`alt+s`** inside the model picker to cycle through presets. The current spec is shown in the picker header and persisted to the config file, so it survives restarts.

```text
/model-pricing sort                 show current spec + all modes
/model-pricing sort rating          most used first
/model-pricing sort -price          most expensive first
/model-pricing sort provider,price  group by provider, cheapest first
/model-pricing sort cycle           advance to the next preset
```

### Sort keys

Any key can be prefixed with `-` for descending. Unknown keys are ignored, so a stale config never breaks the picker.

| Key | Meaning |
| --- | --- |
| `rating` | OpenRouter popularity rank — most used first. **Unranked models always sort last**, in both directions, so "descending" cannot promote models we have no usage data for |
| `price` | cheapest input rate first, output rate breaks ties |
| `provider` | group by Pi provider id (`openrouter`, `openrouter-work`, …) |
| `source` | models with authoritative live OpenRouter data before registry fallback |
| `context` | smallest context window first |
| `name` | model name, A→Z |
| `default` | Pi's own ordering (no re-sorting) |

Compose freely: `provider,price` · `source,rating` · `-rating,price`. Presets cycled by the shortcut: `default → rating → price → -price → provider,price → source,rating → -rating → context → name → default`.

### `source` key

`source` is the provenance of the number shown next to a row:

- `live` — matched in the live OpenRouter catalog (authoritative)
- `registry` — the model's own registered cost, no live match
- `unknown` — neither; nothing trustworthy to sort on

### Config file

`$PI_CODING_AGENT_DIR/pi-model-pricing.json` (default `~/.pi/agent/pi-model-pricing.json`), written by `/model-pricing sort`:

```json
{
  "sort": "rating",
  "sortKey": "alt+s",
  "popularityTtlHours": 24,
  "pricingTtlHours": 1
}
```

`sortKey` accepts any Pi key id (`f6`, `ctrl+alt+s`, …). The same key is also registered as a global shortcut, so the ordering can be changed without opening the picker; a conflicting or malformed key is logged and ignored rather than breaking startup.

---

## Popularity data — what it is and what it is not

Source: `GET /api/v1/datasets/rankings-daily`, the same dataset behind <https://openrouter.ai/rankings>. `/api/v1/models` itself carries **no** popularity field (it only supports `sort=most-popular` ordering, with no score).

- The endpoint returns the **top 50 public models per day** by total tokens (`prompt_tokens + completion_tokens`), plus one aggregated `other` row that is ignored. Default window: the last 30 completed UTC days.
- Requires a **valid OpenRouter API key** — the same key used for inference. Resolution order: `OPENROUTER_API_KEY`, then `auth.json`. `apiKey`, `key` and OAuth-minted `access` credential shapes all work, so keys from `/login` or `pi-openrouter-accounts` are accepted.
- Rate limits: 30 requests/min, 500/day per account. A 24 h TTL keeps normal use far below that. A `401`/`429` keeps the previous index instead of blanking the UI; `/model-pricing help` shows the last error.
- Joined to catalog models by `canonical_slug` (+ `:variant`), because the dataset keys rows on canonical permaslugs while the catalog exposes dated `canonical_slug` fields. A date-stripped fallback join exists for rows differing only by revision date.
- **Absence means "not in the top 50", not "unused."** A model with no row shows `outside the top-50 daily ranking` rather than a misleading `#0`. With a 30-day window roughly 80 of ~440 catalog models qualify.
- A variant without its own dataset row (e.g. `:batch`) inherits its base model's popularity; `:free` variants are ranked separately by OpenRouter and matched exactly.
- `globalRank` sorts matched models by total tokens inside the window; `share` is that model's fraction of ranked traffic.

**Attribution (CC BY 4.0 — required when republishing this data):**

> Source: OpenRouter (openrouter.ai/rankings), as of {`meta.as_of`}. Licensed under CC BY 4.0.

Printed by `/model-pricing popular`; the detail panel shows the short `Source: openrouter.ai/rankings` form.

---

## Installation

### Option 1: Global Pi Extension (Local)

```bash
ln -s /path/to/pi-model-pricing ~/.pi/agent/extensions/pi-model-pricing
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-model-pricing/index.ts"]
}
```

### Option 2: Git Package

```json
{
  "packages": ["git:github.com/mastnacek/pi-model-pricing"]
}
```

---

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | extension entry point, `/model-pricing` command, sort shortcut |
| `openrouter.ts` | live pricing fetch, disk cache, slug → price lookup |
| `popularity.ts` | rankings-daily fetch, aggregation, daily TTL, matching |
| `ranking.ts` | sort-spec grammar, comparator, per-row cost/popularity resolution |
| `config.ts` | config file read/write, TTLs, sort key |
| `selector-patch.ts` | patches `ModelSelectorComponent` rows, detail panel, filters, sort header and input |

## Caveats

- The selector patch monkey-patches `ModelSelectorComponent.prototype` (`updateList`, `filterModels`, `handleInput`). A Pi release that renames these silently disables the visuals (no crash) — re-check after engine upgrades.
- Popularity needs an API key; without one, price badges still work and popularity is simply absent.
- Token counts come from each upstream provider's own tokenizer, so cross-model comparisons are approximate.

---

## License

MIT © [mastnacek](https://github.com/mastnacek)

Rankings data © OpenRouter, licensed CC BY 4.0; attributed in the UI and in `/model-pricing popular`.