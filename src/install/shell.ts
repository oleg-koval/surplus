import { access, chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../core/files.js';

const begin = '# >>> surplus managed block >>>';
const end = '# <<< surplus managed block <<<';
const managedBin = (): string => join(dataDir(), 'bin');
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const managedMarkers = (): string => `${begin}\nexport PATH=${shellQuote(managedBin())}:"$PATH"\n${end}\n`;
const wrapper = (provider: string): string => `#!/bin/sh\nexec surplus run ${provider} "$@"\n`;

const zshStartupDirectory = (home: string): string => {
  if (process.env.ZDOTDIR !== undefined) {
    if (!process.env.ZDOTDIR) throw new Error('ZDOTDIR is empty; set it to a startup directory before installing or uninstalling.');
    return process.env.ZDOTDIR;
  }
  const shell = process.env.SHELL ?? '';
  const executable = shell.endsWith('/zsh') || shell === 'zsh' ? shell : 'zsh';
  const marker = `SURPLUS_ZDOTDIR_${randomUUID().replaceAll('-', '')}`;
  const valueMarker = `${marker}_VALUE`;
  const command = `printf '%s' '${marker}'; printf '%s' "\${+ZDOTDIR}"; printf '%s' '${valueMarker}'; printf '%s' "\${ZDOTDIR-}"; printf '%s' '${marker}'`;
  const result = spawnSync(executable, ['-c', command], {
    encoding: 'buffer', timeout: 1_000, maxBuffer: 16 * 1024,
    env: { ...process.env, HOME: home },
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    && !shell.endsWith('/zsh') && shell !== 'zsh' && !existsSync(join(home, '.zshenv'))) return home;
  if (result.error || result.status !== 0) {
    throw new Error('Could not resolve zsh ZDOTDIR from its startup files; set ZDOTDIR in the environment and retry.');
  }
  const output = result.stdout as Buffer;
  const boundary = Buffer.from(marker);
  const start = output.indexOf(boundary);
  const finish = output.lastIndexOf(boundary);
  if (start < 0 || finish <= start || finish + boundary.length !== output.length) {
    throw new Error('Could not safely resolve zsh ZDOTDIR output; set ZDOTDIR in the environment and retry.');
  }
  const details = output.subarray(start + boundary.length, finish).toString('utf8');
  const valueBoundary = details.indexOf(valueMarker);
  const isSet = valueBoundary >= 0 ? details.slice(0, valueBoundary) : '';
  const configured = valueBoundary >= 0 ? details.slice(valueBoundary + valueMarker.length) : '';
  if (isSet === '1' && !configured) throw new Error('ZDOTDIR is empty; set it to a startup directory before installing or uninstalling.');
  if (isSet !== '0' && isSet !== '1') throw new Error('Could not safely resolve zsh ZDOTDIR output; set ZDOTDIR in the environment and retry.');
  return configured || home;
};

const firstExistingBashLoginRc = async (home: string): Promise<string> => {
  for (const name of ['.bash_profile', '.bash_login', '.profile']) {
    const path = join(home, name);
    try {
      await lstat(path);
      await readFile(path, 'utf8');
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return join(home, '.bash_profile');
};

const shellRcs = async (): Promise<readonly string[]> => {
  const shell = process.env.SHELL ?? '';
  const home = process.env.HOME ?? homedir();
  if (shell.endsWith('/zsh')) return [join(zshStartupDirectory(home), '.zshrc')];
  if (shell.endsWith('/bash')) return [join(home, '.bashrc'), await firstExistingBashLoginRc(home)];
  throw new Error('Surplus supports zsh and bash installation. Run `surplus run <provider>` directly for other shells.');
};

const shellRcCandidates = (): readonly string[] => {
  const home = process.env.HOME ?? homedir();
  const zshDirectory = zshStartupDirectory(home);
  const zshDirectories = [zshDirectory, home];
  return [...new Set([
    ...zshDirectories.map((directory) => join(directory, '.zshrc')),
    join(home, '.bashrc'),
    join(home, '.bash_profile'),
    join(home, '.bash_login'),
    join(home, '.profile'),
  ])];
};

const replaceManagedBlock = (source: string, replacement: string): string => {
  const start = source.indexOf(begin);
  const finish = source.indexOf(end);
  if (start < 0 && finish < 0) return replacement ? `${source}${source.endsWith('\n') || !source ? '' : '\n'}${replacement}` : source;
  if (start < 0 || finish < start) throw new Error('The Surplus shell block is damaged; edit the shell file manually before continuing.');
  const markerEnd = finish + end.length;
  const after = source[markerEnd] === '\n' ? markerEnd + 1 : markerEnd;
  const beforeText = source.slice(0, start);
  const afterText = source.slice(after);
  if (replacement) {
    const normalizedReplacement = replacement.endsWith('\n') || !afterText ? replacement : `${replacement}\n`;
    return `${beforeText}${normalizedReplacement}${afterText}`;
  }
  const separator = afterText && beforeText && !beforeText.endsWith('\n') && !afterText.startsWith('\n') ? '\n' : '';
  return `${beforeText}${separator}${afterText}`;
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
  try { mode = (await stat(destination)).mode & 0o777; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode });
  await chmod(temporary, mode);
  await rename(temporary, destination);
};

export const installShell = async (): Promise<void> => {
  const bin = managedBin();
  const rcs = await shellRcs();
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
  const rcChanges = await Promise.all(rcs.map(async (path) => {
    let source: string | undefined;
    try { source = await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = replaceManagedBlock(source ?? '', managedMarkers());
    return { path, source, result };
  }));
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  const writtenRcs: typeof rcChanges[number][] = [];
  try {
    for (const path of wrappersToCreate) {
      const provider = path.slice(path.lastIndexOf('/') + 1);
      await writeAtomic(path, wrapper(provider), 0o755);
      created.push(path);
    }
    for (const change of rcChanges) {
      if (change.result === change.source) continue;
      await writeAtomic(change.path, change.result, 0o600);
      writtenRcs.push(change);
    }
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    for (const change of writtenRcs.reverse()) {
      try {
        if (change.source !== undefined) await writeAtomic(change.path, change.source, 0o600);
        else if (await readFile(change.path, 'utf8') === change.result) await unlink(change.path);
      } catch (rollbackError) {
        if ((rollbackError as NodeJS.ErrnoException).code !== 'ENOENT') rollbackFailures.push(rollbackError);
      }
    }
    for (const path of created) {
      const provider = path.slice(path.lastIndexOf('/') + 1);
      try {
        if (await readFile(path, 'utf8') === wrapper(provider)) await unlink(path);
      } catch (rollbackError) {
        if ((rollbackError as NodeJS.ErrnoException).code !== 'ENOENT') rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) throw new AggregateError([error, ...rollbackFailures], 'Shell install failed and wrapper rollback was incomplete.');
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
    let contents: string;
    try { contents = await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (contents !== wrapper(provider)) continue;
    try { await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
};

const defaultClaudeSettingsPath = (): string => join(process.env.HOME ?? homedir(), '.claude', 'settings.json');
export const claudeSettingsPath = (): string => join(process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(process.env.HOME ?? homedir(), '.claude'), 'settings.json');
export const statuslineCommand = (originalCommand?: string): string => {
  const cli = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} capture claude`;
  return originalCommand ? `${cli} --original=${Buffer.from(originalCommand).toString('base64')}` : cli;
};

const recoverOriginalStatuslineCommand = (command: string): { readonly recognized: boolean; readonly originalCommand?: string } => {
  const bareCommand = statuslineCommand();
  if (command === bareCommand) return { recognized: true };
  const prefix = `${bareCommand} --original=`;
  if (!command.startsWith(prefix)) return { recognized: false };
  const encoded = command.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return { recognized: false };
  const bytes = Buffer.from(encoded, 'base64');
  const decoded = bytes.toString('utf8');
  if (!decoded || bytes.toString('base64') !== encoded || Buffer.from(decoded, 'utf8').toString('base64') !== encoded) {
    return { recognized: false };
  }
  return { recognized: true, originalCommand: decoded };
};

const isGeneratedCaptureCommand = (command: string): boolean =>
  /^'(?:[^']|'\\'')+' '(?:[^']|'\\'')+' capture claude(?: --original=[A-Za-z0-9+/]+={0,2})?$/.test(command);

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
  let previous: { readonly present: boolean; readonly value?: unknown; readonly managedCommand: string; readonly settingsPath: string } | undefined;
  let previousBackupContents: string | undefined;
  try {
    previousBackupContents = await readFile(path, 'utf8');
    let saved: unknown;
    try { saved = JSON.parse(previousBackupContents) as unknown; } catch { throw new Error('Surplus Claude statusline backup is malformed; refusing to replace it.'); }
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
      throw new Error('Surplus Claude statusline backup is invalid; refusing to replace it.');
    }
    const row = saved as Record<string, unknown>;
    if (typeof row.present !== 'boolean' || typeof row.managedCommand !== 'string'
      || (row.settingsPath !== undefined && (typeof row.settingsPath !== 'string' || row.settingsPath.length === 0))) {
      throw new Error('Surplus Claude statusline backup is invalid; refusing to replace it.');
    }
    const previousSettingsPath = typeof row.settingsPath === 'string' ? resolve(row.settingsPath) : defaultClaudeSettingsPath();
    if (previousSettingsPath !== settingsPath) {
      throw new Error('Surplus Claude statusline backup belongs to a different CLAUDE_CONFIG_DIR; use the original directory to reinstall or uninstall.');
    }
    previous = { present: row.present, value: row.value, managedCommand: row.managedCommand, settingsPath: previousSettingsPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof Error && (error.message.includes('malformed') || error.message.includes('invalid') || error.message.includes('different CLAUDE_CONFIG_DIR'))) throw error;
      throw new Error('Surplus Claude statusline backup is unreadable; refusing to replace it.');
    }
  }
  const alreadyOwned = previous !== undefined && existingCommand === previous.managedCommand;
  const orphanedCommand = !alreadyOwned && existingCommand ? recoverOriginalStatuslineCommand(existingCommand) : undefined;
  if (!alreadyOwned && existingCommand && isGeneratedCaptureCommand(existingCommand) && !orphanedCommand?.recognized) {
    throw new Error('A Surplus Claude statusline from another installation has no ownership backup; restore that backup or remove the old capture command before reinstalling.');
  }
  const originalCommand = alreadyOwned && previous
    ? (typeof previous.value === 'object' && previous.value !== null && !Array.isArray(previous.value)
      && typeof (previous.value as Record<string, unknown>).command === 'string'
      ? (previous.value as Record<string, string>).command : undefined)
    : orphanedCommand?.recognized ? orphanedCommand.originalCommand : existingCommand;
  const managedCommand = statuslineCommand(originalCommand);
  const currentObject = current as Record<string, unknown> | undefined;
  if (alreadyOwned && existingCommand === managedCommand) return false;
  if (!alreadyOwned && orphanedCommand?.recognized && currentObject?.command === managedCommand) {
    const originalValue = orphanedCommand.originalCommand === undefined
      ? undefined : { type: 'command', command: orphanedCommand.originalCommand };
    const recoveredOwnership = `${JSON.stringify({ present: originalValue !== undefined, ...(originalValue ? { value: originalValue } : {}), managedCommand: existingCommand, settingsPath }, null, 2)}\n`;
    await writeAtomic(path, recoveredOwnership, 0o600);
    return false;
  }
  const backup = alreadyOwned && previous
    ? { present: previous.present, value: previous.value, managedCommand, settingsPath }
    : { present: Object.hasOwn(settings, 'statusLine'), value: settings.statusLine, managedCommand, settingsPath };
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
    || typeof (parsedBackup as Record<string, unknown>).managedCommand !== 'string'
    || ((parsedBackup as Record<string, unknown>).settingsPath !== undefined
      && (typeof (parsedBackup as Record<string, unknown>).settingsPath !== 'string' || (parsedBackup as Record<string, unknown>).settingsPath === ''))) {
    throw new Error('Surplus Claude statusline backup is invalid; refusing to uninstall.');
  }
  const backupRow = parsedBackup as { present: boolean; value?: unknown; managedCommand: string; settingsPath?: string };
  const backupSettingsPath = backupRow.settingsPath ? resolve(backupRow.settingsPath) : defaultClaudeSettingsPath();
  if (backupSettingsPath !== settingsPath) {
    throw new Error('Surplus Claude statusline backup belongs to a different CLAUDE_CONFIG_DIR; use the original directory to uninstall.');
  }
  const backup = { present: backupRow.present, value: backupRow.value, managedCommand: backupRow.managedCommand };
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
    || (current as Record<string, unknown>).command !== ownedCommand) {
    try { await unlink(backupPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return;
  }
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

export const surplusExecutable = async (env = process.env): Promise<string | undefined> => {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, 'surplus');
    try {
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch { /* Search the next PATH directory. */ }
  }
  return undefined;
};
