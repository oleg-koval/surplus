import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readConfig, defaultConfig } from '../src/core/files.js';

const homes: string[] = [];

afterEach(async () => {
  for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_STATE_HOME;
  delete process.env.SURPLUS_CLAUDE_BIN;
});

describe('policy failure behavior', () => {
  it('uses defaults only when config is absent and rejects corrupt config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'surplus-config-'));
    homes.push(home);
    process.env.XDG_CONFIG_HOME = home;
    expect(await readConfig()).toEqual(defaultConfig);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(home, 'surplus'), { recursive: true }));
    await writeFile(join(home, 'surplus/config.json'), '{broken');
    await expect(readConfig()).rejects.toThrow(/malformed/);
  });
});
