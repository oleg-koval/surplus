import { describe, expect, it } from 'vitest';
import { appendEffort, appendModel, hasExplicitOverride } from '../src/core/launch.js';

describe('launch argument preservation', () => {
  it('does not override explicit model, profile, effort, or scripted invocation choices', () => {
    for (const args of [['--model', 'sonnet'], ['-mopus'], ['--effort=low'], ['--resume', 'id'], ['--print'], ['--settings', 'x.json']]) {
      expect(hasExplicitOverride('claude', args)).toBe(true);
    }
    for (const args of [['--model', 'gpt'], ['-p', 'work'], ['--config', 'model="gpt"'], ['exec', 'prompt']]) {
      expect(hasExplicitOverride('codex', args)).toBe(true);
    }
    expect(hasExplicitOverride('claude', ['--', '--model', 'literal prompt'])).toBe(false);
  });

  it('adds model and effort flags only when requested', () => {
    expect(appendModel('claude', 'opus', ['folder'])).toEqual(['--model', 'opus', 'folder']);
    expect(appendEffort('codex', 'high', ['task'])).toEqual(['-c', 'model_reasoning_effort="high"', 'task']);
    expect(appendModel('codex', 'auto', ['task'])).toEqual(['task']);
  });
});
