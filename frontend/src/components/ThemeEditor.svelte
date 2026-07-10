<script lang="ts">
  /**
   * Theme picker + token editor. Every change applies live and persists.
   * The Customize panel edits light/dark paired tokens and shared tokens;
   * Share offers JSON export (file or clipboard) and import (file or paste).
   */
  import {
    defaultConfig,
    exportTheme,
    hasCustomizations,
    importTheme,
    loadThemeConfig,
    PAIRED_VARS,
    resolvedSharedValue,
    resolvedValue,
    saveThemeConfig,
    SHARED_VARS,
    THEME_NAMES,
    THEMES,
    type Mode,
    type ThemeConfig,
  } from '../lib/theme';

  let config = $state<ThemeConfig>(defaultConfig());
  let tab = $state<Mode | 'shared'>('dark');
  let customizeOpen = $state(false);
  let importText = $state('');
  let message = $state('');

  /** The current theme as shareable plaintext, always visible (#9). */
  const exportedText = $derived(exportTheme($state.snapshot(config) as ThemeConfig));

  $effect(() => {
    // Load once on mount (client-only component).
    config = loadThemeConfig();
  });

  function persist() {
    saveThemeConfig($state.snapshot(config) as ThemeConfig);
  }

  function setBase(e: Event) {
    config.base = (e.target as HTMLSelectElement).value as ThemeConfig['base'];
    persist();
  }

  function setPaired(mode: Mode, name: string, value: string) {
    const themeValue = THEMES[config.base][mode][name];
    if (value.trim() === '' || value === themeValue) delete config.overrides[mode][name];
    else config.overrides[mode][name] = value;
    persist();
  }

  function setShared(name: string, value: string) {
    if (value.trim() === '') delete config.overrides.shared[name];
    else config.overrides.shared[name] = value;
    persist();
  }

  function resetVar(scope: Mode | 'shared', name: string) {
    delete config.overrides[scope][name];
    persist();
  }

  function resetAll() {
    if (!confirm('Discard all token customizations? The base theme choice is kept.')) return;
    config.overrides = { light: {}, dark: {}, shared: {} };
    persist();
  }

  /** input[type=color] only understands #rrggbb; fall back to text-only. */
  function asHex(value: string): string | null {
    const v = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      return '#' + [...v.slice(1)].map((c) => c + c).join('');
    }
    return null;
  }

  function downloadJson() {
    const blob = new Blob([exportTheme($state.snapshot(config) as ThemeConfig)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `readerr-theme-${config.base}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyJson() {
    await navigator.clipboard.writeText(exportTheme($state.snapshot(config) as ThemeConfig));
    message = 'Theme JSON copied to clipboard.';
  }

  function applyImport(text: string) {
    try {
      config = importTheme(text);
      persist();
      importText = '';
      message = 'Theme imported.';
    } catch (err) {
      message = `Import failed: ${err instanceof Error ? err.message : err}`;
    }
  }

  async function onImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    applyImport(await file.text());
    input.value = '';
  }
</script>

<div class="theme-editor">
  {#if message}
    <p class="msg">{message}</p>
  {/if}

  <div class="picker-row">
    <label for="theme-base">Theme</label>
    <select id="theme-base" value={config.base} onchange={setBase}>
      {#each THEME_NAMES as name (name)}
        <option value={name}>{THEMES[name].label}</option>
      {/each}
    </select>
    <span class="muted">{THEMES[config.base].description}</span>
  </div>

  <div class="section-toggles">
    <button type="button" class="btn" aria-expanded={customizeOpen} onclick={() => (customizeOpen = !customizeOpen)}>
      {customizeOpen ? '▾' : '▸'} Customize
      {#if hasCustomizations(config)}
        <span class="dot" title="Has customizations"></span>
      {/if}
    </button>
  </div>

  {#if customizeOpen}
    <div class="customize">
      <div class="tabs" role="tablist">
        {#each [['light', 'Light'], ['dark', 'Dark'], ['shared', 'Shared']] as [value, label] (value)}
          <button
            type="button"
            role="tab"
            class="tab"
            class:active={tab === value}
            aria-selected={tab === value}
            onclick={() => (tab = value as typeof tab)}
          >
            {label}
          </button>
        {/each}
        <button type="button" class="reset-all" onclick={resetAll} disabled={!hasCustomizations(config)}>
          Reset all
        </button>
      </div>

      {#if tab === 'shared'}
        <div class="vars">
          {#each SHARED_VARS as v (v.name)}
            {@const value = resolvedSharedValue(config, v.name)}
            {@const overridden = v.name in config.overrides.shared}
            <div class="var-row" class:overridden>
              <span class="var-label" title={v.name}>{v.label}</span>
              <input
                type="text"
                class="var-text"
                {value}
                onchange={(e) => setShared(v.name, (e.target as HTMLInputElement).value)}
              />
              {#if overridden}
                <button type="button" class="var-reset" title="Reset to theme value" onclick={() => resetVar('shared', v.name)}>↺</button>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        {@const mode = tab as Mode}
        <div class="vars">
          {#each PAIRED_VARS as v (v.name)}
            {@const value = resolvedValue(config, mode, v.name)}
            {@const overridden = v.name in config.overrides[mode]}
            {@const hex = v.kind === 'color' ? asHex(value) : null}
            <div class="var-row" class:overridden>
              <span class="var-label" title={v.name}>{v.label}</span>
              {#if hex}
                <input
                  type="color"
                  class="var-color"
                  value={hex}
                  oninput={(e) => setPaired(mode, v.name, (e.target as HTMLInputElement).value)}
                />
              {/if}
              <input
                type="text"
                class="var-text"
                {value}
                onchange={(e) => setPaired(mode, v.name, (e.target as HTMLInputElement).value)}
              />
              {#if overridden}
                <button type="button" class="var-reset" title="Reset to theme value" onclick={() => resetVar(mode, v.name)}>↺</button>
              {/if}
            </div>
          {/each}
        </div>
        <p class="muted small">
          Editing the {mode} palette — switch the theme mode above to see it live.
        </p>
      {/if}
    </div>
  {/if}

  <div class="share">
    <span class="share-label">Share</span>
    <textarea class="current" rows="4" readonly value={exportedText}></textarea>
    <div class="share-actions">
      <button type="button" class="btn" onclick={copyJson}>Copy to clipboard</button>
      <button type="button" class="btn" onclick={downloadJson}>Download JSON</button>
    </div>

    <span class="share-label">Import</span>
    <textarea
      rows="3"
      placeholder="Paste a shared theme JSON here…"
      bind:value={importText}
    ></textarea>
    <div class="share-actions">
      <button
        type="button"
        class="btn btn-primary"
        disabled={!importText.trim()}
        onclick={() => applyImport(importText)}
      >
        Apply pasted theme
      </button>
      <label class="btn" style="margin-bottom: 0;">
        Import file
        <input type="file" accept="application/json" onchange={onImportFile} hidden />
      </label>
    </div>
  </div>
</div>

<style>
  .theme-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .msg {
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    padding: var(--space-1) var(--space-3);
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .picker-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .picker-row label {
    margin: 0;
    font-weight: 600;
  }

  .picker-row select {
    width: auto;
    min-width: 10rem;
  }

  .muted {
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
  }

  .small {
    margin: var(--space-2) 0 0;
  }

  .section-toggles {
    display: flex;
    gap: var(--space-2);
  }

  .dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--radius-full);
    background: var(--color-primary);
    margin-left: var(--space-1);
  }

  .tabs {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    border-bottom: 1px solid var(--border-color);
    padding-bottom: var(--space-2);
    margin-bottom: var(--space-2);
  }

  .tab {
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    background: var(--surface-color);
    color: var(--text-muted-color);
    padding: 0 var(--space-3);
    font-size: var(--font-size-sm);
    font-weight: 600;
    line-height: 1.9;
    cursor: pointer;
  }

  .tab.active {
    background: var(--color-primary-soft);
    border-color: var(--color-primary);
    color: var(--color-primary-strong);
  }

  .reset-all {
    margin-left: auto;
    border: none;
    background: none;
    color: var(--text-muted-color);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .reset-all:hover:not(:disabled) {
    color: var(--color-danger);
  }

  .reset-all:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .vars {
    display: flex;
    flex-direction: column;
  }

  .var-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) 0;
  }

  .var-label {
    flex: 0 0 11rem;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .var-row.overridden .var-label {
    color: var(--color-primary-strong);
    font-weight: 600;
  }

  .var-color {
    width: 2.2rem;
    height: 1.8rem;
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--radius-sm);
    background: none;
    cursor: pointer;
  }

  .var-text {
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    font-size: var(--font-size-sm);
    font-family: ui-monospace, monospace;
  }

  .var-reset {
    border: none;
    background: none;
    color: var(--text-muted-color);
    cursor: pointer;
    font-size: var(--font-size-base);
  }

  .var-reset:hover {
    color: var(--color-danger);
  }

  .share {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-top: 1px solid var(--border-color);
    padding-top: var(--space-3);
  }

  .share-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-weight: 600;
  }

  .share textarea.current {
    color: var(--text-muted-color);
  }

  .share-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .share textarea {
    width: 100%;
    resize: vertical;
    font-family: ui-monospace, monospace;
    font-size: var(--font-size-sm);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
  }
</style>
