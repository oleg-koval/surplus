import { access, chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../core/files.js';

const begin = '# >>> surplus managed block >>>';
const end = '# <<< surplus managed block <<<';
const managedBin = (): string => join(dataDir(), 'bin');
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const managedMarkers = (): string => `${begin}\nexport PATH=${shellQuote(managedBin())}:"$PATH"\n${end}`;
const wrapper = (provider: string): string => `#!/bin/sh\nexec surplus run ${provider} "$@"\n`;

const shellRc = (): string => {
  const shell = process.env.SHELL ?? '';
  const home = process.env.HOME ?? homedir();
  if (shell.endsWith('/zsh')) return join(home, '.zshrc');
  if (shell.endsWith('/bash')) return join(home, process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
  throw new Error('Surplus supports zsh and bash installation. Run `surplus run <provider>` directly for other shells.');
};

const shellRcCandidates = (): readonly string[] => {
  const home = process.env.HOME ?? homedir();
  return [join(home, '.zshrc'), join(home, '.bash_profile'), join(home, '.bashrc')];
};

const replaceManagedBlock = (source: string, replacement: string): string => {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  if (start < 0 && finish < 0) return replacement ? `${source}${source.endsWith('\n') || !source ? '' : '\n'}${replacement}` : source;
  if (start < 0 || finish < start) throw new Error('The Surplus shell block is damaged; edit the shell file manually before continuing.');
  const after = finish + end.length;
  return `${source.slice(0, start)}${replacement}${source.slice(after)}`;
};

const writeAtomic = async (path: string, contents: string, requestedMode: number): Promise<void> => {
  let destination = path;
  let linkInfo: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    linkInfo = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (linkInfo?.isSymbolicLink()) destination = await realpath(path);
  let mode = requestedMode;
  try { mode = (await stat(destination)).mode & 0o777; } catch { /* Use the private default mode. */ }
  await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode });
  await chmod(temporary, mode);
  await rename(temporary, destination);
};

export const installShell = async (): Promise<void> => {
  const bin = managedBin();
  const rc = shellRc();
  const wrappersToCreate: string[] = [];
  for (const provider of ['claude', 'codex']) {
    const path = join(bin, provider);
    try {
      const current = await readFile(path, 'utf8');
      if (current !== wrapper(provider)) throw new Error(`Refusing to overwrite an existing ${path}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      wrappersToCreate.push(path);
    }
  }
  let source = '';
  try { source = await readFile(rc, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result = replaceManagedBlock(source, managedMarkers());
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  try {
    for (const path of wrappersToCreate) {
      const provider = path.slice(path.lastIndexOf('/') + 1);
      await writeAtomic(path, wrapper(provider), 0o755);
      created.push(path);
    }
    if (result !== source) await writeAtomic(rc, result, 0o600);
  } catch (error) {
    for (const path of created) {
      const provider = path.slice(path.lastIndexOf('/') + 1);
      try { if (await readFile(path, 'utf8') === wrapper(provider)) await unlink(path); } catch { /* Preserve any file changed during rollback. */ }
    }
    throw error;
  }
};

export const uninstallShell = async (): Promise<void> => {
  for (const path of shellRcCandidates()) {
    let rc: string;
    try { rc = await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const cleaned = replaceManagedBlock(rc, '');
    if (cleaned !== rc) await writeAtomic(path, cleaned, 0o600);
  }
  for (const provider of ['claude', 'codex']) {
    const path = join(managedBin(), provider);
    try { if (await readFile(path, 'utf8') === wrapper(provider)) await unlink(path); } catch { /* Keep user-edited or absent wrappers untouched. */ }
  }
};

export const claudeSettingsPath = (): string => join(process.env.HOME ?? homedir(), '.claude', 'settings.json');
export const statuslineCommand = (originalCommand?: string): string => {
  const cli = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} capture claude`;
  return originalCommand ? `${cli} --original=${Buffer.from(originalCommand).toString('base64')}` : cli;
};

export const installClaudeStatusLine = async (): Promise<boolean> => {
  const settingsPath = claudeSettingsPath();
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Claude settings.json must contain a JSON object.');
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const path = join(dataDir(), 'claude-statusline-backup.json');
  const current = settings.statusLine;
  const existingCommand = typeof current === 'object' && current !== null && !Array.isArray(current) && typeof (current as Record<string, unknown>).command === 'string'
    ? (current as Record<string, string>).command : undefined;
  if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current) || (current as Record<string, unknown>).type !== 'command' || !existingCommand)) {
    throw new Error('Surplus can only chain a Claude command statusline; preserve other statusline types manually.');
  }
  let previous: { readonly present: boolean; readonly value?: unknown; readonly managedCommand: string } | undefined;
  let previousBackupContents: string | undefined;
  try {
    previousBackupContents = await readFile(path, 'utf8');
    let saved: unknown;
    try { saved = JSON.parse(previousBackupContents) as unknown; } catch { throw new Error('Surplus Claude statusline backup is malformed; refusing to replace it.'); }
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
      throw new Error('Surplus Claude statusline backup is invalid; refusing to replace it.');
    }
    const row = saved as Record<string, unknown>;
    if (typeof row.present !== 'boolean' || typeof row.managedCommand !== 'string') {
      throw new Error('Surplus Claude statusline backup is invalid; refusing to replace it.');
    }
    previous = { present: row.present, value: row.value, managedCommand: row.managedCommand };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof Error && (error.message.includes('malformed') || error.message.includes('invalid'))) throw error;
      throw new Error('Surplus Claude statusline backup is unreadable; refusing to replace it.');
    }
  }
  const alreadyOwned = previous !== undefined && existingCommand === previous.managedCommand;
  const originalCommand = alreadyOwned && previous
    ? (typeof previous.value === 'object' && previous.value !== null && !Array.isArray(previous.value)
      && typeof (previous.value as Record<string, unknown>).command === 'string'
      ? (previous.value as Record<string, string>).command : undefined)
    : existingCommand;
  const managedCommand = statuslineCommand(originalCommand);
  const currentObject = current as Record<string, unknown> | undefined;
  if (alreadyOwned && existingCommand === managedCommand) return false;
  if (!alreadyOwned && currentObject?.command === statuslineCommand()) {
    const recoveredOwnership = `${JSON.stringify({ present: false, managedCommand: existingCommand }, null, 2)}\n`;
    await writeAtomic(path, recoveredOwnership, 0o600);
    return true;
  }
  const backup = alreadyOwned && previous
    ? { present: previous.present, value: previous.value, managedCommand }
    : { present: Object.hasOwn(settings, 'statusLine'), value: settings.statusLine, managedCommand };
  const newBackupContents = `${JSON.stringify(backup, null, 2)}\n`;
  await writeAtomic(path, newBackupContents, 0o600);
  settings.statusLine = { ...(currentObject ?? {}), type: 'command', command: managedCommand };
  try {
    await writeAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
  } catch (error) {
    try {
      if (previousBackupContents !== undefined) {
        await writeAtomic(path, previousBackupContents, 0o600);
      } else if (await readFile(path, 'utf8') === newBackupContents) {
        await unlink(path);
      }
    } catch {
      throw new Error('Claude statusline update failed and its prior backup could not be restored.');
    }
    throw error;
  }
  return !alreadyOwned;
};

