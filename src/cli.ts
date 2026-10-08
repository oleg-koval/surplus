import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { constants as osConstants } from 'node:os';
import type { Features, Provider, ProviderConfig, UsageSnapshot } from './core/types.js';
import { decide } from './core/policy.js';
import { codexUpgradeConfig } from './core/codex-policy.js';
import { defaultConfig, readClaudeIdentity, readConfig, readState, readUsage, readUsageHistory, saveClaudeIdentity, saveConfig, saveState, saveUsage } from './core/files.js';
import { statuslineSegment, withSegment } from './core/notice.js';
import { runHook } from './hook.js';
import { restoreHooks, syncHooks, uninstallHooks } from './install/hooks.js';
import { appendEffort, appendModel, hasExplicitOverride, launchProvider, shouldAutomaticallyRoute } from './core/launch.js';
import { installClaudeStatusLine, installShell, uninstallClaudeStatusLine, uninstallShell } from './install/shell.js';
import { parseClaudeStatusLine, readClaudeIdentityHash, readStatusLineInput } from './providers/claude.js';
import { discoverCodex } from './providers/codex.js';

const usageText = `Surplus — use more of your included AI coding allowance before it resets.

Usage:
  surplus install [--no-claude-capture] [--no-hooks]
  surplus uninstall
  surplus status [claude|codex]
  surplus run <claude|codex> [provider arguments...]
  surplus configure <claude|codex> [--premium MODEL] [--effort LEVEL]
  surplus configure features [--session-notice on|off] [--prompt-nudge on|off] [--statusline-segment on|off]
  surplus hook <claude|codex> <session-start|prompt-submit>   (called by the provider, prints a short notice or nothing)
  surplus demo
`;

const isProvider = (value: string | undefined): value is Provider => value === 'claude' || value === 'codex';
const configured = (config: Awaited<ReturnType<typeof readConfig>>, provider: Provider): ProviderConfig => config.providers[provider];
const minutes = (value: number): string => `${String(value)}m`;
const osSignalNumber = (signal: NodeJS.Signals): number | undefined => osConstants.signals[signal];
const maxChainedStatusLineOutputBytes = 1024 * 1024;

const showDecision = (decision: ReturnType<typeof decide>): void => {
  const remaining = decision.weeklyRemainingPercent === null ? 'unknown' : `${decision.weeklyRemainingPercent.toFixed(1)}%`;
  const until = decision.minutesUntilReset === null ? 'unknown' : minutes(decision.minutesUntilReset);
  process.stdout.write(`${decision.tier.toUpperCase()} · ${decision.model} · ${remaining} weekly remaining · reset in ${until}\n${decision.reason}\n`);
};

export const computeSegment = async (snapshot: UsageSnapshot): Promise<string> => {
  try {
    const config = await readConfig();
    if (!config.features.statuslineSegment) return '';
    const previous = await readState('claude');
    const history = await readUsageHistory('claude');
    const decision = decide({ usage: snapshot, config: config.providers.claude, ...(previous ? { previous } : {}), history });
    return statuslineSegment(decision, config.providers.claude);
  } catch { return ''; }
};

const runStatusLine = async (args: readonly string[]): Promise<void> => {
  const input = await readStatusLineInput();
  let segment = '';
  try {
    const snapshot = parseClaudeStatusLine(input);
    const identityHash = process.env.SURPLUS_CLAUDE_IDENTITY_HASH;
    if (snapshot && identityHash) {
      const captured = { ...snapshot, identityHash };
      await saveUsage(captured);
      segment = await computeSegment(captured);
    }
  } catch { /* Preserve the existing user's statusline even if capture fails. */ }
  const emit = (text: string): void => { process.stdout.write(withSegment(text, segment)); };

  const encoded = args.find((arg) => arg.startsWith('--original='))?.slice('--original='.length);
  if (!encoded) { emit(''); return; }
  let command: string;
  try { command = Buffer.from(encoded, 'base64').toString('utf8'); } catch { emit(''); return; }
  if (!command) { emit(''); return; }
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  const terminateGroup = (): void => {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  };
  const outputChunks: Buffer[] = [];
  let outputBytes = 0;
  const outputState = { truncated: false };
  let receivedSignal: NodeJS.Signals | undefined;
  child.stdout.on('data', (chunk: Buffer) => {
    if (outputState.truncated) return;
    const remaining = maxChainedStatusLineOutputBytes - outputBytes;
    const kept = chunk.subarray(0, Math.max(0, remaining));
    if (kept.length > 0) {
      outputChunks.push(kept);
      outputBytes += kept.length;
    }
    if (chunk.length > remaining) {
      outputState.truncated = true;
      terminateGroup();
    }
  });
  child.stdin.on('error', () => { /* The original statusline may exit before consuming the input. */ });
  child.stdin.end(typeof input === 'object' ? JSON.stringify(input) : '');
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      resolve();
    };
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const signalHandlers = new Map<NodeJS.Signals, () => void>(signals.map((signal) => [signal, () => {
      receivedSignal = signal;
      terminateGroup();
    }]));
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    const timeout = setTimeout(() => {
      terminateGroup();
      child.stdout.destroy();
      child.stdin.destroy();
      finish();
    }, 2_000);
    child.once('error', finish);
    child.once('close', finish);
  });
  emit(Buffer.concat(outputChunks, outputBytes).toString('utf8'));
  if (outputState.truncated) process.stderr.write(`Surplus: chained Claude statusline output exceeded ${String(maxChainedStatusLineOutputBytes)} bytes and was truncated.\n`);
  if (receivedSignal) {
    const signalNumber = osSignalNumber(receivedSignal);
    if (signalNumber !== undefined) process.exitCode = 128 + signalNumber;
  }
};

