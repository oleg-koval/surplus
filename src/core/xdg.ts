import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type XdgDirectoryKind = 'config' | 'state';

export const xdgDirectory = (
  kind: XdgDirectoryKind,
  env = process.env,
  homeDirectory = env.HOME ?? homedir(),
): string => {
  const configured = kind === 'state' ? env.XDG_STATE_HOME : env.XDG_CONFIG_HOME;
  if (configured && isAbsolute(configured)) return configured;
  return kind === 'state' ? join(homeDirectory, '.local', 'state') : join(homeDirectory, '.config');
};

export const surplusDataDirectory = (
  env = process.env,
  homeDirectory = env.HOME ?? homedir(),
): string => join(xdgDirectory('state', env, homeDirectory), 'surplus');
