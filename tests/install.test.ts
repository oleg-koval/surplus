import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
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
      await installClaudeStatusLine();
      const installed = JSON.parse(await readFile(settings, 'utf8')) as { theme: string; statusLine: { command: string; padding: number } };
      expect(installed.theme).toBe('dark');
      expect(installed.statusLine.padding).toBe(8);
      expect(installed.statusLine.command).toContain('--original=');
      expect(installed.statusLine.command.match(/capture claude/g)).toHaveLength(1);
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

  it('updates a shell startup file through its symlink without replacing the link', async () => {
    await withHome(async (home) => {
      const rc = join(home, '.zshrc');
      const target = join(home, 'shared-zshrc');
      await writeFile(target, 'export USER_VALUE=kept\n');
      await symlink(target, rc);
      await installShell();
      expect((await lstat(rc)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toContain('surplus managed block');
      await uninstallShell();
      expect((await lstat(rc)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('export USER_VALUE=kept\n');
    });
  });

  it('does not replace a broken shell startup symlink', async () => {
    await withHome(async (home) => {
      const rc = join(home, '.zshrc');
      await symlink(join(home, 'missing-startup-file'), rc);
      await expect(installShell()).rejects.toThrow();
      expect((await lstat(rc)).isSymbolicLink()).toBe(true);
    });
  });

  it('preflights shell support and wrapper collisions before writing any install files', async () => {
    await withHome(async (home) => {
      const bin = join(home, 'state/surplus/bin');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(bin, { recursive: true }));
      const codexWrapper = join(bin, 'codex');
      await writeFile(codexWrapper, 'user-owned codex wrapper');
      await expect(installShell()).rejects.toThrow(/Refusing to overwrite/);
      await expect(readFile(join(bin, 'claude'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(home, '.zshrc'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(codexWrapper, 'utf8')).toBe('user-owned codex wrapper');
    });
  });

  it('leaves a fresh shell untouched when Claude capture settings are malformed', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      const shell = join(home, '.zshrc');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      await writeFile(settings, '{broken');
      await expect(main(['install'])).rejects.toThrow(/malformed|JSON/);
      await expect(readFile(join(home, 'state/surplus/bin/claude'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(shell, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(settings, 'utf8')).toBe('{broken');
    });
  });

  it('preserves a preexisting Surplus shell installation when capture settings are unsupported', async () => {
    await withHome(async (home) => {
      await installShell();
      const shell = join(home, '.zshrc');
      const wrapperPath = join(home, 'state/surplus/bin/claude');
      const originalShell = await readFile(shell, 'utf8');
      const originalWrapper = await readFile(wrapperPath, 'utf8');
      const settings = join(home, '.claude', 'settings.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      const unsupported = JSON.stringify({ statusLine: { type: 'hook', command: 'user-hook' } });
      await writeFile(settings, unsupported);
      await expect(main(['install'])).rejects.toThrow(/command statusline/);
      expect(await readFile(shell, 'utf8')).toBe(originalShell);
      expect(await readFile(wrapperPath, 'utf8')).toBe(originalWrapper);
      expect(await readFile(settings, 'utf8')).toBe(unsupported);
    });
  });
});