export const uninstallClaudeStatusLine = async (): Promise<void> => {
  const settingsPath = claudeSettingsPath();
  const backupPath = join(dataDir(), 'claude-statusline-backup.json');
  let backupText: string;
  try { backupText = await readFile(backupPath, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Cannot read the Surplus Claude statusline backup; fix its permissions before uninstalling.');
  }
  let parsedBackup: unknown;
  try { parsedBackup = JSON.parse(backupText) as unknown; } catch { throw new Error('Surplus Claude statusline backup is malformed; refusing to uninstall.'); }
  if (typeof parsedBackup !== 'object' || parsedBackup === null || Array.isArray(parsedBackup)
    || typeof (parsedBackup as Record<string, unknown>).present !== 'boolean'
    || typeof (parsedBackup as Record<string, unknown>).managedCommand !== 'string') {
    throw new Error('Surplus Claude statusline backup is invalid; refusing to uninstall.');
  }
  const backup = parsedBackup as { present: boolean; value?: unknown; managedCommand: string };
  let settingsText: string;
  try { settingsText = await readFile(settingsPath, 'utf8'); } catch {
    throw new Error('Cannot read Claude settings.json; fix its permissions before uninstalling.');
  }
  let parsedSettings: unknown;
  try { parsedSettings = JSON.parse(settingsText) as unknown; } catch { throw new Error('Claude settings.json is malformed; refusing to uninstall.'); }
  if (typeof parsedSettings !== 'object' || parsedSettings === null || Array.isArray(parsedSettings)) {
    throw new Error('Claude settings.json is invalid; refusing to uninstall.');
  }
  const settings = parsedSettings as Record<string, unknown>;
  const current = settings.statusLine;
  const ownedCommand = backup.managedCommand;
  if (typeof current !== 'object' || current === null || Array.isArray(current)
    || (current as Record<string, unknown>).type !== 'command'
    || (current as Record<string, unknown>).command !== ownedCommand) return;
  if (backup.present) {
    const prior = backup.value;
    if (typeof prior === 'object' && prior !== null && !Array.isArray(prior)) {
      const fields = prior as Record<string, unknown>;
      const restored = { ...(current as Record<string, unknown>) };
      if (Object.hasOwn(fields, 'type')) restored.type = fields.type;
      else delete restored.type;
      if (Object.hasOwn(fields, 'command')) restored.command = fields.command;
      else delete restored.command;
      settings.statusLine = restored;
    } else {
      settings.statusLine = prior;
    }
  } else {
    const restored = { ...(current as Record<string, unknown>) };
    delete restored.type;
    delete restored.command;
    if (Object.keys(restored).length > 0) settings.statusLine = restored;
    else delete settings.statusLine;
  }
  await writeAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
  await unlink(backupPath);
};

export const surplusExecutable = async (): Promise<string | undefined> => {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, 'surplus');
    try { await access(path, constants.X_OK); return path; } catch { /* Search the next PATH directory. */ }
  }
  return undefined;
};
