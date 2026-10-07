import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { Provider, ProviderConfig, UsageSnapshot } from './core/types.js';
import { decide } from './core/policy.js';
import { codexUpgradeConfig } from './core/codex-policy.js';
import { defaultConfig, incrementActivations, readActivations, readClaudeIdentity, readConfig, readState, readUsage, saveClaudeIdentity, saveConfig, saveState, saveUsage } from './core/files.js';
import { appendEffort, appendModel, hasExplicitOverride, launchProvider, shouldAutomaticallyRoute } from './core/launch.js';
import { installClaudeStatusLine, installShell, uninstallClaudeStatusLine, uninstallShell } from './install/shell.js';
import { parseClaudeStatusLine, readClaudeIdentityHash, readStatusLineInput } from './providers/claude.js';
import { discoverCodex } from './providers/codex.js';

const usageText = `Surplus — use more of your included AI coding allowance before it resets.

Usage:
  surplus install [--no-claude-capture]
  surplus uninstall
  surplus status [claude|codex]
  surplus run <claude|codex> [provider arguments...]
  surplus configure <claude|codex> [--premium MODEL] [--effort LEVEL]
  surplus demo
`;

const isProvider = (value: string | undefined): value is Provider => value === 'claude' || value === 'codex';
const configured = (config: Awaited<ReturnType<typeof readConfig>>, provider: Provider): ProviderConfig => config.providers[provider];
const minutes = (value: number): string => `${String(value)}m`;

const showDecision = (decision: ReturnType<typeof decide>): void => {
  const remaining = decision.weeklyRemainingPercent === null ? 'unknown' : `${decision.weeklyRemainingPercent.toFixed(1)}%`;
  const until = decision.minutesUntilReset === null ? 'unknown' : minutes(decision.minutesUntilReset);
  process.stdout.write(`${decision.tier.toUpperCase()} · ${decision.model} · ${remaining} weekly remaining · reset in ${until}\n${decision.reason}\n`);
};

const runStatusLine = async (args: readonly string[]): Promise<void> => {
  const input = await readStatusLineInput();
  try {
    const snapshot = parseClaudeStatusLine(input);
    const identityHash = process.env.SURPLUS_CLAUDE_IDENTITY_HASH;
    if (snapshot && identityHash) await saveUsage({ ...snapshot, identityHash });
  } catch { /* Preserve the existing user's statusline even if capture fails. */ }

  const encoded = args.find((arg) => arg.startsWith('--original='))?.slice('--original='.length);
  if (!encoded) return;
  let command: string;
  try { command = Buffer.from(encoded, 'base64').toString('utf8'); } catch { return; }
  if (!command) return;
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stdin.end(typeof input === 'object' ? JSON.stringify(input) : '');
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      child.stdout.destroy();
      child.stdin.destroy();
      finish();
    }, 2_000);
    child.once('error', finish);
    child.once('close', finish);
  });
  process.stdout.write(output);
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
  if (provider === 'claude') {
    const claude = await getClaudeUsage();
    const usage = claude.usage;
    const decision = decide({ ...(usage ? { usage } : {}), config: providerConfig, ...(previous ? { previous } : {}) });
    return { decision, ...(usage ? { usage } : {}), ...(providerConfig.premiumEffort ? { premiumEffort: providerConfig.premiumEffort } : {}), ...(claude.identityHash ? { identityHash: claude.identityHash } : {}) };
  }

  const discovery = await discoverCodex();
  const usage = discovery?.usage;
  const effectiveConfig = codexUpgradeConfig(providerConfig, discovery);
  const decision = decide({ ...(usage ? { usage } : {}), config: effectiveConfig, ...(previous ? { previous } : {}) });
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
  const childEnv = provider === 'claude' && result.identityHash
    ? { ...process.env, SURPLUS_CLAUDE_IDENTITY_HASH: result.identityHash }
    : process.env;
  const onStarted = async (): Promise<void> => {
    try { await saveState(provider, { tier: result.decision.tier, resetAt: result.usage?.resetsAt ?? '', observedAt: new Date().toISOString() }); } catch { /* Local routing state never controls provider launch or exit status. */ }
    if (provider === 'claude' && result.identityHash) {
      try { await saveClaudeIdentity(result.identityHash); } catch { /* Account binding remains best-effort local state. */ }
    }
    if (provider === 'codex' && result.usage) {
      try { await saveUsage(result.usage); } catch { /* Cached telemetry never controls provider launch or exit status. */ }
    }
    if (result.decision.tier === 'premium') {
      try { await incrementActivations(); } catch { /* The local counter never controls provider launch or exit status. */ }
    }
  };
  process.exitCode = await launchProvider(provider, selected, childEnv, onStarted);
};

const status = async (provider: Provider): Promise<void> => {
  const result = await prepare(provider);
  showDecision(result.decision);
  const activations = await readActivations();
  if (activations?.count) process.stdout.write(`Local Surplus launches: ${String(activations.count)} (stored on this device only)\n`);
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
  await saveConfig({ version: 1, providers });
  process.stdout.write(`Saved ${provider} preferences in the private Surplus config.\n`);
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

export const main = async (args = process.argv.slice(2)): Promise<void> => {
  const [command, first, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || command === '-h') { process.stdout.write(usageText); return; }
  if (command === 'capture' && first === 'claude') { await runStatusLine(rest); return; }
  if (command === 'install') {
    const captureInstalled = first !== '--no-claude-capture' && !rest.includes('--no-claude-capture')
      ? await installClaudeStatusLine() : false;
    try { await installShell(); } catch (error) {
      if (captureInstalled) await uninstallClaudeStatusLine();
      throw error;
    }
    process.stdout.write('Surplus installed. Open a new terminal to activate Claude Code and Codex wrappers.\n');
    return;
  }
  if (command === 'uninstall') {
    await uninstallClaudeStatusLine();
    await uninstallShell();
    process.stdout.write('Surplus wrappers removed; edited user files and wrappers were left in place.\n');
    return;
  }
  if (command === 'demo') { demo(); return; }
  if (command === 'status' && isProvider(first)) { await status(first); return; }
  if (command === 'configure' && isProvider(first)) { await configure(first, rest); return; }
  if (command === 'run' && isProvider(first)) { await run(first, rest); return; }
  if (isProvider(command)) { await run(command, [first, ...rest].filter((value): value is string => value !== undefined)); return; }
  process.stderr.write(usageText);
  process.exitCode = 2;
};

if (process.argv[1] && ['cli.js', 'surplus'].includes(basename(process.argv[1]))) {
  void main().catch((error: unknown) => {
    process.stderr.write(`surplus: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
