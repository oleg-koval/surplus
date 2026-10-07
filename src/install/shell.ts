import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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

const replaceManagedBlock = (source: string, replacement: string): string => {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  if (start < 0 && finish < 0) return replacement ? `${source}${source.endsWith('\n') || !source ? '' : '\n'}${replacement}` : source;
  if (start < 0 || finish < start) throw new Error('The Surplus shell block is damaged; edit the shell file manually before continuing.');
  const after = finish + end.length;
  return `${source.slice(0, start)}${replacement}${source.slice(after)}`;
};

const writeAtomic = async (path: string, contents: string, requestedMode: number): Promise<void> => {
  let mode = requestedMode;
  try { mode = (await stat(path)).mode & 0o777; } catch { /* Use the private default mode. */ }
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
};

export const installShell = async (): Promise<void> => {
  const bin = managedBin();
  await mkdir(bin, { recursive: true, mode: 0o700 });
  for (const provider of ['claude', 'codex']) {
    const path = join(bin, provider);
    try {
      const current = await readFile(path, 'utf8');
      if (current !== wrapper(provider)) throw new Error(`Refusing to overwrite an existing ${path}.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeAtomic(path, wrapper(provider), 0o755);
    }
  }
  const rc = shellRc();
  let source = '';
  try { source = await readFile(rc, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result = replaceManagedBlock(source, managedMarkers());
  if (result !== source) await writeAtomic(rc, result, 0o600);
};

export const uninstallShell = async (): Promise<void> => {
  let rc = '';
  try { rc = await readFile(shellRc(), 'utf8'); } catch { /* No shell file was created. */ }
  const cleaned = replaceManagedBlock(rc, '');
  if (rc && cleaned !== rc) await writeAtomic(shellRc(), cleaned, 0o600);
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

export const installClaudeStatusLine = async (): Promise<void> => {
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
  const backup = { present: Object.hasOwn(settings, 'statusLine'), value: settings.statusLine };
  const current = settings.statusLine;
  const existingCommand = typeof current === 'object' && current !== null && !Array.isArray(current) && typeof (current as Record<string, unknown>).command === 'string'
    ? (current as Record<string, string>).command : undefined;
  if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current) || (current as Record<string, unknown>).type !== 'command' || !existingCommand)) {
    throw new Error('Surplus can only chain a Claude command statusline; preserve other statusline types manually.');
  }
  const managedCommand = statuslineCommand(existingCommand);
  const currentObject = current as Record<string, unknown> | undefined;
  if (currentObject?.command === managedCommand) return;
  await writeAtomic(path, `${JSON.stringify(backup, null, 2)}\n`, 0o600);
  settings.statusLine = { ...(currentObject ?? {}), type: 'command', command: managedCommand };
  await writeAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
};

export const uninstallClaudeStatusLine = async (): Promise<void> => {
  const settingsPath = claudeSettingsPath();
  const backupPath = join(dataDir(), 'claude-statusline-backup.json');
  let backup: { present?: boolean; value?: unknown };
  let settings: Record<string, unknown>;
  try {
    backup = JSON.parse(await readFile(backupPath, 'utf8')) as { present?: boolean; value?: unknown };
    settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch { return; }
  const current = settings.statusLine;
  const previousCommand = typeof backup.value === 'object' && backup.value !== null && !Array.isArray(backup.value) && typeof (backup.value as Record<string, unknown>).command === 'string'
    ? (backup.value as Record<string, string>).command : undefined;
  if (typeof current !== 'object' || current === null || (current as Record<string, unknown>).command !== statuslineCommand(previousCommand)) return;
  if (backup.present) settings.statusLine = backup.value;
  else delete settings.statusLine;
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
