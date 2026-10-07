import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { configPath, defaultConfig, saveConfig } from '../src/core/files.js';
import { installClaudeStatusLine, installShell, statuslineCommand, uninstallClaudeStatusLine, uninstallShell } from '../src/install/shell.js';

const tempHomes: string[] = [];
const withHome = async (run: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "surplus home '$ "));
  tempHomes.push(home);
  process.env.HOME = home;
  process.env.SHELL = '/bin/zsh';
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.XDG_STATE_HOME = join(home, 'state');
  process.env.XDG_CONFIG_HOME = join(home, 'config');
  await run(home);
};

afterEach(async () => {
  for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true });
  delete process.env.XDG_STATE_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
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

  it('removes managed startup blocks even after switching shells', async () => {
    await withHome(async (home) => {
      const zsh = join(home, '.zshrc');
      const bash = join(home, '.bash_profile');
      await installShell();
      process.env.SHELL = '/bin/bash';
      await writeFile(bash, 'export BASH_VALUE=kept\n');
      await uninstallShell();
      expect(await readFile(zsh, 'utf8')).toBe('');
      expect(await readFile(bash, 'utf8')).toBe('export BASH_VALUE=kept\n');
      await expect(readFile(join(home, 'state/surplus/bin/codex'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('reports wrapper read failures during uninstall', async () => {
    await withHome(async (home) => {
      const codexWrapper = join(home, 'state/surplus/bin/codex');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(codexWrapper, { recursive: true }));

      await expect(uninstallShell()).rejects.toMatchObject({ code: 'EISDIR' });
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

  it('does not mistake ordinary statusline text for a Surplus capture command', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      const original = { type: 'command', command: 'echo capture claude' };
      await writeFile(settings, JSON.stringify({ statusLine: original }));

      await installClaudeStatusLine();
      expect(JSON.parse(await readFile(settings, 'utf8'))).toMatchObject({
        statusLine: { command: statuslineCommand(original.command) },
      });
      await uninstallClaudeStatusLine();
      expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ statusLine: original });
    });
  });

  it('refreshes an owned Claude statusline wrapper while retaining its original command and user fields', async () => {
    await withHome(async (home) => {
      const settingsPath = join(home, '.claude', 'settings.json');
      const backupPath = join(home, 'state/surplus/claude-statusline-backup.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      const original = { type: 'command', command: 'original-user-statusline', padding: 8 };
      await writeFile(settingsPath, JSON.stringify({ statusLine: original }));
      await installClaudeStatusLine();
      const firstBackup = JSON.parse(await readFile(backupPath, 'utf8')) as { present: boolean; value: unknown; managedCommand: string };
      const oldInstalledCommand = '/old/node /old/prefix/cli.js capture claude --original=b2xk';
      await writeFile(backupPath, JSON.stringify({ ...firstBackup, managedCommand: oldInstalledCommand }));
      await writeFile(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: oldInstalledCommand, padding: 16, localEdit: true } }));

      expect(await installClaudeStatusLine()).toBe(false);
      const reinstalled = JSON.parse(await readFile(settingsPath, 'utf8')) as { statusLine: Record<string, unknown> };
      const savedBackup = JSON.parse(await readFile(backupPath, 'utf8')) as { present: boolean; value: unknown; managedCommand: string };
      expect(reinstalled.statusLine.command).not.toBe(oldInstalledCommand);
      expect(reinstalled.statusLine).toMatchObject({ padding: 16, localEdit: true });
      expect(savedBackup.value).toEqual(original);
      expect(savedBackup.managedCommand).toBe(reinstalled.statusLine.command);

      await uninstallClaudeStatusLine();
      const restored = JSON.parse(await readFile(settingsPath, 'utf8')) as { statusLine: Record<string, unknown> };
      expect(restored.statusLine).toEqual({ ...original, padding: 16, localEdit: true });
    });
  });

  it('records metadata without claiming capture ownership for an orphaned statusline', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      const backupPath = join(home, 'state/surplus/claude-statusline-backup.json');
      const codexWrapper = join(home, 'state/surplus/bin/codex');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, 'state/surplus/bin'), { recursive: true }));
      await writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: statuslineCommand() } }));
      await writeFile(codexWrapper, 'preexisting user wrapper');

      await expect(main(['install'])).rejects.toThrow(/Refusing to overwrite/);
      expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ statusLine: { type: 'command', command: statuslineCommand() } });
      expect(JSON.parse(await readFile(backupPath, 'utf8'))).toEqual({
        present: false, managedCommand: statuslineCommand(), settingsPath: settings,
      });
      await uninstallClaudeStatusLine();
      expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({});
    });
  });

  it('recovers the original command from a chained orphaned statusline', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      const backupPath = join(home, 'state/surplus/claude-statusline-backup.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      const original = 'printf original-status';
      await writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: statuslineCommand(original), padding: 8 } }));

      expect(await installClaudeStatusLine()).toBe(false);
      expect(JSON.parse(await readFile(backupPath, 'utf8'))).toEqual({
        present: true,
        value: { type: 'command', command: original },
        managedCommand: statuslineCommand(original),
        settingsPath: settings,
      });
      await uninstallClaudeStatusLine();
      expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ statusLine: { type: 'command', command: original, padding: 8 } });
    });
  });

  it('keeps the capture backup bound to the CLAUDE_CONFIG_DIR where it was installed', async () => {
    await withHome(async (home) => {
      const configDir = join(home, 'claude work profile');
      const settings = join(configDir, 'settings.json');
      const backupPath = join(home, 'state/surplus/claude-statusline-backup.json');
      process.env.CLAUDE_CONFIG_DIR = configDir;
      await import('node:fs/promises').then(({ mkdir }) => mkdir(configDir, { recursive: true }));
      const original = { type: 'command', command: 'echo original' };
      await writeFile(settings, JSON.stringify({ statusLine: original }));

      await installClaudeStatusLine();
      expect(JSON.parse(await readFile(backupPath, 'utf8'))).toMatchObject({ settingsPath: settings });
      process.env.CLAUDE_CONFIG_DIR = join(home, 'another profile');
      await expect(installClaudeStatusLine()).rejects.toThrow(/different CLAUDE_CONFIG_DIR/);
      await expect(uninstallClaudeStatusLine()).rejects.toThrow(/different CLAUDE_CONFIG_DIR/);
      expect(JSON.parse(await readFile(settings, 'utf8'))).not.toEqual({ statusLine: original });

      process.env.CLAUDE_CONFIG_DIR = configDir;
      await uninstallClaudeStatusLine();
      expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ statusLine: original });
    });
  });

  it('refuses to nest an orphaned capture from a different Surplus installation', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      const oldCommand = "'/old/node' '/old/cli.js' capture claude --original=b2xk";
      await writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: oldCommand } }));

      await expect(installClaudeStatusLine()).rejects.toThrow(/another installation has no ownership backup/);
      expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ statusLine: { type: 'command', command: oldCommand } });
    });
  });

  it('restores the exact prior statusline backup when settings cannot be updated', async () => {
    await withHome(async (home) => {
      const settingsPath = join(home, '.claude', 'settings.json');
      const settingsDirectory = join(home, '.claude');
      const backupPath = join(home, 'state/surplus/claude-statusline-backup.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(settingsDirectory, { recursive: true }));
      await writeFile(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'original', padding: 8 } }));
      await installClaudeStatusLine();
      const firstBackup = JSON.parse(await readFile(backupPath, 'utf8')) as { present: boolean; value: unknown; managedCommand: string };
      const oldCommand = '/old/node /old/cli.js capture claude';
      const priorBackup = JSON.stringify({ ...firstBackup, managedCommand: oldCommand });
      const originalSettings = JSON.stringify({ statusLine: { type: 'command', command: oldCommand, padding: 16 } });
      await writeFile(backupPath, priorBackup);
      await writeFile(settingsPath, originalSettings);

      await chmod(settingsDirectory, 0o500);
      try { await expect(installClaudeStatusLine()).rejects.toThrow(); } finally { await chmod(settingsDirectory, 0o700); }

      expect(await readFile(backupPath, 'utf8')).toBe(priorBackup);
      expect(await readFile(settingsPath, 'utf8')).toBe(originalSettings);
    });
  });

  it('removes a newly-created backup when the first statusline settings write fails', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      const backup = join(home, 'state/surplus/claude-statusline-backup.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      await symlink(join(home, 'missing-settings-target'), settings);
      await expect(installClaudeStatusLine()).rejects.toThrow();
      await expect(readFile(backup, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(settings)).isSymbolicLink()).toBe(true);
    });
  });

  it('fails uninstall visibly when Claude settings are malformed, before shell cleanup', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      const shell = join(home, '.zshrc');
      await installClaudeStatusLine();
      await installShell();
      await writeFile(settings, '{broken');
      await expect(main(['uninstall'])).rejects.toThrow(/Claude settings.json is malformed/);
      expect(await readFile(shell, 'utf8')).toContain('surplus managed block');
    });
  });

  it('fails uninstall visibly when the Claude backup is malformed, before shell cleanup', async () => {
    await withHome(async (home) => {
      const backup = join(home, 'state/surplus/claude-statusline-backup.json');
      const shell = join(home, '.zshrc');
      await installClaudeStatusLine();
      await installShell();
      await writeFile(backup, '{broken');
      await expect(main(['uninstall'])).rejects.toThrow(/backup is malformed/);
      expect(await readFile(shell, 'utf8')).toContain('surplus managed block');
    });
  });

  it('restores only owned Claude statusline fields and keeps later padding edits', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, '.claude'), { recursive: true }));
      await writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: 'user-line', padding: 8, keep: false } }));
      await installClaudeStatusLine();
      const installed = JSON.parse(await readFile(settings, 'utf8')) as { statusLine: Record<string, unknown> };
      await writeFile(settings, JSON.stringify({ statusLine: {
        type: installed.statusLine.type, command: installed.statusLine.command, padding: 16, laterEdit: 'keep',
      } }));
      await uninstallClaudeStatusLine();
      const restored = JSON.parse(await readFile(settings, 'utf8')) as { statusLine: Record<string, unknown> };
      expect(restored.statusLine).toEqual({ type: 'command', command: 'user-line', padding: 16, laterEdit: 'keep' });
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

  it('keeps later non-owned fields when uninstalling a newly-added statusline', async () => {
    await withHome(async (home) => {
      const settings = join(home, '.claude', 'settings.json');
      await installClaudeStatusLine();
      const installed = JSON.parse(await readFile(settings, 'utf8')) as { statusLine: Record<string, unknown> };
      await writeFile(settings, JSON.stringify({ statusLine: { ...installed.statusLine, padding: 12 } }));
      await uninstallClaudeStatusLine();
      const current = JSON.parse(await readFile(settings, 'utf8')) as { statusLine: Record<string, unknown> };
      expect(current.statusLine).toEqual({ padding: 12 });
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

  it('updates the config target through its symlink without replacing the link', async () => {
    await withHome(async (home) => {
      const path = configPath();
      const target = join(home, 'shared-config.json');
      await writeFile(target, '{}\n');
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, 'config', 'surplus'), { recursive: true }));
      await symlink(target, path);

      await saveConfig(defaultConfig);

      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(defaultConfig);
    });
  });

  it('keeps commands after an EOF managed block on their own line and remains idempotent', async () => {
    await withHome(async (home) => {
      const rc = join(home, '.zshrc');
      const blockWithoutFinalNewline = '# >>> surplus managed block >>>\nexport PATH=/old/surplus:"$PATH"\n# <<< surplus managed block <<<';
      await writeFile(rc, `${blockWithoutFinalNewline}echo user-command\n`);

      await installShell();
      const installed = await readFile(rc, 'utf8');
      expect(installed).toContain('# <<< surplus managed block <<<\necho user-command\n');
      await installShell();
      expect(await readFile(rc, 'utf8')).toBe(installed);
      await uninstallShell();
      expect(await readFile(rc, 'utf8')).toBe('echo user-command\n');
    });
  });

  it('does not replace a broken config symlink', async () => {
    await withHome(async (home) => {
      const path = configPath();
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, 'config', 'surplus'), { recursive: true }));
      await symlink(join(home, 'missing-config-target.json'), path);

      await expect(saveConfig(defaultConfig)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
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