const getClaudeUsage = async (): Promise<{ readonly usage?: UsageSnapshot; readonly identityHash?: string }> => {
  const currentIdentity = readClaudeIdentityHash();
  const previousIdentity = await readClaudeIdentity();
  if (!currentIdentity) return {};
  if (currentIdentity !== previousIdentity) return { identityHash: currentIdentity };
  const snapshot = await readUsage('claude');
  return {
    ...(snapshot?.identityHash === currentIdentity ? { usage: snapshot } : {}),
    identityHash: currentIdentity,
  };
};

const prepare = async (provider: Provider): Promise<{ decision: ReturnType<typeof decide>; usage?: UsageSnapshot; premiumEffort?: string; identityHash?: string }> => {
  const config = await readConfig();
  const providerConfig = configured(config, provider);
  const previous = await readState(provider);
  const history = await readUsageHistory(provider);
  if (provider === 'claude') {
    const claude = await getClaudeUsage();
    const usage = claude.usage;
    const decision = decide({ ...(usage ? { usage } : {}), config: providerConfig, ...(previous ? { previous } : {}), history });
    return { decision, ...(usage ? { usage } : {}), ...(providerConfig.premiumEffort ? { premiumEffort: providerConfig.premiumEffort } : {}), ...(claude.identityHash ? { identityHash: claude.identityHash } : {}) };
  }

  const discovery = await discoverCodex();
  const usage = discovery?.usage;
  const effectiveConfig = codexUpgradeConfig(providerConfig, discovery);
  const decision = decide({ ...(usage ? { usage } : {}), config: effectiveConfig, ...(previous ? { previous } : {}), history });
  return { decision, ...(usage ? { usage } : {}), ...(effectiveConfig.premiumEffort ? { premiumEffort: effectiveConfig.premiumEffort } : {}) };
};

const run = async (provider: Provider, args: string[]): Promise<void> => {
  if (!shouldAutomaticallyRoute(process.stdin.isTTY, process.stdout.isTTY)) {
    process.exitCode = await launchProvider(provider, args);
    return;
  }
  if (hasExplicitOverride(provider, args)) {
    process.exitCode = await launchProvider(provider, args);
    return;
  }
  let result: Awaited<ReturnType<typeof prepare>>;
  try { result = await prepare(provider); } catch {
    process.exitCode = await launchProvider(provider, args);
    return;
  }
  if (result.decision.tier === 'premium') showDecision(result.decision);
  let selected = [...args];
  if (result.decision.tier === 'premium') {
    selected = appendModel(provider, result.decision.model, selected);
    selected = appendEffort(provider, result.decision.effort ?? result.premiumEffort, selected);
  }
  const childEnv = {
    ...process.env,
    ...(provider === 'claude' && result.identityHash ? { SURPLUS_CLAUDE_IDENTITY_HASH: result.identityHash } : {}),
    ...(result.decision.tier === 'premium' ? { SURPLUS_ROUTED_TIER: 'premium' } : {}),
  };
  const onStarted = async (): Promise<void> => {
    try { await saveState(provider, { tier: result.decision.tier, resetAt: result.usage?.resetsAt ?? '', observedAt: new Date().toISOString() }); } catch { /* Local routing state never controls provider launch or exit status. */ }
    if (provider === 'claude' && result.identityHash) {
      try { await saveClaudeIdentity(result.identityHash); } catch { /* Account binding remains best-effort local state. */ }
    }
    if (provider === 'codex' && result.usage) {
      try { await saveUsage(result.usage); } catch { /* Cached telemetry never controls provider launch or exit status. */ }
    }
  };
  process.exitCode = await launchProvider(provider, selected, childEnv, onStarted);
};

const status = async (provider: Provider): Promise<void> => {
  const result = await prepare(provider);
  showDecision(result.decision);
};

const configure = async (provider: Provider, args: string[]): Promise<void> => {
  const config = await readConfig();
  const current = configured(config, provider);
  const next: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !['--premium', '--effort'].includes(flag ?? '')) throw new Error('Use --premium MODEL or --effort LEVEL.');
    next[flag ?? ''] = value;
    index += 1;
  }
  const updated: ProviderConfig = {
    ...current,
    ...(next['--premium'] ? { premiumModel: next['--premium'] } : {}),
    ...(next['--effort'] ? { premiumEffort: next['--effort'] } : {}),
  };
  const providers = { ...config.providers, [provider]: updated };
  await saveConfig({ version: 1, providers, features: config.features });
  process.stdout.write(`Saved ${provider} preferences in the private Surplus config.\n`);
};

