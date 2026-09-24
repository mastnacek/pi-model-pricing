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

/** Global layer: ~/.pi/agent/pi-model-pricing.json (respects PI_CODING_AGENT_DIR). */
export const GLOBAL_CONFIG_FILE = path.join(agentDir(), "pi-model-pricing.json");

/** Kept as the historical name for the global layer. */
export const CONFIG_PATH = GLOBAL_CONFIG_FILE;

/** Project override: <cwd>/.pi/pi-model-pricing.json (wins over the global file). */
export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".pi", "pi-model-pricing.json");
}

/**
 * Session cwd the cascade hangs off. Set on session_start; without it only the
 * global layer applies. Changing it invalidates the cached merge.
 */
let activeCwd: string | undefined;

export function setConfigCwd(cwd?: string): void {
  if (cwd !== activeCwd) {
    activeCwd = cwd;
    cached = null;
  }
}

let cached: PluginConfig | null = null;

/** Decode a parsed JSON value at the I/O boundary; `{}` on any mismatch. */
function decodeConfig(value: unknown): PluginConfig {
  if (value === null || Array.isArray(value)) return {};
  if (typeof value !== "object") return {};
  return value as PluginConfig;
}

function readLayer(file: string): PluginConfig {
  try {
    if (fs.existsSync(file)) {
      return decodeConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    }
  } catch (err) {
    console.error(`[pi-model-pricing] Failed to read ${file}:`, err);
  }
  return {};
}

/**
 * Effective config with the mandatory cascade:
 * defaults <- ~/.pi/agent/pi-model-pricing.json <- <cwd>/.pi/pi-model-pricing.json.
 */
export function loadConfig(cwd: string | undefined = activeCwd): PluginConfig {
  if (cached) return cached;
  const merged = readLayer(GLOBAL_CONFIG_FILE);
  if (cwd) Object.assign(merged, readLayer(projectConfigPath(cwd)));
  cached = merged;
  return cached;
}

/** `--global` (isGlobal) writes the global layer, otherwise <cwd>/.pi/. */
export function saveConfig(next: PluginConfig, isGlobal = false, cwd: string | undefined = activeCwd): void {
  cached = next;
  const target = isGlobal || !cwd ? GLOBAL_CONFIG_FILE : projectConfigPath(cwd);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    console.error("[pi-model-pricing] Failed to write config:", err);
  }
}

export function updateConfig(patch: Partial<PluginConfig>, isGlobal = false): PluginConfig {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next, isGlobal);
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