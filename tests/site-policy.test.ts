import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/files.js';
import { decide } from '../src/core/policy.js';

describe('website policy demo', () => {
  it.each([
    { weekly: 40, hours: 24, session: 80, allowed: true, fresh: true, weeklyOnly: false },
    { weekly: 18, hours: 24, session: 80, allowed: true, fresh: true, weeklyOnly: false },
    { weekly: 29, hours: 108, session: 80, allowed: true, fresh: true, weeklyOnly: false },
    { weekly: 85, hours: 120, session: 80, allowed: true, fresh: true, weeklyOnly: false },
    { weekly: 80, hours: 120, session: 80, allowed: true, fresh: true, weeklyOnly: false },
    { weekly: 40, hours: 24, session: 10, allowed: true, fresh: true, weeklyOnly: false },
    { weekly: 40, hours: 24, session: 10, allowed: true, fresh: true, weeklyOnly: true },
    { weekly: 40, hours: 24, session: 80, allowed: false, fresh: true, weeklyOnly: false },
    { weekly: 40, hours: 24, session: 80, allowed: true, fresh: false, weeklyOnly: false },
    { weekly: 40, hours: 0, session: 80, allowed: true, fresh: true, weeklyOnly: false },
    { weekly: 90, hours: 160, session: 80, allowed: true, fresh: true, weeklyOnly: false },
  ])('matches the CLI for %j', async sample => {
    const elements = new Map<string, { value: string; checked: boolean; textContent: string; disabled: boolean; content: string; classList: { toggle: () => void }; addEventListener: () => void; setAttribute: () => void }>();
    const element = (selector: string) => {
      if (!elements.has(selector)) elements.set(selector, { value: '', checked: false, textContent: '', disabled: false, content: '', classList: { toggle() {} }, addEventListener() {}, setAttribute() {} });
      return elements.get(selector)!;
    };
    for (const key of ['weekly', 'hours', 'session'] as const) element(`#${key}`).value = String(sample[key]);
    for (const key of ['allowed', 'fresh', 'weeklyOnly'] as const) element(`#${key}`).checked = sample[key];
    const context = createContext({
      document: { querySelector: element, querySelectorAll: () => [], documentElement: { dataset: {} } },
      localStorage: { getItem: () => null }, matchMedia: () => ({ matches: false }),
    });
    runInContext(await readFile('docs/site.js', 'utf8'), context);
    const now = new Date('2026-10-09T12:00:00Z');
    const expected = decide({ now, config: defaultConfig.providers.codex, usage: {
      provider: 'codex', observedAt: new Date(now.getTime() - (sample.fresh ? 0 : 10 * 60_000)).toISOString(),
      weeklyUsedPercent: 100 - sample.weekly,
      resetsAt: new Date(now.getTime() + sample.hours * 3_600_000).toISOString(),
      usageAllowed: sample.allowed, windowMinutes: 10080,
      sessionWindow: sample.weeklyOnly ? 'absent' : 'available',
      ...(sample.weeklyOnly ? {} : { sessionUsedPercent: 100 - sample.session, sessionResetsAt: new Date(now.getTime() + 3_600_000).toISOString() }),
    } });
    expect(element('#resultTitle').textContent).toBe(expected.tier === 'premium' ? 'Premium window' : 'Use provider default');
    expect(element('#session').disabled).toBe(sample.weeklyOnly);
  });
});
