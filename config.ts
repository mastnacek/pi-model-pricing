/**
 * Plugin configuration for pi-model-pricing.
 *
 * Stored at `$PI_CODING_AGENT_DIR/pi-model-pricing.json` (default
 * `~/.pi/agent/pi-model-pricing.json`) so settings survive sessions, `/reload`
 * and engine upgrades.
 *
 * Deliberately dependency-free: both popularity.ts and ranking.ts read this, and
 * neither may import the other.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkdirSync } from "node:fs";
import { renameSync } from "node:fs";
import { writeFileSync } from "node:fs";

export interface PluginConfig {
  /** Sort spec, e.g. "rating", "price", "provider,price", "-price". */
  sort?: string;
  /** Key that cycles the sort spec inside the model selector (pi key id). */
  sortKey?: string;
  /** Popularity cache TTL in hours; defaults to 24 (once a day). */
  popularityTtlHours?: number;
  /** Pricing cache TTL in hours; defaults to 1. */
  pricingTtlHours?: number;
}

export const DEFAULT_SORT = "default";
export const DEFAULT_SORT_KEY = "alt+s";
export const DEFAULT_POPULARITY_TTL_HOURS = 24;
export const DEFAULT_PRICING_TTL_HOURS = 1;

export function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), ".pi", "agent");
}

export const CONFIG_PATH = path.join(agentDir(), "pi-model-pricing.json");

let cached: PluginConfig | null = null;

export function loadConfig(): PluginConfig {
  if (cached) return cached;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      if (parsed && typeof parsed === "object") {
        cached = parsed as PluginConfig;
        return cached;
      }
    }
  } catch (err) {
    console.error("[pi-model-pricing] Failed to read config:", err);
  }
  cached = {};
  return cached;
}

export function saveConfig(next: PluginConfig): void {
  cached = next;
  try {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const tmp = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    console.error("[pi-model-pricing] Failed to write config:", err);
  }
}

export function updateConfig(patch: Partial<PluginConfig>): PluginConfig {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}

/** Invalidate the in-memory copy (used by `/model-pricing refresh`). */
export function reloadConfig(): PluginConfig {
  cached = null;
  return loadConfig();
}

export function popularityTtlMs(): number {
  const hours = loadConfig().popularityTtlHours;
  const effective = Number.isFinite(hours) && (hours as number) > 0 ? (hours as number) : DEFAULT_POPULARITY_TTL_HOURS;
  return effective * 60 * 60 * 1000;
}

export function pricingTtlMs(): number {
  const hours = loadConfig().pricingTtlHours;
  const effective = Number.isFinite(hours) && (hours as number) > 0 ? (hours as number) : DEFAULT_PRICING_TTL_HOURS;
  return effective * 60 * 60 * 1000;
}

export function getSortKey(): string {
  const key = loadConfig().sortKey;
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : DEFAULT_SORT_KEY;
}