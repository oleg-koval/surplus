import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type XdgDirectoryKind = 'config' | 'state';

export const resolveHomeDirectory = (env = process.env, fallback = homedir()): string => {
  const home = env.HOME;
  if (home !== undefined) {
    if (!home || !isAbsolute(home)) throw new Error('HOME must be a non-empty absolute path.');
    return home;
  }
  if (!fallback || !isAbsolute(fallback)) throw new Error('The operating system home directory must be an absolute path.');
  return fallback;
};

export const xdgDirectory = (
  kind: XdgDirectoryKind,
  env = process.env,
  fallbackHome?: string,
): string => {
  const homeDirectory = resolveHomeDirectory(env, fallbackHome);
  const configured = kind === 'state' ? env.XDG_STATE_HOME : env.XDG_CONFIG_HOME;
  if (configured && isAbsolute(configured)) return configured;
  return kind === 'state' ? join(homeDirectory, '.local', 'state') : join(homeDirectory, '.config');
};

export const surplusDataDirectory = (
  env = process.env,
  fallbackHome?: string,
): string => join(xdgDirectory('state', env, fallbackHome), 'surplus');
