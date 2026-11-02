import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFeatures } from '../src/core/files.js';
import { codexHooksPath, hookCommand, syncHooks, uninstallHooks } from '../src/install/hooks.js';
import { resilientCaptureCommand, resilientHookCommand } from '../src/install/launcher.js';
import { claudeSettingsPath, installClaudeStatusLine, statuslineCommand, uninstallClaudeStatusLine } from '../src/install/shell.js';

const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const setEnv = (key: string, value: string | undefined): void => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
};

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  savedEnv.clear();
});

const withHome = async (run: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'surplus-resilient-'));
  roots.push(home);
  setEnv('HOME', home);
  setEnv('SHELL', '/bin/zsh');
  setEnv('ZDOTDIR', join(home, 'zdot'));
  setEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
  setEnv('CODEX_HOME', join(home, 'codex'));
  setEnv('XDG_STATE_HOME', join(home, 'state'));
  setEnv('XDG_CONFIG_HOME', join(home, 'config'));
  await mkdir(join(home, 'claude'), { recursive: true });
  await run(home);
};

const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

interface Sandbox {
  readonly root: string;
  readonly missingNode: string;
  readonly cli: string;
  /** Runs a command with a PATH holding only the given extra directories plus base64 and cat. */
  readonly run: (command: string, pathDirs: readonly string[], input?: string) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };
  /** Creates an executable that prints its own name and arguments, then echoes stdin. */
  readonly fake: (directory: string, name: string) => Promise<string>;
}

