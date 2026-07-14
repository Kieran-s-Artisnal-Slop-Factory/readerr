/**
 * Theming engine. A theme is a set of values for the design tokens in
 * styles/theme.css: mode-paired tokens (a light and a dark value, emitted
 * via light-dark()) plus shared tokens (fonts, spacing, radii). Three
 * built-in themes ship; the user can override any token per mode and the
 * result persists in localStorage:
 *
 *   readerr-theme-config — the ThemeConfig JSON (base + overrides)
 *   readerr-theme-css    — the compiled CSS, injected before first paint
 *                          by an inline script in Layout.astro so pages
 *                          never flash the default theme
 *
 * theme.css keeps the gruvbox values as its defaults, so gruvbox with no
 * overrides compiles to no CSS at all.
 */
import { importKindOf } from './importKind';

export type ThemeName = 'forest'|'gruvbox' | 'dracula' ;
export type Mode = 'light' | 'dark';

export interface PairedVar {
  name: string;
  label: string;
  /** 'color' gets a color picker; 'text' is free-form (shadows). */
  kind: 'color' | 'text';
}

/** Tokens with independent light/dark values. */
export const PAIRED_VARS: PairedVar[] = [
  { name: '--color-primary', label: 'Primary', kind: 'color' },
  { name: '--color-primary-strong', label: 'Primary (strong)', kind: 'color' },
  { name: '--color-primary-soft', label: 'Primary (soft bg)', kind: 'color' },
  { name: '--color-on-primary', label: 'Text on primary', kind: 'color' },
  { name: '--bg-color', label: 'Page background', kind: 'color' },
  { name: '--surface-color', label: 'Surface', kind: 'color' },
  { name: '--surface-raised-color', label: 'Raised surface', kind: 'color' },
  { name: '--border-color', label: 'Border', kind: 'color' },
  { name: '--text-color', label: 'Text', kind: 'color' },
  { name: '--text-muted-color', label: 'Muted text', kind: 'color' },
  { name: '--color-success', label: 'Success', kind: 'color' },
  { name: '--color-danger', label: 'Danger', kind: 'color' },
  { name: '--color-warning', label: 'Warning', kind: 'color' },
  { name: '--shadow-1', label: 'Shadow (low)', kind: 'text' },
  { name: '--shadow-2', label: 'Shadow (high)', kind: 'text' },
];

/** Mode-independent tokens (typography, spacing, shape, layout). */
export const SHARED_VARS: { name: string; label: string }[] = [
  { name: '--font-body', label: 'Body font stack' },
  { name: '--font-size-sm', label: 'Font size (small)' },
  { name: '--font-size-base', label: 'Font size (base)' },
  { name: '--font-size-lg', label: 'Font size (large)' },
  { name: '--font-size-xl', label: 'Font size (XL)' },
  { name: '--font-size-2xl', label: 'Font size (2XL)' },
  { name: '--line-height', label: 'Line height' },
  { name: '--space-1', label: 'Spacing 1' },
  { name: '--space-2', label: 'Spacing 2' },
  { name: '--space-3', label: 'Spacing 3' },
  { name: '--space-4', label: 'Spacing 4' },
  { name: '--space-5', label: 'Spacing 5' },
  { name: '--space-6', label: 'Spacing 6' },
  { name: '--radius-sm', label: 'Radius (small)' },
  { name: '--radius-md', label: 'Radius (medium)' },
  { name: '--radius-lg', label: 'Radius (large)' },
  { name: '--radius-full', label: 'Radius (full)' },
  { name: '--page-max-width', label: 'Page max width' },
  { name: '--navbar-height', label: 'Navbar height' },
];

/** Defaults for shared tokens (mirrors theme.css). */
export const SHARED_DEFAULTS: Record<string, string> = {
  '--font-body': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  '--font-size-sm': '0.85rem',
  '--font-size-base': '1rem',
  '--font-size-lg': '1.2rem',
  '--font-size-xl': '1.5rem',
  '--font-size-2xl': '2rem',
  '--line-height': '1.55',
  '--space-1': '0.25rem',
  '--space-2': '0.5rem',
  '--space-3': '0.75rem',
  '--space-4': '1rem',
  '--space-5': '1.5rem',
  '--space-6': '2.5rem',
  '--radius-sm': '6px',
  '--radius-md': '10px',
  '--radius-lg': '16px',
  '--radius-full': '999px',
  '--page-max-width': '60rem',
  '--navbar-height': '3.5rem',
};

export interface ThemeDef {
  label: string;
  description: string;
  light: Record<string, string>;
  dark: Record<string, string>;
}

