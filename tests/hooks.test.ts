import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { defaultFeatures, readConfig } from '../src/core/files.js';
import { codexHooksPath, hookCommand, syncHooks, uninstallHooks } from '../src/install/hooks.js';
import { claudeSettingsPath } from '../src/install/shell.js';

const homes: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const setEnv = (key: string, value: string | undefined): void => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
};

const withHome = async (run: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), 'surplus-hooks-'));
  homes.push(home);
  setEnv('HOME', home);
  setEnv('SHELL', '/bin/zsh');
  setEnv('ZDOTDIR', join(home, 'zdot'));
  setEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
  setEnv('CODEX_HOME', join(home, 'codex'));
  setEnv('XDG_STATE_HOME', join(home, 'state'));
  setEnv('XDG_CONFIG_HOME', join(home, 'config'));
  await run(home);
};

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  savedEnv.clear();
});

const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
const foreign = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'lint' }] }] }, theme: 'dark' };
const sessionStartEntries = (root: Record<string, unknown>): unknown[] => (root.hooks as Record<string, unknown[]>).SessionStart ?? [];

describe('hook install', () => {
  it('creates both files with only the enabled events, idempotently', async () => {
    await withHome(async () => {
      await syncHooks(defaultFeatures);
      const claude = await readJson(claudeSettingsPath());
      const codex = await readJson(codexHooksPath());
      expect(claude).toEqual({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('claude', 'session-start') }] }] } });
      expect(codex).toEqual({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('codex', 'session-start') }] }] } });
      const before = await readFile(claudeSettingsPath(), 'utf8');
      expect(await syncHooks(defaultFeatures)).toEqual([]);
      expect(await readFile(claudeSettingsPath(), 'utf8')).toBe(before);
      await syncHooks({ ...defaultFeatures, promptNudge: true });
      const both = await readJson(claudeSettingsPath());
      expect(Object.keys(both.hooks as object).sort()).toEqual(['SessionStart', 'UserPromptSubmit']);
      await syncHooks({ ...defaultFeatures, sessionNotice: false });
      expect(await readJson(claudeSettingsPath())).toEqual({});
    });
  });

  it('preserves foreign hooks and settings and removes only its own entries', async () => {
    await withHome(async () => {
      await mkdir(join(process.env.CLAUDE_CONFIG_DIR ?? '', '..', 'claude'), { recursive: true });
      await writeFile(claudeSettingsPath(), JSON.stringify(foreign));
      await mkdir(join(process.env.CODEX_HOME ?? ''), { recursive: true });
      await writeFile(codexHooksPath(), JSON.stringify(foreign));
      await syncHooks({ ...defaultFeatures, promptNudge: true });
      const installed = await readJson(claudeSettingsPath());
      expect(installed.theme).toBe('dark');
      expect(sessionStartEntries(installed)).toHaveLength(2);
      expect(sessionStartEntries(installed)[0]).toEqual(foreign.hooks.SessionStart[0]);
      await uninstallHooks();
      expect(await readJson(claudeSettingsPath())).toEqual(foreign);
      expect(await readJson(codexHooksPath())).toEqual(foreign);
    });
  });

  it('refreshes the command when the node or cli path changed', async () => {
    await withHome(async () => {
      const stale = "'/old/node' '/old/cli.js' hook claude session-start";
      await mkdir(process.env.CLAUDE_CONFIG_DIR ?? '', { recursive: true });
      await writeFile(claudeSettingsPath(), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: stale, timeout: 9 }] }] } }));
      await syncHooks(defaultFeatures);
      const entries = sessionStartEntries(await readJson(claudeSettingsPath()));
      expect(entries).toEqual([{ hooks: [{ type: 'command', command: hookCommand('claude', 'session-start'), timeout: 9 }] }]);
    });
  });

  it('does not touch lookalike commands and fails closed on malformed or non-object files', async () => {
    await withHome(async () => {
      await mkdir(process.env.CLAUDE_CONFIG_DIR ?? '', { recursive: true });
      const lookalike = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node cli.js hook claude session-start' }] }] } };
      await writeFile(claudeSettingsPath(), JSON.stringify(lookalike));
      await uninstallHooks();
      expect(await readJson(claudeSettingsPath())).toEqual(lookalike);
      for (const bad of ['{nope', '[]', JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { SessionStart: {} } })]) {
        await writeFile(claudeSettingsPath(), bad);
        await expect(syncHooks(defaultFeatures)).rejects.toThrow(/refusing to edit|malformed/);
        expect(await readFile(claudeSettingsPath(), 'utf8')).toBe(bad);
      }
    });
  });

  it('rolls back the first file when the second one fails', async () => {
    await withHome(async () => {
      await mkdir(process.env.CODEX_HOME ?? '', { recursive: true });
      await writeFile(codexHooksPath(), '{broken');
      await expect(syncHooks(defaultFeatures)).rejects.toThrow(/malformed/);
      await expect(readFile(claudeSettingsPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});

describe('install and uninstall commands', () => {
  it('installs hooks after the statusline, honours --no-hooks, and uninstall restores the files', async () => {
    await withHome(async () => {
      await mkdir(process.env.CLAUDE_CONFIG_DIR ?? '', { recursive: true });
      const original = `${JSON.stringify(foreign, null, 2)}\n`;
      await writeFile(claudeSettingsPath(), original);
      await main(['install', '--no-hooks']);
      expect((await readJson(claudeSettingsPath())).hooks).toEqual(foreign.hooks);
      await expect(readFile(codexHooksPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await main(['uninstall']);
      await main(['install']);
      expect(sessionStartEntries(await readJson(claudeSettingsPath()))).toHaveLength(2);
      expect(sessionStartEntries(await readJson(codexHooksPath()))).toHaveLength(1);
      await main(['uninstall']);
      expect(await readJson(claudeSettingsPath())).toEqual(foreign);
      expect(await readJson(codexHooksPath())).toEqual({});
    });
  });

  it('rolls back the statusline when hook install fails', async () => {
    await withHome(async () => {
      await mkdir(process.env.CODEX_HOME ?? '', { recursive: true });
      await writeFile(codexHooksPath(), '{broken');
      await expect(main(['install'])).rejects.toThrow(/malformed/);
      const settings = await readFile(claudeSettingsPath(), 'utf8').catch(() => '{}');
      expect(JSON.parse(settings)).toEqual({});
      expect(JSON.stringify(JSON.parse(settings))).not.toMatch(/capture claude/);
    });
  });

  it('configure features saves the config and re-syncs hooks', async () => {
    await withHome(async () => {
      await main(['configure', 'features', '--prompt-nudge', 'on', '--session-notice', 'off', '--statusline-segment', 'on']);
      expect((await readConfig()).features).toEqual({ sessionNotice: false, promptNudge: true, statuslineSegment: true });
      const root = await readJson(claudeSettingsPath());
      expect(Object.keys(root.hooks as object)).toEqual(['UserPromptSubmit']);
      await expect(main(['configure', 'features', '--prompt-nudge', 'maybe'])).rejects.toThrow(/on or off/);
    });
  });
});
