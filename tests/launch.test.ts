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
    expect(hasExplicitOverride('claude', ['--', '--model', 'literal prompt'])).toBe(false);
    expect(hasExplicitOverride('claude', ['--', '--profile=literal prompt'])).toBe(false);
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
