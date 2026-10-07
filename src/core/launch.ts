import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Provider } from './types.js';

export const hasExplicitOverride = (provider: Provider, args: readonly string[], env = process.env): boolean => {
  if (env.SURPLUS_MODEL || env.SURPLUS_EFFORT || env.CODEX_MODEL || env.ANTHROPIC_MODEL) return true;
  if (provider === 'claude' && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL || env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY || env.CLAUDE_CODE_EFFORT_LEVEL)) return true;
  const sentinel = args.indexOf('--');
  const cliArgs = sentinel < 0 ? args : args.slice(0, sentinel);
  if (cliArgs.some((arg) => ['--model', '-m', '--effort', '--profile', '-p'].includes(arg) || arg.startsWith('--model=') || arg.startsWith('--effort=') || /^-[mp].+/.test(arg))) return true;
  if (cliArgs.some((arg) => ['--json', '--output-format', '--output-format=json', '--output-format=stream-json', '--version', '-v', '-V', '--help', '-h'].includes(arg))) return true;
  if (provider === 'claude') {
    return ['auth', 'mcp', 'plugin', 'plugins', 'agents', 'doctor', 'install', 'update', 'upgrade', 'setup-token', 'logs', 'attach', 'stop', 'kill', 'rm'].includes(cliArgs[0] ?? '')
      || cliArgs.some((arg) => ['--resume', '-r', '--continue', '-c', '--print', '-p', '--bg', '--background', '--cloud', '--agent', '--agents', '--worktree', '-w', '--remote-control', '--sdk-url', '--settings'].includes(arg) || arg.startsWith('--resume=') || arg.startsWith('--cloud='));
  }
  if (cliArgs.some((arg) => ['--oss', '--local-provider', '--remote', '--remote-auth-token-env'].includes(arg) || arg.startsWith('--local-provider=') || arg.startsWith('--remote=') || arg.startsWith('--remote-auth-token-env='))) return true;
  if (cliArgs.some((arg) => ['--config', '-c', '--worktree', '-C', '--cd'].includes(arg) || arg.startsWith('--config=') || arg.startsWith('--cd=') || /^-C.+/.test(arg))) return true;
  const utilityCommands = new Set(['agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'cloud', 'cloud-tasks', 'exec-server', 'features', 'help', 'resume', 'fork']);
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

export const shouldAutomaticallyRoute = (stdinIsTTY: boolean | undefined, stdoutIsTTY: boolean | undefined): boolean => stdinIsTTY === true && stdoutIsTTY === true;

const findExecutable = async (name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  const explicit = env[`SURPLUS_${name.toUpperCase()}_BIN`];
  if (explicit) return explicit;
  const wrapperDir = join(env.XDG_STATE_HOME ?? join(env.HOME ?? '', '.local', 'state'), 'surplus', 'bin');
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory || directory === wrapperDir) continue;
    const path = join(directory, name);
    try { await access(path, constants.X_OK); return path; } catch { /* Search the next PATH directory. */ }
  }
  return undefined;
};

export const launchProvider = async (provider: Provider, args: readonly string[], env = process.env, onStarted?: () => Promise<void>): Promise<number> => {
  const executable = await findExecutable(provider, env);
  if (!executable) throw new Error(`Could not find the original ${provider} executable in PATH.`);
  const child = spawn(executable, [...args], { stdio: 'inherit', env });
  return await new Promise((resolve, reject) => {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = new Map<NodeJS.Signals, () => void>(signals.map((signal) => [signal, () => { child.kill(signal); }]));
    handlers.forEach((handler, signal) => process.on(signal, handler));
    const removeHandlers = (): void => { handlers.forEach((handler, signal) => { process.off(signal, handler); }); };
    child.once('error', (error) => { removeHandlers(); reject(error); });
    let onStartedPromise = Promise.resolve();
    child.once('spawn', () => {
      if (onStarted) onStartedPromise = onStarted();
    });
    child.once('close', (code, signal) => {
      removeHandlers();
      const signalNumber = signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : signal === 'SIGHUP' ? 1 : undefined;
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
