import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEffort, appendModel, findExecutable, hasExplicitOverride, shouldAutomaticallyRoute } from '../src/core/launch.js';

describe('provider executable lookup', () => {
  it('skips the managed wrapper path without HOME and finds the real provider', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'surplus-launch-'));
    try {
      const home = join(fixture, 'home');
      const managedBin = join(home, '.local', 'state', 'surplus', 'bin');
      const providerBin = join(fixture, 'provider-bin');
      await Promise.all([mkdir(managedBin, { recursive: true }), mkdir(providerBin)]);
      const managedWrapper = join(managedBin, 'codex');
      const realProvider = join(providerBin, 'codex');
      await writeFile(managedWrapper, '#!/bin/sh\nexit 99\n');
      await chmod(managedWrapper, 0o755);
      await writeFile(realProvider, '#!/bin/sh\nexit 0\n');
      await chmod(realProvider, 0o755);

      const found = await findExecutable('codex', { PATH: [managedBin, providerBin].join(':') }, home);

      expect(found).toBe(realProvider);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('skips a directory named like the provider and finds the executable later in PATH', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'surplus-launch-path-'));
    try {
      const directoryBin = join(fixture, 'directory-bin');
      const providerBin = join(fixture, 'provider-bin');
      await Promise.all([mkdir(join(directoryBin, 'codex'), { recursive: true }), mkdir(providerBin)]);
      const realProvider = join(providerBin, 'codex');
      await writeFile(realProvider, '#!/bin/sh\nexit 0\n');
      await chmod(realProvider, 0o755);

      const found = await findExecutable('codex', { PATH: [directoryBin, providerBin].join(':') }, fixture);

      expect(found).toBe(realProvider);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

describe('launch argument preservation', () => {
  it('does not override explicit model, profile, effort, or scripted invocation choices', () => {
    for (const args of [['--model', 'sonnet'], ['-mopus'], ['--effort=low'], ['--profile=work'], ['--resume', 'id'], ['-rSESSION'], ['--print'], ['--settings', 'x.json'], ['--settings=x.json'], ['--agent=worker'], ['--environment', 'local'], ['--exec', 'prompt'], ['--desktop'], ['auto-mode'], ['--debug', 'gateway'], ['purge'], ['self-hosted-runner', 'setup'], ['remote-control'], ['daemon', 'status'], ['--init-only']]) {
      expect(hasExplicitOverride('claude', args)).toBe(true);
    }
    for (const args of [['--model', 'gpt'], ['-p', 'work'], ['--config', 'model="gpt"'], ['-cmodel="gpt"'], ['exec', 'prompt']]) {
      expect(hasExplicitOverride('codex', args)).toBe(true);
    }
    for (const args of [['--sandbox', 'read-only', 'exec', 'prompt'], ['-s', 'read-only', 'e', 'prompt'], ['apply'], ['--oss'], ['--local-provider', 'ollama'], ['--remote', 'wss://example.test']]) {
      expect(hasExplicitOverride('codex', args)).toBe(true);
    }
    for (const utility of ['tcp-tunnel', 'execpolicy', 'responses-api-proxy', 'stdio-to-uds']) {
      expect(hasExplicitOverride('codex', [utility])).toBe(true);
    }
    expect(hasExplicitOverride('claude', ['--', '--model', 'literal prompt'])).toBe(false);
    expect(hasExplicitOverride('claude', ['--', '--profile=literal prompt'])).toBe(false);
  });

  it('classifies only Claude command position and skips option values', () => {
    expect(hasExplicitOverride('claude', ['doctor'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--append-system-prompt', 'doctor'])).toBe(false);
    expect(hasExplicitOverride('claude', ['--append-system-prompt=doctor'])).toBe(false);
    expect(hasExplicitOverride('claude', ['--append-system-prompt', 'instructions', 'doctor'])).toBe(true);
    expect(hasExplicitOverride('claude', ['a normal prompt', 'doctor'])).toBe(false);
    expect(hasExplicitOverride('claude', ['--append-system-prompt', 'instructions', '--', 'doctor'])).toBe(false);
    expect(hasExplicitOverride('claude', ['--allowedTools', 'doctor'])).toBe(false);
  });

  it('recognizes Claude daemon only in the documented argument position', () => {
    expect(hasExplicitOverride('claude', ['daemon', 'status'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--dangerously-skip-permissions', 'daemon', 'status'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--allow-dangerously-skip-permissions', 'daemon', 'status'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--append-system-prompt', 'instructions', 'daemon', 'status'])).toBe(false);
    expect(hasExplicitOverride('claude', ['--append-system-prompt=instructions', 'daemon', 'status'])).toBe(false);
    expect(hasExplicitOverride('claude', ['--dangerously-skip-permissions', '--append-system-prompt', 'instructions', 'daemon'])).toBe(false);
  });

  it('treats repeatable plugin options as one path per flag', () => {
    expect(hasExplicitOverride('claude', ['--plugin-dir', 'path', 'doctor'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--plugin-dir=path', 'doctor'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--plugin-dir', 'first', '--plugin-dir', 'second', 'doctor'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--plugin-dir', 'doctor'])).toBe(false);
    expect(hasExplicitOverride('claude', ['--plugin-url', 'https://example.test/plugin.zip', 'doctor'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--plugin-url=https://example.test/plugin.zip', 'doctor'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--plugin-url', 'first', '--plugin-url', 'second', 'doctor'])).toBe(true);
    expect(hasExplicitOverride('claude', ['--plugin-url', 'doctor'])).toBe(false);
  });

  it('adds model and effort flags only when requested', () => {
    expect(appendModel('claude', 'opus', ['folder'])).toEqual(['--model', 'opus', 'folder']);
    expect(appendEffort('codex', 'high', ['task'])).toEqual(['-c', 'model_reasoning_effort="high"', 'task']);
    expect(appendModel('codex', 'auto', ['task'])).toEqual(['task']);
  });

  it('leaves custom Claude auth credentials and endpoints untouched', () => {
    expect(hasExplicitOverride('claude', [], { ANTHROPIC_AUTH_TOKEN: 'present' })).toBe(true);
    expect(hasExplicitOverride('claude', [], { ANTHROPIC_BASE_URL: 'https://gateway.example' })).toBe(true);
  });

  it('only enables automatic selection for a fully interactive terminal', () => {
    expect(shouldAutomaticallyRoute(true, true)).toBe(true);
    expect(shouldAutomaticallyRoute(false, true)).toBe(false);
    expect(shouldAutomaticallyRoute(true, false)).toBe(false);
    expect(shouldAutomaticallyRoute(undefined, undefined)).toBe(false);
    expect(shouldAutomaticallyRoute(true, true, 'win32')).toBe(false);
  });
});