const featureFlags: Readonly<Record<string, keyof Features>> = {
  '--session-notice': 'sessionNotice', '--prompt-nudge': 'promptNudge', '--statusline-segment': 'statuslineSegment',
};

const configureFeatures = async (args: string[]): Promise<void> => {
  const config = await readConfig();
  const next: Record<string, boolean> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? '';
    const value = args[index + 1];
    const key = featureFlags[flag];
    if (!key || (value !== 'on' && value !== 'off')) throw new Error('Use --session-notice, --prompt-nudge or --statusline-segment with on or off.');
    next[key] = value === 'on';
  }
  const features: Features = { ...config.features, ...next };
  const snapshots = await syncHooks(features);
  try { await saveConfig({ ...config, features }); } catch (error) {
    try { await restoreHooks(snapshots); } catch { /* The save failure is the primary error. */ }
    throw error;
  }
  process.stdout.write(`Saved features: session notice ${features.sessionNotice ? 'on' : 'off'}, prompt nudge ${features.promptNudge ? 'on' : 'off'}, statusline segment ${features.statuslineSegment ? 'on' : 'off'}.\n`);
};

const demo = (): void => {
  const now = new Date('2026-10-07T12:00:00.000Z');
  const sample: UsageSnapshot = {
    provider: 'claude', observedAt: now.toISOString(), weeklyUsedPercent: 60, sessionWindow: 'available',
    resetsAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    sessionUsedPercent: 20, sessionResetsAt: new Date(now.getTime() + 4 * 60 * 60_000).toISOString(), usageAllowed: true,
  };
  process.stdout.write('DEMO SAMPLE DATA — no provider account was queried.\n');
  showDecision(decide({ usage: sample, config: defaultConfig.providers.claude, now }));
};

let forceExit = false;

export const main = async (args = process.argv.slice(2)): Promise<void> => {
  const [command, first, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') { process.stdout.write(usageText); return; }
  if (command === 'capture' && first === 'claude') { await runStatusLine(rest); return; }
  if (command === 'hook') {
    const event = rest[0];
    const output = isProvider(first) && (event === 'session-start' || event === 'prompt-submit')
      ? await runHook(first, event, readStatusLineInput) : '';
    if (output) process.stdout.write(output);
    process.exitCode = 0;
    forceExit = true;
    return;
  }
  if (command === 'install') {
    const flags = [first, ...rest];
    const captureInstalled = !flags.includes('--no-claude-capture') ? await installClaudeStatusLine() : false;
    let hookSnapshots: Awaited<ReturnType<typeof syncHooks>> = [];
    try {
      if (!flags.includes('--no-hooks')) hookSnapshots = await syncHooks((await readConfig()).features);
    } catch (error) {
      if (captureInstalled) await uninstallClaudeStatusLine();
      throw error;
    }
    try { await installShell(); } catch (error) {
      try { await restoreHooks(hookSnapshots); } catch { /* Report the original install failure. */ }
      if (captureInstalled) await uninstallClaudeStatusLine();
      throw error;
    }
    process.stdout.write('Surplus installed. Open a new terminal to activate Claude Code and Codex wrappers.\n');
    return;
  }
  if (command === 'uninstall') {
    const failures: unknown[] = [];
    for (const operation of [uninstallClaudeStatusLine, uninstallHooks, uninstallShell]) {
      try { await operation(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      const details = failures.map((error) => error instanceof Error ? error.message : 'unknown error').join('; ');
      throw new AggregateError(failures, `Uninstall completed with errors: ${details}`);
    }
    process.stdout.write('Surplus wrappers removed; edited user files and wrappers were left in place.\n');
    return;
  }
  if (command === 'demo') { demo(); return; }
  if (command === 'status' && isProvider(first)) { await status(first); return; }
  if (command === 'configure' && first === 'features') { await configureFeatures(rest); return; }
  if (command === 'configure' && isProvider(first)) { await configure(first, rest); return; }
  if (command === 'run' && isProvider(first)) { await run(first, rest); return; }
  if (isProvider(command)) { await run(command, [first, ...rest].filter((value): value is string => value !== undefined)); return; }
  process.stderr.write(usageText);
  process.exitCode = 2;
};

if (process.argv[1] && ['cli.js', 'surplus'].includes(basename(process.argv[1]))) {
  void main().then(() => {
    // Hooks must never linger on a slow provider probe; exit once stdout is flushed.
    if (forceExit) process.stdout.write('', () => { process.exit(0); });
  }).catch((error: unknown) => {
    process.stderr.write(`surplus: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = forceExit ? 0 : 1;
  });
}