const sandbox = async (): Promise<Sandbox> => {
  const root = await mkdtemp(join(tmpdir(), 'surplus-launcher-'));
  roots.push(root);
  const tools = join(root, 'tools');
  await mkdir(tools);
  for (const tool of ['/usr/bin/base64', '/bin/cat']) await symlink(tool, join(tools, tool.split('/').pop() ?? tool));
  const cli = join(root, 'cli.js');
  await writeFile(cli, '// fake cli\n');
  return {
    root, cli, missingNode: join(root, 'fnm', 'v24.18.0', 'bin', 'node'),
    run: (command, pathDirs, input = '') => {
      const result = spawnSync('/bin/sh', ['-c', command], { env: { PATH: [...pathDirs, tools].join(':') }, input, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    fake: async (directory, name) => {
      await mkdir(directory, { recursive: true });
      const path = join(directory, name);
      await writeFile(path, `#!/bin/sh\nprintf '%s:%s\\n' ${name} "$*"; cat\n`);
      await chmod(path, 0o755);
      return path;
    },
  };
};

describe('resilient hook command', () => {
  it('stays silent and exits 0 when the recorded node and every PATH node are gone', async () => {
    const box = await sandbox();
    const result = box.run(resilientHookCommand('claude', 'session-start', box.missingNode, box.cli), []);
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('falls back to the node on PATH and forwards stdin when the recorded node is gone', async () => {
    const box = await sandbox();
    await box.fake(join(box.root, 'path'), 'node');
    const result = box.run(resilientHookCommand('claude', 'prompt-submit', box.missingNode, box.cli), [join(box.root, 'path')], '{"session_id":"s"}');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`node:${box.cli} hook claude prompt-submit\n{"session_id":"s"}`);
  });

  it('prefers the recorded node over the one on PATH', async () => {
    const box = await sandbox();
    const recorded = await box.fake(join(box.root, 'fnm'), 'node');
    await box.fake(join(box.root, 'path'), 'node');
    const result = box.run(resilientHookCommand('codex', 'session-start', recorded, box.cli), [join(box.root, 'path')]);
    expect(result.stdout).toBe(`node:${box.cli} hook codex session-start\n`);
  });

  it('runs surplus from PATH when the recorded CLI file has moved away', async () => {
    const box = await sandbox();
    const recorded = await box.fake(join(box.root, 'fnm'), 'node');
    await box.fake(join(box.root, 'path'), 'surplus');
    const result = box.run(resilientHookCommand('claude', 'session-start', recorded, join(box.root, 'moved', 'cli.js')), [join(box.root, 'path')]);
    expect(result.stdout).toBe('surplus:hook claude session-start\n');
  });

  it('exits 0 and emits nothing extra when node itself crashes', async () => {
    const box = await sandbox();
    const crashing = join(box.root, 'node');
    await writeFile(crashing, '#!/bin/sh\nexit 7\n');
    await chmod(crashing, 0o755);
    expect(box.run(resilientHookCommand('claude', 'session-start', crashing, box.cli), []).status).toBe(0);
  });

  it('survives quotes in the recorded paths', async () => {
    const box = await sandbox();
    const odd = await box.fake(join(box.root, "it's here"), 'node');
    const result = box.run(resilientHookCommand('claude', 'session-start', odd, box.cli), []);
    expect(result.stdout).toBe(`node:${box.cli} hook claude session-start\n`);
  });
});

describe('resilient statusline capture command', () => {
  const original = "printf '%s' \"it's $HOME\" | tr a-z A-Z";
  const encoded = Buffer.from(original).toString('base64');

  it('passes the encoded original to the CLI when node and the CLI exist', async () => {
    const box = await sandbox();
    const recorded = await box.fake(join(box.root, 'fnm'), 'node');
    expect(box.run(resilientCaptureCommand(recorded, box.cli, encoded), []).stdout).toBe(`node:${box.cli} capture claude --original=${encoded}\n`);
    expect(box.run(resilientCaptureCommand(recorded, box.cli), []).stdout).toBe(`node:${box.cli} capture claude\n`);
  });

  it('runs the user original statusline directly with stdin when node is gone', async () => {
    const box = await sandbox();
    const tr = join(box.root, 'path');
    await mkdir(tr);
    await symlink('/usr/bin/tr', join(tr, 'tr'));
    const command = Buffer.from('cat | tr a-z A-Z').toString('base64');
    const result = box.run(resilientCaptureCommand(box.missingNode, box.cli, command), [tr], 'status line');
    expect(result).toEqual({ status: 0, stdout: 'STATUS LINE', stderr: '' });
  });

  it('prints nothing and exits 0 when node is gone and there is no original to run', async () => {
    const box = await sandbox();
    expect(box.run(resilientCaptureCommand(box.missingNode, box.cli), [])).toEqual({ status: 0, stdout: '', stderr: '' });
  });

  it('falls back to the original when only the CLI file is gone and no surplus is on PATH', async () => {
    const box = await sandbox();
    const recorded = await box.fake(join(box.root, 'fnm'), 'node');
    const command = Buffer.from('printf kept').toString('base64');
    const result = box.run(resilientCaptureCommand(recorded, join(box.root, 'moved', 'cli.js'), command), []);
    expect(result.stdout).toBe('kept');
  });
});

describe('migrating installed commands', () => {
  const legacyHook = (event: string): string => `'/gone/fnm/v24.18.0/bin/node' '/gone/lib/cli.js' hook claude ${event}`;

  it('rewrites a legacy hook that points at a vanished node, keeping foreign and user fields', async () => {
    await withHome(async () => {
      const foreign = { type: 'command', command: 'echo mine' };
      await writeFile(claudeSettingsPath(), JSON.stringify({
        theme: 'dark',
        hooks: { SessionStart: [{ matcher: 'startup', hooks: [foreign, { type: 'command', command: legacyHook('session-start'), timeout: 9 }] }] },
      }));
      await syncHooks(defaultFeatures);
      const migrated = await readJson(claudeSettingsPath());
      expect(migrated.theme).toBe('dark');
      const group = (migrated.hooks as { SessionStart: { matcher: string; hooks: unknown[] }[] }).SessionStart[0];
      expect(group?.matcher).toBe('startup');
      expect(group?.hooks).toEqual([foreign, { type: 'command', command: hookCommand('claude', 'session-start'), timeout: 9 }]);
      const before = await readFile(claudeSettingsPath(), 'utf8');
      await syncHooks(defaultFeatures);
      expect(await readFile(claudeSettingsPath(), 'utf8')).toBe(before);
      expect(hookCommand('claude', 'session-start')).toContain('command -v node');
    });
  });

  it('recognizes the resilient command on uninstall and when the node path changes, without duplicating it', async () => {
    await withHome(async () => {
      const stale = resilientHookCommand('claude', 'session-start', '/gone/node', '/gone/cli.js');
      await writeFile(claudeSettingsPath(), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: stale }] }] } }));
      await syncHooks(defaultFeatures);
      const groups = ((await readJson(claudeSettingsPath())).hooks as { SessionStart: unknown[] }).SessionStart;
      expect(groups).toEqual([{ hooks: [{ type: 'command', command: hookCommand('claude', 'session-start') }] }]);
      await uninstallHooks();
      expect(await readJson(claudeSettingsPath())).toEqual({});
      expect(await readJson(codexHooksPath())).toEqual({});
    });
  });

  it('does not claim a command that merely starts like ours', async () => {
    await withHome(async () => {
      const lookalike = `${hookCommand('claude', 'session-start')} && curl example.invalid`;
      const root = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: lookalike }] }] } };
      await writeFile(claudeSettingsPath(), JSON.stringify(root));
      await uninstallHooks();
      expect(await readJson(claudeSettingsPath())).toEqual(root);
    });
  });

  it('upgrades an owned legacy statusline to the resilient one and restores the user original on uninstall', async () => {
    await withHome(async (home) => {
      const settings = claudeSettingsPath();
      const backupPath = join(home, 'state/surplus/claude-statusline-backup.json');
      const userStatusline = { type: 'command', command: 'echo original', padding: 4 };
      await writeFile(settings, JSON.stringify({ statusLine: userStatusline }));
      await installClaudeStatusLine();
      const backup = await readJson(backupPath);
      const legacy = `'/gone/fnm/v24.18.0/bin/node' '/gone/lib/cli.js' capture claude --original=${Buffer.from('echo original').toString('base64')}`;
      await writeFile(backupPath, JSON.stringify({ ...backup, managedCommand: legacy }));
      await writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: legacy, padding: 4 } }));

      expect(await installClaudeStatusLine()).toBe(false);
      const upgraded = (await readJson(settings)).statusLine as { command: string; padding: number };
      expect(upgraded).toEqual({ type: 'command', command: statuslineCommand('echo original'), padding: 4 });
      expect(await installClaudeStatusLine()).toBe(false);
      expect((await readJson(settings)).statusLine).toEqual(upgraded);

      await uninstallClaudeStatusLine();
      expect((await readJson(settings)).statusLine).toEqual(userStatusline);
    });
  });

  it('keeps the user original restorable when a legacy capture command has no ownership backup', async () => {
    await withHome(async (home) => {
      const settings = claudeSettingsPath();
      await installClaudeStatusLine();
      const current = (await readJson(settings)).statusLine as { command: string };
      const cli = current.command.match(/C='([^']+)'/)?.[1] ?? '';
      const orphan = `'${process.execPath}' '${cli}' capture claude --original=${Buffer.from('echo mine').toString('base64')}`;
      await rm(join(home, 'state/surplus/claude-statusline-backup.json'));
      await writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: orphan } }));

      await installClaudeStatusLine();
      expect(((await readJson(settings)).statusLine as { command: string }).command).toBe(statuslineCommand('echo mine'));
      await uninstallClaudeStatusLine();
      expect((await readJson(settings)).statusLine).toEqual({ type: 'command', command: 'echo mine' });
    });
  });

  it('upgrades an owned resilient statusline recorded under another node path', async () => {
    await withHome(async (home) => {
      const settings = claudeSettingsPath();
      const backupPath = join(home, 'state/surplus/claude-statusline-backup.json');
      const userStatusline = { type: 'command', command: 'echo original' };
      await writeFile(settings, JSON.stringify({ statusLine: userStatusline }));
      await installClaudeStatusLine();
      const backup = await readJson(backupPath);
      const previous = resilientCaptureCommand('/gone/node', '/gone/cli.js', Buffer.from('echo original').toString('base64'));
      await writeFile(backupPath, JSON.stringify({ ...backup, managedCommand: previous }));
      await writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: previous } }));

      await installClaudeStatusLine();
      expect((await readJson(settings)).statusLine).toEqual({ type: 'command', command: statuslineCommand('echo original') });
      await uninstallClaudeStatusLine();
      expect((await readJson(settings)).statusLine).toEqual(userStatusline);
    });
  });

  it('still refuses to nest a resilient capture command from another installation that has no backup', async () => {
    await withHome(async () => {
      const foreignInstall = { type: 'command', command: resilientCaptureCommand('/gone/node', '/gone/cli.js', Buffer.from('echo original').toString('base64')) };
      await writeFile(claudeSettingsPath(), JSON.stringify({ statusLine: foreignInstall }));
      await expect(installClaudeStatusLine()).rejects.toThrow(/another installation has no ownership backup/);
      expect((await readJson(claudeSettingsPath())).statusLine).toEqual(foreignInstall);
    });
  });
});
