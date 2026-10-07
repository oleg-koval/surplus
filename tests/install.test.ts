import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { configPath, dataDir, defaultConfig, saveConfig } from '../src/core/files.js';
import { resolveHomeDirectory } from '../src/core/xdg.js';
import { installClaudeStatusLine, installShell, statuslineCommand, surplusExecutable, uninstallClaudeStatusLine, uninstallShell } from '../src/install/shell.js';

const tempHomes: string[] = [];
const withHome = async (run: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "surplus home '$ "));
  tempHomes.push(home);
  process.env.HOME = home;
  process.env.SHELL = '/bin/zsh';
  delete process.env.ZDOTDIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.XDG_STATE_HOME = join(home, 'state');
  process.env.XDG_CONFIG_HOME = join(home, 'config');
  await run(home);
};

afterEach(async () => {
  for (const home of tempHomes.splice(0)) await rm(home, { recursive: true, force: true });
  delete process.env.XDG_STATE_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.ZDOTDIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe('reversible install', () => {
  it('uses the operating-system home only when HOME is unset', () => {
    const previousHome = process.env.HOME;
    delete process.env.HOME;
    try {
      expect(resolveHomeDirectory()).toBe(homedir());
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('falls back from empty or relative XDG homes to absolute HOME-based paths', async () => {
    const originalCwd = process.cwd();
    await withHome(async (home) => {
      const workingDirectory = join(home, 'working');
      await mkdir(workingDirectory);
      process.chdir(workingDirectory);
      try {
        for (const [stateHome, configHome] of [['', ''], ['relative-state', 'relative-config']]) {
          process.env.XDG_STATE_HOME = stateHome;
          process.env.XDG_CONFIG_HOME = configHome;
          expect(dataDir()).toBe(join(home, '.local', 'state', 'surplus'));
          expect(configPath()).toBe(join(home, '.config', 'surplus', 'config.json'));
        }
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  it('rejects invalid HOME before shell writes even when XDG homes are absolute', async () => {
    await withHome(async (home) => {
      const stateHome = join(home, 'xdg-state');
      const configHome = join(home, 'xdg-config');
      process.env.XDG_STATE_HOME = stateHome;
      process.env.XDG_CONFIG_HOME = configHome;
      for (const invalidHome of ['', 'relative-home']) {
        process.env.HOME = invalidHome;
        expect(() => dataDir()).toThrow(/HOME must be a non-empty absolute path/);
        expect(() => configPath()).toThrow(/HOME must be a non-empty absolute path/);
        await expect(installShell()).rejects.toThrow(/HOME must be a non-empty absolute path/);
        await expect(readFile(join(stateHome, 'surplus', 'bin', 'claude'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(home, '.zshrc'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  });

  it('rejects relative ZDOTDIR values before editing startup files', async () => {
    await withHome(async (home) => {
      const customDir = join(home, 'relative-zsh');
      await mkdir(customDir);
      process.env.ZDOTDIR = 'relative-zsh';
      await expect(installShell()).rejects.toThrow(/ZDOTDIR must be a non-empty absolute path/);
      await expect(readFile(join(home, '.zshrc'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(home, 'state', 'surplus', 'bin', 'claude'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      delete process.env.ZDOTDIR;
      await writeFile(join(home, '.zshenv'), 'ZDOTDIR="relative-zsh"\n');
      await expect(installShell()).rejects.toThrow(/ZDOTDIR must be a non-empty absolute path/);
      await expect(readFile(join(customDir, '.zshrc'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(home, 'state', 'surplus', 'bin', 'claude'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('repairs missing execute permission only on exact Surplus wrappers', async () => {
    await withHome(async (home) => {
      const codexWrapper = join(home, 'state', 'surplus', 'bin', 'codex');
      const commandBin = join(home, 'command-bin');
      const argsPath = join(home, 'wrapper-args');
      await installShell();
      await chmod(codexWrapper, 0o641);

      await installShell();

      expect((await stat(codexWrapper)).mode & 0o100).not.toBe(0);
      await mkdir(commandBin);
      const fakeSurplus = join(commandBin, 'surplus');
      await writeFile(fakeSurplus, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SURPLUS_WRAPPER_ARGS"\n');
      await chmod(fakeSurplus, 0o755);
      const launched = spawnSync(codexWrapper, ['--model', 'fixture'], {
        encoding: 'utf8', env: { HOME: home, PATH: commandBin, SURPLUS_WRAPPER_ARGS: argsPath },
      });
      expect(launched.status).toBe(0);
      expect(await readFile(argsPath, 'utf8')).toBe('run\ncodex\n--model\nfixture\n');

      await writeFile(codexWrapper, '#!/bin/sh\n# user-owned\n');
      const editedMode = (await stat(codexWrapper)).mode & 0o777;
      await expect(installShell()).rejects.toThrow(/Refusing to overwrite/);
      expect(await readFile(codexWrapper, 'utf8')).toBe('#!/bin/sh\n# user-owned\n');
      expect((await stat(codexWrapper)).mode & 0o777).toBe(editedMode);
    });
  });

  it('skips a directory named surplus and finds the executable later in PATH', async () => {
    await withHome(async (home) => {
      const directoryBin = join(home, 'directory-bin');
      const providerBin = join(home, 'provider-bin');
      await Promise.all([mkdir(join(directoryBin, 'surplus'), { recursive: true }), mkdir(providerBin)]);
      const executable = join(providerBin, 'surplus');
      await writeFile(executable, '#!/bin/sh\nexit 0\n');
      await chmod(executable, 0o755);

      expect(await surplusExecutable({ PATH: [directoryBin, providerBin].join(':') })).toBe(executable);
    });
  });

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

  it('installs into ZDOTDIR and removes only its current and home startup blocks', async () => {
    await withHome(async (home) => {
      const zshDir = join(home, 'custom-zsh');
      const customRc = join(zshDir, '.zshrc');
      const homeRc = join(home, '.zshrc');
      await mkdir(zshDir);
      await writeFile(customRc, 'export CUSTOM_VALUE=kept\n');
      await writeFile(homeRc, 'export HOME_VALUE=untouched\n');
      process.env.ZDOTDIR = zshDir;

      await installShell();
      const installed = await readFile(customRc, 'utf8');
      expect(installed).toContain('export CUSTOM_VALUE=kept');
      expect(installed).toContain('surplus managed block');
      expect(await readFile(homeRc, 'utf8')).toBe('export HOME_VALUE=untouched\n');

      await uninstallShell();
      expect(await readFile(customRc, 'utf8')).toBe('export CUSTOM_VALUE=kept\n');
      expect(await readFile(homeRc, 'utf8')).toBe('export HOME_VALUE=untouched\n');
    });
  });

  it('resolves an unexported ZDOTDIR set by zshenv for install and uninstall', async () => {
    await withHome(async (home) => {
      const zshDir = join(home, 'custom-zsh');
      const customRc = join(zshDir, '.zshrc');
      const homeRc = join(home, '.zshrc');
      await mkdir(zshDir);
      await writeFile(join(home, '.zshenv'), 'ZDOTDIR="$HOME/custom-zsh"\n');
      await writeFile(customRc, 'export CUSTOM_VALUE=kept\n');
      await writeFile(homeRc, 'export HOME_VALUE=untouched\n');

      await installShell();
      expect(await readFile(customRc, 'utf8')).toContain('surplus managed block');
      expect(await readFile(homeRc, 'utf8')).toBe('export HOME_VALUE=untouched\n');

      process.env.SHELL = '/bin/bash';
      await uninstallShell();
      expect(await readFile(customRc, 'utf8')).toBe('export CUSTOM_VALUE=kept\n');
      expect(await readFile(homeRc, 'utf8')).toBe('export HOME_VALUE=untouched\n');
    });
  });

  it('activates Bash login and non-login shells without shadowing profile precedence', async () => {
    await withHome(async (home) => {
      process.env.SHELL = '/bin/bash';
      const bashrc = join(home, '.bashrc');
      const bashLogin = join(home, '.bash_login');
      const profile = join(home, '.profile');
      const bashBin = join(home, 'state', 'surplus', 'bin');
      await writeFile(bashrc, 'export BASHRC_VALUE=kept\n');
      await writeFile(bashLogin, 'export BASH_LOGIN_VALUE=kept\n');
      await writeFile(profile, 'export PROFILE_VALUE=untouched\n');

      await installShell();
      expect(await readFile(bashrc, 'utf8')).toContain('surplus managed block');
      expect(await readFile(bashLogin, 'utf8')).toContain('surplus managed block');
      expect(await readFile(profile, 'utf8')).toBe('export PROFILE_VALUE=untouched\n');
      await expect(readFile(join(home, '.bash_profile'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const env = { ...process.env, HOME: home };
      const nonLogin = spawnSync('/bin/bash', ['-ic', 'printf "%s" "$PATH"'], { encoding: 'utf8', env });
      const login = spawnSync('/bin/bash', ['--login', '-c', 'printf "%s" "$PATH"'], { encoding: 'utf8', env });
      expect(nonLogin.status).toBe(0);
      expect(nonLogin.stdout).toContain(bashBin);
      expect(login.status).toBe(0);
      expect(login.stdout).toContain(bashBin);

      await uninstallShell();
      expect(await readFile(bashrc, 'utf8')).toBe('export BASHRC_VALUE=kept\n');
      expect(await readFile(bashLogin, 'utf8')).toBe('export BASH_LOGIN_VALUE=kept\n');
      expect(await readFile(profile, 'utf8')).toBe('export PROFILE_VALUE=untouched\n');
    });
  });

  it('creates Bash login profile only when no supported profile exists', async () => {
    await withHome(async (home) => {
      process.env.SHELL = '/bin/bash';
      await installShell();

      expect(await readFile(join(home, '.bash_profile'), 'utf8')).toContain('surplus managed block');
      expect(await readFile(join(home, '.bashrc'), 'utf8')).toContain('surplus managed block');
      await expect(readFile(join(home, '.bash_login'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(home, '.profile'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('uninstalls Bash integration when zsh is not installed and no zshenv exists', async () => {
    await withHome(async (home) => {
      const originalPath = process.env.PATH;
      process.env.SHELL = '/bin/bash';
      try {
        await installShell();
        const pathWithoutZsh = join(home, 'path-without-zsh');
        await mkdir(pathWithoutZsh);
        process.env.PATH = pathWithoutZsh;

        await uninstallShell();

        expect(await readFile(join(home, '.bashrc'), 'utf8')).toBe('');
        expect(await readFile(join(home, '.bash_profile'), 'utf8')).toBe('');
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });
  });

  it('rolls back the first Bash startup write when the login profile write fails', async () => {
    await withHome(async (home) => {
      process.env.SHELL = '/bin/bash';
      const bashrc = join(home, '.bashrc');
      const profile = join(home, '.bash_profile');
      const protectedDir = join(home, 'protected');
      const protectedProfile = join(protectedDir, 'profile');
      await mkdir(protectedDir);
      await writeFile(bashrc, 'export BASHRC_VALUE=kept\n');
      await writeFile(protectedProfile, 'export PROFILE_VALUE=kept\n');
      await symlink(protectedProfile, profile);
      await chmod(protectedDir, 0o500);

      try {
        await expect(installShell()).rejects.toMatchObject({ code: 'EACCES' });
        expect(await readFile(bashrc, 'utf8')).toBe('export BASHRC_VALUE=kept\n');
        expect(await readFile(protectedProfile, 'utf8')).toBe('export PROFILE_VALUE=kept\n');
        await expect(readFile(join(home, 'state', 'surplus', 'bin', 'claude'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await chmod(protectedDir, 0o700);
      }
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

  it('clears stale ownership after a user edit so a new Claude profile can be installed', async () => {
    await withHome(async (home) => {
      const firstConfig = join(home, 'first profile');
      const firstSettings = join(firstConfig, 'settings.json');
      const backupPath = join(home, 'state/surplus/claude-statusline-backup.json');
      process.env.CLAUDE_CONFIG_DIR = firstConfig;
      await import('node:fs/promises').then(({ mkdir }) => mkdir(firstConfig, { recursive: true }));
      const original = { type: 'command', command: 'echo original' };
      await writeFile(firstSettings, JSON.stringify({ statusLine: original }));
      await installClaudeStatusLine();

      const userEdit = { type: 'command', command: 'echo my-statusline', padding: 12 };
      await writeFile(firstSettings, JSON.stringify({ statusLine: userEdit }));
      await uninstallClaudeStatusLine();
      expect(JSON.parse(await readFile(firstSettings, 'utf8'))).toEqual({ statusLine: userEdit });
      await expect(readFile(backupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const secondConfig = join(home, 'second profile');
      const secondSettings = join(secondConfig, 'settings.json');
      process.env.CLAUDE_CONFIG_DIR = secondConfig;
      await import('node:fs/promises').then(({ mkdir }) => mkdir(secondConfig, { recursive: true }));
      await writeFile(secondSettings, JSON.stringify({ statusLine: original }));
      await expect(installClaudeStatusLine()).resolves.toBe(true);
      await uninstallClaudeStatusLine();
      expect(JSON.parse(await readFile(secondSettings, 'utf8'))).toEqual({ statusLine: original });
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
