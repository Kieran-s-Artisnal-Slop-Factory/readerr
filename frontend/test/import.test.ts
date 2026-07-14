/**
 * Import regression tests around the two Settings import surfaces — data
 * backups (Settings → Backup) and themes (Appearance) — driven by a standard
 * example backup in test/fixtures (a trimmed real export, schemaVersion 5,
 * every store key present). Guards the failure where a real backup fed to
 * the wrong importer died with "Not a readerr theme" instead of importing
 * or redirecting.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportData, importData, type ExportEnvelope } from '../src/lib/db/export';
import { importKindOf } from '../src/lib/importKind';
import { importTheme } from '../src/lib/theme';

const fixturePath = new URL('./fixtures/readerr-backup-example.json', import.meta.url);
const fixtureText = readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText) as ExportEnvelope;

const themeExport = JSON.stringify({
  format: 'readerr-theme',
  version: 1,
  base: 'gruvbox',
  overrides: { light: {}, dark: {}, shared: {} },
});

describe('standard backup example', () => {
  it('is recognized as a backup', () => {
    expect(importKindOf(fixture)).toBe('backup');
  });

  it('imports cleanly as a full replace', async () => {
    const rowCount = Object.values(fixture.data).reduce((n, rows) => n + rows.length, 0);
    const result = await importData(fixture);
    expect(result.mode).toBe('replaced');
    expect(result.rows).toBe(rowCount);
  });

  it('round-trips through export and a second import', async () => {
    await importData(fixture);
    const exported = await exportData('full');
    expect(exported.data.links).toHaveLength(fixture.data.links.length);
    expect(exported.data.tags).toHaveLength(fixture.data.tags.length);
    const again = await importData(exported);
    expect(again.mode).toBe('replaced');
  });

  it('rejects a backup from a newer app version with a clear message', async () => {
    const future = { ...fixture, schemaVersion: 9999 };
    await expect(importData(future)).rejects.toThrow(/newer app version/);
  });
});

describe('wrong-importer redirects', () => {
  it('the theme importer points a data backup at Settings → Backup', () => {
    // The original failure: a real backup through the theme importer died
    // with 'Not a readerr theme (missing "format": "readerr-theme").'
    expect(() => importTheme(fixtureText)).toThrow(/data backup.*Settings → Backup/);
  });

  it('the data importer points a theme file at Appearance', async () => {
    await expect(importData(JSON.parse(themeExport))).rejects.toThrow(
      /theme export.*Appearance/
    );
  });

  it('importKindOf classifies both file kinds and garbage', () => {
    expect(importKindOf(JSON.parse(themeExport))).toBe('theme');
    expect(importKindOf({})).toBe('unknown');
    expect(importKindOf(null)).toBe('unknown');
    expect(importKindOf('nope')).toBe('unknown');
  });
});
