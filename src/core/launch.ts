import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { constants as osConstants, homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Client, Provider } from './types.js';
import { managedWrapperContents } from './managed-wrapper.js';
import { resolveHomeDirectory, surplusDataDirectory } from './xdg.js';

const claudeUtilityCommand = (args: readonly string[]): string | undefined => {
  const valueOptions = new Set([
    '--add-dir', '--agent', '--agents', '--allowedTools', '--allowed-tools', '--append-system-prompt', '--append-system-prompt-file',
    '--autocompact', '--betas', '--debug-file', '--disallowedTools', '--disallowed-tools', '--effort', '--environment',
    '--fallback-model', '--file', '--input-format', '--json-schema', '--max-budget-usd', '--mcp-config', '--name', '-n',
    '--output-format', '--permission-mode', '--permission-prompts', '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix',
    '--session-id', '--setting-sources', '--settings', '--system-prompt', '--system-prompt-file', '--system-prompt-snapshot',
    '--advisor', '--channels', '--append-subagent-system-prompt', '--append-subagent-system-prompt-file',
  ]);
  const optionalValueOptions = new Set(['--debug', '--from-pr', '--cloud', '--prompt-suggestions', '--remote-control', '--resume', '-r', '--teleport', '--worktree', '-w']);
  const variadicValueOptions = new Set([
    '--add-dir', '--allowedTools', '--allowed-tools', '--betas', '--disallowedTools', '--disallowed-tools', '--file', '--mcp-config',
    '--tools', '--channels', '--dangerously-load-development-channels',
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const equalsIndex = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const option = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    if (option.startsWith('-')) {
      if (variadicValueOptions.has(option)) {
        while (args[index + 1] !== undefined && !args[index + 1]?.startsWith('-')) index += 1;
      } else if (valueOptions.has(option) && equalsIndex < 0) {
        index += 1;
      } else if (optionalValueOptions.has(option) && equalsIndex < 0 && args[index + 1] !== undefined && !args[index + 1]?.startsWith('-')) {
        index += 1;
      }
      continue;
    }
    return arg;
  }
  return undefined;
};

export const hasExplicitOverride = (provider: Client, args: readonly string[], env = process.env): boolean => {
  if (env.SURPLUS_MODEL || env.SURPLUS_EFFORT) return true;
  if (provider === 'hermes' || provider === 'pi') return false;
  if ((provider === 'claude' && env.ANTHROPIC_MODEL) || (provider === 'codex' && env.CODEX_MODEL)) return true;
  if (provider === 'claude' && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY || env.CLAUDE_CODE_EFFORT_LEVEL)) return true;
  const sentinel = args.indexOf('--');
  const cliArgs = sentinel < 0 ? args : args.slice(0, sentinel);
  const normalizedArgs = cliArgs.map((arg) => arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg);
  if (normalizedArgs.some((arg) => ['--model', '-m', '--effort', '--profile', '-p'].includes(arg) || /^-[mp].+/.test(arg))) return true;
  if (normalizedArgs.some((arg) => ['--json', '--output-format', '--version', '-v', '-V', '--help', '-h'].includes(arg))) return true;
  if (provider === 'claude') {
    const utilities = new Set(['auth', 'mcp', 'plugin', 'plugins', 'agents', 'doctor', 'install', 'update', 'upgrade', 'setup-token', 'logs', 'attach', 'stop', 'kill', 'rm', 'auto-mode', 'gateway', 'daemon', 'desktop', 'import', 'project', 'purge', 'remote-control', 'respawn', 'self-hosted-runner', 'ultrareview', 'teleport']);
    const command = claudeUtilityCommand(cliArgs);
    const daemonCommand = command === 'daemon' && (cliArgs[0] === 'daemon'
      || ((cliArgs[0] === '--dangerously-skip-permissions' || cliArgs[0] === '--allow-dangerously-skip-permissions') && cliArgs[1] === 'daemon'));
    return (command === 'daemon' ? daemonCommand : utilities.has(command ?? ''))
      || normalizedArgs.some((arg) => ['--resume', '-r', '--continue', '-c', '--print', '-p', '--bg', '--background', '--cloud', '--environment', '--exec', '--desktop', '--bare', '--debug', '-d', '--verbose', '--agent', '--agents', '--worktree', '-w', '--remote-control', '--sdk-url', '--settings', '--init-only', '--from-pr', '--teleport', '--fallback-model', '--advisor'].includes(arg) || /^-r.+/.test(arg));
  }
  if (normalizedArgs.some((arg) => ['--oss', '--local-provider', '--remote', '--remote-auth-token-env'].includes(arg))) return true;
  if (normalizedArgs.some((arg) => ['--config', '-c', '--worktree', '-C', '--cd'].includes(arg) || /^-[cC].+/.test(arg))) return true;
  const utilityCommands = new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'cloud', 'cloud-tasks', 'exec-server', 'features', 'help', 'resume', 'fork', 'tcp-tunnel', 'execpolicy', 'responses-api-proxy', 'stdio-to-uds']);
  const valueOptions = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir']);
  let command: string | undefined;
  for (let index = 0; index < cliArgs.length; index += 1) {
    const arg = cliArgs[index];
    if (arg === undefined) continue;
    if (arg.startsWith('-')) {
      if (valueOptions.has(arg)) index += 1;
      continue;
    }
    command = arg;
    break;
  }
  return utilityCommands.has(command ?? '');
};