export const THEMES: Record<ThemeName, ThemeDef> = {
  // Deep forest greens with brown accents (dark); white with green (light).
  forest: {
    label: 'Forest',
    description: 'Deep green woods with brown accents; crisp green light mode.',
    light: {
      '--color-primary': '#2e7d43',
      '--color-primary-strong': '#1d5e2f',
      '--color-primary-soft': '#e4f3e7',
      '--color-on-primary': '#ffffff',
      '--bg-color': '#fafcf9',
      '--surface-color': '#ffffff',
      '--surface-raised-color': '#ffffff',
      '--border-color': '#dbe7dc',
      '--text-color': '#1b241d',
      '--text-muted-color': '#5f7263',
      '--color-success': '#1a7f37',
      '--color-danger': '#c62828',
      '--color-warning': '#b45309',
      '--shadow-1': '0 1px 3px rgb(27 36 29 / 0.08)',
      '--shadow-2': '0 4px 16px rgb(27 36 29 / 0.14)',
    },
    dark: {
      '--color-primary': '#b08557',
      '--color-primary-strong': '#cfa878',
      '--color-primary-soft': '#33261a',
      '--color-on-primary': '#12100c',
      '--bg-color': '#0b1a12',
      '--surface-color': '#122519',
      '--surface-raised-color': '#183020',
      '--border-color': '#29402f',
      '--text-color': '#e4efe6',
      '--text-muted-color': '#93ab98',
      '--color-success': '#4ade80',
      '--color-danger': '#f87171',
      '--color-warning': '#d9a441',
      '--shadow-1': '0 1px 3px rgb(0 0 0 / 0.45)',
      '--shadow-2': '0 4px 16px rgb(0 0 0 / 0.6)',
    },
  },
  // The original readerr look — warm paper light mode, embers dark mode.
  gruvbox: {
    label: 'Gruvbox',
    description: 'Warm paper and ember orange (the original).',
    light: {
      '--color-primary': '#ff7a1a',
      '--color-primary-strong': '#e05e00',
      '--color-primary-soft': '#fff0e3',
      '--color-on-primary': '#ffffff',
      '--bg-color': '#faf8f5',
      '--surface-color': '#ffffff',
      '--surface-raised-color': '#ffffff',
      '--border-color': '#e8e2d9',
      '--text-color': '#241f1a',
      '--text-muted-color': '#6d645a',
      '--color-success': '#1a7f37',
      '--color-danger': '#c62828',
      '--color-warning': '#b45309',
      '--shadow-1': '0 1px 3px rgb(36 31 26 / 0.08)',
      '--shadow-2': '0 4px 16px rgb(36 31 26 / 0.14)',
    },
    dark: {
      '--color-primary': '#ff7a1a',
      '--color-primary-strong': '#e05e00',
      '--color-primary-soft': '#3d2412',
      '--color-on-primary': '#ffffff',
      '--bg-color': '#151210',
      '--surface-color': '#1f1a16',
      '--surface-raised-color': '#292219',
      '--border-color': '#3d352b',
      '--text-color': '#f2ede6',
      '--text-muted-color': '#a99e90',
      '--color-success': '#4ade80',
      '--color-danger': '#f87171',
      '--color-warning': '#fbbf24',
      '--shadow-1': '0 1px 3px rgb(0 0 0 / 0.4)',
      '--shadow-2': '0 4px 16px rgb(0 0 0 / 0.55)',
    },
  },
  // Dracula (dark) and its official light counterpart Alucard.
  dracula: {
    label: 'Dracula',
    description: 'The classic purple-on-slate dark palette.',
    light: {
      '--color-primary': '#644ac9',
      '--color-primary-strong': '#503aa8',
      '--color-primary-soft': '#ece7fb',
      '--color-on-primary': '#ffffff',
      '--bg-color': '#fffbeb',
      '--surface-color': '#ffffff',
      '--surface-raised-color': '#ffffff',
      '--border-color': '#e6e0cf',
      '--text-color': '#1f1f1f',
      '--text-muted-color': '#635d97',
      '--color-success': '#14710a',
      '--color-danger': '#cb3a2a',
      '--color-warning': '#846e15',
      '--shadow-1': '0 1px 3px rgb(31 31 31 / 0.08)',
      '--shadow-2': '0 4px 16px rgb(31 31 31 / 0.14)',
    },
    dark: {
      '--color-primary': '#bd93f9',
      '--color-primary-strong': '#d3b3ff',
      '--color-primary-soft': '#3a3153',
      '--color-on-primary': '#282a36',
      '--bg-color': '#282a36',
      '--surface-color': '#313442',
      '--surface-raised-color': '#3b3e4f',
      '--border-color': '#44475a',
      '--text-color': '#f8f8f2',
      '--text-muted-color': '#8b91bd',
      '--color-success': '#50fa7b',
      '--color-danger': '#ff5555',
      '--color-warning': '#f1fa8c',
      '--shadow-1': '0 1px 3px rgb(0 0 0 / 0.4)',
      '--shadow-2': '0 4px 16px rgb(0 0 0 / 0.55)',
    },
  },
};

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export interface ThemeConfig {
  base: ThemeName;
  overrides: {
    light: Record<string, string>;
    dark: Record<string, string>;
    shared: Record<string, string>;
  };
}

