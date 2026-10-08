import { readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Features, Provider } from '../core/types.js';
import { resolveHomeDirectory } from '../core/xdg.js';
import { claudeSettingsPath, shellQuote, writeAtomic } from './shell.js';

export type HookEventName = 'session-start' | 'prompt-submit';
const eventKeys: Readonly<Record<HookEventName, string>> = { 'session-start': 'SessionStart', 'prompt-submit': 'UserPromptSubmit' };
const eventNames = Object.keys(eventKeys) as HookEventName[];

export const codexHooksPath = (): string =>
  join(process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(resolveHomeDirectory(), '.codex'), 'hooks.json');
const hooksFilePath = (provider: Provider): string => provider === 'claude' ? claudeSettingsPath() : codexHooksPath();

export const hookCommand = (provider: Provider, event: HookEventName): string =>
  `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} hook ${provider} ${event}`;

const isOurCommand = (command: unknown, provider: Provider, event: HookEventName): boolean =>
  typeof command === 'string' && new RegExp(`^'(?:[^']|'\\\\'')+' '(?:[^']|'\\\\'')+' hook ${provider} ${event}$`).test(command);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const desiredEvents = (features: Features): HookEventName[] => [
  ...(features.sessionNotice ? ['session-start' as const] : []),
  ...(features.promptNudge ? ['prompt-submit' as const] : []),
];

const readRoot = async (path: string, label: string): Promise<{ readonly text: string | undefined; readonly root: Record<string, unknown> }> => {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: undefined, root: {} };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error(`${label} is malformed; refusing to edit its hooks.`); }
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object; refusing to edit its hooks.`);
  return { text, root: parsed };
};

/** Applies the desired Surplus hook for one event to the parsed root, touching only our own entries. */
const syncEvent = (root: Record<string, unknown>, provider: Provider, event: HookEventName, desired: boolean, label: string): void => {
  const key = eventKeys[event];
  if (root.hooks !== undefined && !isRecord(root.hooks)) throw new Error(`${label} "hooks" must be an object; refusing to edit it.`);
  const hooks = root.hooks ?? {};
  const existing = hooks[key];
  if (existing !== undefined && !Array.isArray(existing)) throw new Error(`${label} hooks.${key} must be an array; refusing to edit it.`);
  const groups = (existing ?? []) as unknown[];
  const command = hookCommand(provider, event);
  let removed = false;
  let refreshed = false;
  const kept: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) { kept.push(group); continue; }
    const handlers: unknown[] = [];
    let touched = false;
    for (const handler of group.hooks as unknown[]) {
      if (isRecord(handler) && handler.type === 'command' && isOurCommand(handler.command, provider, event)) {
        touched = true;
        if (desired && !refreshed) { refreshed = true; handlers.push({ ...handler, command }); } else removed = true;
      } else handlers.push(handler);
    }
    if (touched && handlers.length === 0) { removed = true; continue; }
    kept.push(touched ? { ...group, hooks: handlers } : group);
  }
  if (desired && !refreshed) kept.push({ hooks: [{ type: 'command', command }] });
  if (kept.length > 0 || (existing !== undefined && !removed)) hooks[key] = kept;
  else if (existing !== undefined) Reflect.deleteProperty(hooks, key);
  if (Object.keys(hooks).length > 0) root.hooks = hooks;
  else if (root.hooks !== undefined && removed) delete root.hooks;
};

export interface HooksSnapshot { readonly path: string; readonly before: string | undefined }

const syncFile = async (provider: Provider, events: readonly HookEventName[]): Promise<HooksSnapshot | undefined> => {
  const path = hooksFilePath(provider);
  const label = provider === 'claude' ? 'Claude settings.json' : 'Codex hooks.json';
  const { text, root } = await readRoot(path, label);
  if (text === undefined && events.length === 0) return undefined;
  const original = JSON.stringify(root);
  for (const event of eventNames) syncEvent(root, provider, event, events.includes(event), label);
  if (text !== undefined && JSON.stringify(root) === original) return undefined;
  await writeAtomic(path, `${JSON.stringify(root, null, 2)}\n`, 0o600);
  return { path, before: text };
};

export const restoreHooks = async (snapshots: readonly HooksSnapshot[]): Promise<void> => {
  const failures: unknown[] = [];
  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (snapshot.before === undefined) await unlink(snapshot.path);
      else await writeAtomic(snapshot.path, snapshot.before, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Hook rollback was incomplete.');
};

/** Installs the enabled hook events for both harnesses and removes the disabled ones. Rolls back its own writes on failure. */
export const syncHooks = async (features: Features): Promise<HooksSnapshot[]> => {
  const events = desiredEvents(features);
  const done: HooksSnapshot[] = [];
  try {
    for (const provider of ['claude', 'codex'] as const) {
      const snapshot = await syncFile(provider, events);
      if (snapshot) done.push(snapshot);
    }
  } catch (error) {
    try { await restoreHooks(done); } catch (rollback) { throw new AggregateError([error, rollback], 'Hook install failed and rollback was incomplete.'); }
    throw error;
  }
  return done;
};

export const uninstallHooks = async (): Promise<void> => {
  const failures: unknown[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    try { await syncFile(provider, []); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, failures.map((error) => error instanceof Error ? error.message : 'unknown error').join('; '));
};
