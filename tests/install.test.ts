import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installClaudeStatusLine, installShell, uninstallClaudeStatusLine, uninstallShell } from '../src/install/shell.js';

const tempHomes: string[] = [];
const withHome = async (run: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "surplus home '$ "));
  tempHomes.push(home);
  process.env.HOME = home;
  process.env.SHELL = '/bin/zsh';
  process.env.XDG_STATE_HOME = join(home, 'state');
  process.env.XDG_CONFIG_HOME = join(home, 'config');
  await run(home);
};

afterEach(async () => {
  for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true });
  delete process.env.XDG_STATE_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

describe('reversible install', () => {
  it('quotes metacharacters, is idempotent, and preserves user edits during uninstall', async () => {
    await withHome(async (home) => {
      const rc = join(home, '.zshrc');
      await writeFile(rc, 'export USER_VALUE=kept\n');
      await installShell();
      await installShell();
      const installed = await readFile(rc, 'utf8');
      expect(installed).toContain("'\\''");
      expect(installed.match(/surplus managed block/g)).toHaveLength(2);
      await writeFile(join(home, 'state/surplus/bin/claude'), '#!/bin/sh\nchanged by user\n');
      await uninstallShell();
      expect(await readFile(rc, 'utf8')).toBe('export USER_VALUE=kept\n');
      expect(await readFile(join(home, 'state/surplus/bin/claude'), 'utf8')).toContain('changed by user');
    });
  });

  it('chains and restores a preexisting Claude command statusline only while Surplus still owns it', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      const original = { type: 'command', command: "printf '%s' \"$HOME\"", padding: 8 };
      await writeFile(settings, JSON.stringify({ theme: 'dark', statusLine: original }));
      await installClaudeStatusLine();
      const installed = JSON.parse(await readFile(settings, 'utf8')) as { theme: string; statusLine: { command: string; padding: number } };
      expect(installed.theme).toBe('dark');
      expect(installed.statusLine.padding).toBe(8);
      expect(installed.statusLine.command).toContain('--original=');
      await uninstallClaudeStatusLine();
      const restored = JSON.parse(await readFile(settings, 'utf8')) as { statusLine: unknown };
      expect(restored.statusLine).toEqual(original);
    });
  });

  it('keeps a later user statusline edit on uninstall', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      await installClaudeStatusLine();
      await writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-new-line' } }));
      await uninstallClaudeStatusLine();
      const current = JSON.parse(await readFile(settings, 'utf8')) as { statusLine: { command: string } };
      expect(current.statusLine.command).toBe('my-new-line');
    });
  });
});