const CONFIG_KEY = 'readerr-theme-config';
const CSS_KEY = 'readerr-theme-css';
const STYLE_ID = 'readerr-theme';
/** Version stamp for exported theme files. */
const EXPORT_MARKER = 'readerr-theme';

export function defaultConfig(): ThemeConfig {
  return { base: 'forest', overrides: { light: {}, dark: {}, shared: {} } };
}

function pairedNames(): Set<string> {
  return new Set(PAIRED_VARS.map((v) => v.name));
}

function sharedNames(): Set<string> {
  return new Set(SHARED_VARS.map((v) => v.name));
}

/** Keep only known variable names with string values. */
function sanitizeOverrides(raw: unknown, allowed: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Values land inside a <style> tag — reject anything that could
    // terminate the declaration/block and smuggle in arbitrary CSS.
    if (allowed.has(k) && typeof v === 'string' && !/[;{}<]/.test(v)) out[k] = v.trim();
  }
  return out;
}

function sanitizeConfig(raw: unknown): ThemeConfig {
  const cfg = defaultConfig();
  if (typeof raw !== 'object' || raw === null) return cfg;
  const r = raw as Record<string, unknown>;
  if (typeof r.base === 'string' && r.base in THEMES) cfg.base = r.base as ThemeName;
  const o = (r.overrides ?? {}) as Record<string, unknown>;
  cfg.overrides.light = sanitizeOverrides(o.light, pairedNames());
  cfg.overrides.dark = sanitizeOverrides(o.dark, pairedNames());
  cfg.overrides.shared = sanitizeOverrides(o.shared, sharedNames());
  return cfg;
}

export function loadThemeConfig(): ThemeConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return defaultConfig();
    return sanitizeConfig(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}

/** The value in effect for a paired token in a mode (override or theme). */
export function resolvedValue(cfg: ThemeConfig, mode: Mode, name: string): string {
  return cfg.overrides[mode][name] ?? THEMES[cfg.base][mode][name] ?? '';
}

export function resolvedSharedValue(cfg: ThemeConfig, name: string): string {
  return cfg.overrides.shared[name] ?? SHARED_DEFAULTS[name] ?? '';
}

export function hasCustomizations(cfg: ThemeConfig): boolean {
  return (
    Object.keys(cfg.overrides.light).length > 0 ||
    Object.keys(cfg.overrides.dark).length > 0 ||
    Object.keys(cfg.overrides.shared).length > 0
  );
}

/**
 * Compile the config to CSS. Forest with no overrides needs none.
 * :root:root doubles the specificity so the override wins over theme.css
 * even though the boot script injects it earlier in <head> than Astro's
 * bundled stylesheets.
 */
export function compileCss(cfg: ThemeConfig): string {
  if (cfg.base === 'forest' && !hasCustomizations(cfg)) return '';
  const lines: string[] = [':root:root {'];
  for (const v of PAIRED_VARS) {
    lines.push(
      `  ${v.name}: light-dark(${resolvedValue(cfg, 'light', v.name)}, ${resolvedValue(cfg, 'dark', v.name)});`
    );
  }
  for (const [name, value] of Object.entries(cfg.overrides.shared)) {
    lines.push(`  ${name}: ${value};`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** Persist and apply immediately. */
export function saveThemeConfig(cfg: ThemeConfig): void {
  const css = compileCss(cfg);
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  if (css) localStorage.setItem(CSS_KEY, css);
  else localStorage.removeItem(CSS_KEY);
  applyCss(css);
}

/** Upsert the runtime <style> tag (Layout's boot script creates it on load). */
function applyCss(css: string): void {
  let el = document.getElementById(STYLE_ID);
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

export function exportTheme(cfg: ThemeConfig): string {
  return JSON.stringify({ format: EXPORT_MARKER, version: 1, ...cfg }, null, 2);
}

/** Parse an exported theme (throws with a user-facing message). */
export function importTheme(text: string): ThemeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON.');
  }
  // A data backup fed to the theme importer deserves directions, not a
  // cryptic format error — the two import buttons sit a card apart.
  if (importKindOf(raw) === 'backup') {
    throw new Error(
      'This is a readerr data backup, not a theme — import it under Settings → Backup → Import JSON.'
    );
  }
  const r = raw as Record<string, unknown>;
  if (r?.format !== EXPORT_MARKER) {
    throw new Error('Not a readerr theme (missing "format": "readerr-theme").');
  }
  return sanitizeConfig(raw);
}