export const shouldAutomaticallyRoute = (stdinIsTTY: boolean | undefined, stdoutIsTTY: boolean | undefined, platform = process.platform): boolean => platform !== 'win32' && stdinIsTTY === true && stdoutIsTTY === true;

export const findExecutable = async (name: string, env: NodeJS.ProcessEnv, homeDirectory?: string): Promise<string | undefined> => {
  const explicit = env[`SURPLUS_${name.toUpperCase()}_BIN`];
  const home = resolveHomeDirectory(env, homeDirectory ?? homedir());
  const wrapperDir = join(surplusDataDirectory(env, home), 'bin');
  const canonicalPath = async (path: string): Promise<string> => {
    try { return await realpath(path); } catch { return resolve(path); }
  };
  const managedExecutable = await canonicalPath(join(wrapperDir, name));
  const isManagedWrapper = async (path: string): Promise<boolean> => {
    try {
      const details = await stat(path);
      const contents = managedWrapperContents(name);
      return details.isFile() && details.size === Buffer.byteLength(contents) && await readFile(path, 'utf8') === contents;
    } catch { return false; }
  };
  if (explicit) {
    if (await canonicalPath(explicit) === managedExecutable || await isManagedWrapper(explicit)) {
      throw new Error(`SURPLUS_${name.toUpperCase()}_BIN points to Surplus's managed wrapper; set it to the original provider executable.`);
    }
    return explicit;
  }
  const canonicalWrapperDir = await canonicalPath(wrapperDir);
  // Match Node's POSIX spawn lookup when PATH is absent, without searching cwd.
  const searchPath = env.PATH ?? (process.platform === 'win32' ? undefined : '/usr/bin:/bin');
  for (const directory of searchPath === undefined ? [] : searchPath.split(delimiter)) {
    const pathDirectory = directory || '.';
    if (await canonicalPath(pathDirectory) === canonicalWrapperDir) continue;
    const path = resolve(pathDirectory, name);
    try {
      if (!(await stat(path)).isFile()) continue;
      if (await canonicalPath(path) === managedExecutable || await isManagedWrapper(path)) continue;
      await access(path, constants.X_OK);
      return path;
    } catch { /* Search the next PATH directory. */ }
  }
  return undefined;
};

export const launchProvider = async (provider: Client, args: readonly string[], env = process.env, onStarted?: () => Promise<void>): Promise<number> => {
  const executable = await findExecutable(provider, env);
  if (!executable) throw new Error(`Could not find the original ${provider} executable in PATH.`);
  if (process.platform !== 'win32') {
    if (!process.execve) throw new Error('Provider launches require POSIX Node.js with stable process.execve (Node.js 22.21+ or 24.10+).');
    if (onStarted) await onStarted();
    const executableEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    process.execve(executable, [executable, ...args], executableEnv);
  }
  const child = spawn(executable, [...args], { stdio: 'inherit', env });
  return await new Promise((resolve, reject) => {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = new Map<NodeJS.Signals, () => void>(signals.map((signal) => [signal, () => {
      child.kill(signal);
    }]));
    handlers.forEach((handler, signal) => process.on(signal, handler));
    const removeHandlers = (): void => { handlers.forEach((handler, signal) => { process.off(signal, handler); }); };
    child.once('error', (error) => { removeHandlers(); reject(error); });
    let onStartedPromise = Promise.resolve();
    child.once('spawn', () => {
      if (onStarted) onStartedPromise = onStarted();
    });
    child.once('close', (code, signal) => {
      removeHandlers();
      const signalNumber = signal ? osConstants.signals[signal] : undefined;
      void onStartedPromise.then(() => { resolve(code ?? (signalNumber ? 128 + signalNumber : 1)); }).catch(reject);
    });
  });
};

export const appendModel = (provider: Provider, model: string, args: readonly string[]): string[] => {
  if (model === 'auto') return [...args];
  return ['--model', model, ...args];
};

export const appendEffort = (provider: Provider, effort: string | undefined, args: readonly string[]): string[] => {
  if (!effort) return [...args];
  return provider === 'claude'
    ? ['--effort', effort, ...args]
    : ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`, ...args];
};
