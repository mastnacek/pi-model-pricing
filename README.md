# pi-model-pricing

Live model token pricing extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

Dynamically fetches up-to-date pricing for models from the OpenRouter API (never hardcoded) and displays input & output token rates directly inside Pi's native model selector (`/model` / `Ctrl+P`) and via `/model-pricing`.

---

## Features

- **Never hardcoded**: Automatically fetches live rates from `https://openrouter.ai/api/v1/models` in the background.
- **Persistent local cache**: Saves to `~/.pi/agent/cache/openrouter-pricing-cache.json` with a 1-hour TTL.
- **Native `/model` & `Ctrl+P` enhancement**:
  - **Inline price badge on every row**:
    - `→ anthropic/claude-sonnet-4.5 [openrouter] [in:$3/out:$15] · default`
    - `deepseek/deepseek-chat [openrouter] [in:$0.25/out:$0.95]`
    - `deepseek-v4-flash-free [zenfree] [free]`
  - **Rich detail preview in bottom panel**:
    - Exact rates: `$X.XX/1M in · $Y.XX/1M out`
    - Cache rates: `Cache: $Z.XX/1M read · $W.XX/1M write`
    - Context window and live source indicator
  - **Price search & filter**:
    - Type `free` or `$0` to immediately filter all free models
    - Type `paid` or specific prices (e.g. `0.15`, `3`)
- **Dedicated command `/model-pricing`**:
  - `/model-pricing` — View status of loaded models and cache age
  - `/model-pricing refresh` — Force immediate reload from OpenRouter API
  - `/model-pricing <query>` — Search models and print price breakdown

---

## Installation

### Option 1: Global Pi Extension (Local)

Place a symlink in your Pi extensions directory:

```bash
ln -s /home/jara/100_projects/03_pi_extension/pi-model-pricing ~/.pi/agent/extensions/pi-model-pricing
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/home/jara/100_projects/03_pi_extension/pi-model-pricing/index.ts"
  ]
}
```

### Option 2: Git Package (after pushing to GitHub)

```json
{
  "packages": [
    "git:github.com/mastnacek/pi-model-pricing"
  ]
}
```

---

## License

MIT © [mastnacek](https://github.com/mastnacek)
