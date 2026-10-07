import { describe, expect, it } from 'vitest';
import { appendEffort, appendModel, hasExplicitOverride, launchProvider, shouldAutomaticallyRoute } from '../src/core/launch.js';

describe('launch argument preservation', () => {
  it('does not override explicit model, profile, effort, or scripted invocation choices', () => {
    for (const args of [['--model', 'sonnet'], ['-mopus'], ['--effort=low'], ['--profile=work'], ['--resume', 'id'], ['-rSESSION'], ['--print'], ['--settings', 'x.json'], ['--settings=x.json'], ['--agent=worker'], ['--environment', 'local'], ['--exec', 'prompt'], ['--desktop'], ['auto-mode'], ['--debug', 'gateway']]) {
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
  });

  it('preserves the operating system signal exit code for provider processes', async () => {
    await expect(launchProvider('claude', ['-e', "process.kill(process.pid, 'SIGKILL')"], { SURPLUS_CLAUDE_BIN: process.execPath })).resolves.toBe(137);
  });
});
