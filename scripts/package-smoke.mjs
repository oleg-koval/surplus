import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const fixture = await mkdtemp(join(tmpdir(), 'surplus-package-smoke-'));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  const packDir = join(fixture, 'pack');
  const prefix = join(fixture, 'prefix');
  const home = join(fixture, "user home '$ value");
  const state = join(home, 'state');
  const config = join(home, 'config');
  const fakeBin = join(fixture, 'provider-bin');
  await Promise.all([mkdir(packDir), mkdir(prefix), mkdir(home), mkdir(fakeBin)]);
  await mkdir(join(home, '.claude'));
  const priorStatusLine = { type: 'command', command: "printf 'original statusline'", padding: 4 };
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', statusLine: priorStatusLine }));
  run('npm', ['pack', '--pack-destination', packDir], { cwd: root });
  const tarball = join(packDir, 'surplus-cli-0.1.0.tgz');
  run('npm', ['install', '--prefix', prefix, '--no-save', tarball], { cwd: root });
  const surplus = join(prefix, 'node_modules', '.bin', 'surplus');
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: config,
    SHELL: '/bin/zsh',
  };
  run(surplus, ['install'], { env });

  const identity = { email: 'fixture@example.test', orgId: 'fixture-org', subscriptionType: 'pro' };
  const identityHash = createHash('sha256').update(`${identity.email}\n${identity.orgId}\n${identity.subscriptionType}`).digest('hex');
  const auth = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', ...identity });
  const argsPath = join(fixture, 'provider-args.txt');
  const fakeClaude = join(fakeBin, 'claude');
  const fakeCodex = join(fakeBin, 'codex');
  await writeFile(fakeClaude, `#!/bin/sh\nif [ "$1" = "auth" ]; then printf '%s' '${auth}'; exit 0; fi\nif [ -n "$SURPLUS_STATUSLINE_COMMAND" ]; then printf '%s' "$SURPLUS_STATUSLINE_SAMPLE" | /bin/sh -c "$SURPLUS_STATUSLINE_COMMAND"; fi\nprintf '%s\\n' "$@" > "$SURPLUS_ARGS_FILE"\nexit 7\n`);
  await chmod(fakeClaude, 0o755);
  await writeFile(fakeCodex, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SURPLUS_CODEX_ARGS_FILE"\n');
  await chmod(fakeCodex, 0o755);

  const settingsPath = join(home, '.claude', 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const statuslineCommand = settings.statusLine.command;
  const sample = JSON.stringify({ rate_limits: {
    five_hour: { used_percentage: 20, resets_at: Math.floor(Date.now() / 1000) + 4 * 60 * 60 },
    seven_day: { used_percentage: 60, resets_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60 },
  } });
  const wrapper = join(state, 'surplus', 'bin', 'claude');
  const path = [join(state, 'surplus', 'bin'), join(prefix, 'node_modules', '.bin'), fakeBin, process.env.PATH].join(':');
  const codexArgsPath = join(fixture, 'codex-args.txt');
  const launchEnv = { ...env, PATH: path, SURPLUS_ARGS_FILE: argsPath, SURPLUS_CODEX_ARGS_FILE: codexArgsPath, SURPLUS_STATUSLINE_COMMAND: statuslineCommand, SURPLUS_STATUSLINE_SAMPLE: sample };
  const pipedCodex = spawnSync(surplus, ['run', 'codex', 'scripted-task'], { encoding: 'utf8', env: launchEnv, input: '' });
  assert.equal(pipedCodex.status, 0, `noninteractive Codex invocation should pass through unchanged: ${pipedCodex.stderr}`);
  assert.equal(await readFile(codexArgsPath, 'utf8'), 'scripted-task\n', 'noninteractive mode must preserve the exact provider arguments');
  const captured = spawnSync('/bin/sh', ['-c', statuslineCommand], { encoding: 'utf8', env: { ...launchEnv, SURPLUS_CLAUDE_IDENTITY_HASH: identityHash }, input: sample });
  assert.equal(captured.status, 0, `the installed statusline command should capture without blocking the provider: ${captured.stderr}`);
  assert.match(captured.stdout, /original statusline/);
  const usage = JSON.parse(await readFile(join(state, 'surplus', 'claude-usage.json'), 'utf8'));
  assert.equal(usage.identityHash, identityHash, 'the first captured sample must bind to the active account');
  const first = spawnSync(wrapper, ['task'], { encoding: 'utf8', env: launchEnv });
  assert.equal(first.status, 7, `the original provider exit code must survive (${first.status}): ${first.stdout}\n${first.stderr}`);
  const firstArgs = await readFile(argsPath, 'utf8');
  assert.equal(firstArgs, 'task\n', 'noninteractive provider invocations must not receive automatic model flags');

  const slowCommand = Buffer.from('sleep 60').toString('base64');
  const timeoutStart = Date.now();
  const timed = spawnSync('/bin/sh', ['-c', `${statuslineCommand} --original=${slowCommand}`], { encoding: 'utf8', env: { ...env, SURPLUS_CLAUDE_IDENTITY_HASH: identityHash, SURPLUS_STATUSLINE_SAMPLE: sample }, input: sample, timeout: 6_000 });
  assert.equal(timed.status, 0, `a stalled chained statusline should time out cleanly: ${timed.stderr}`);
  assert.ok(Date.now() - timeoutStart < 5_000, 'a stalled statusline subprocess must not hold Claude startup open');

  const earlyExitCommand = Buffer.from('exit 0').toString('base64');
  const largeInput = JSON.stringify({ payload: 'x'.repeat(2 * 1024 * 1024) });
  const earlyExit = spawnSync('/bin/sh', ['-c', `${statuslineCommand} --original=${earlyExitCommand}`], { encoding: 'utf8', env: { ...env, SURPLUS_CLAUDE_IDENTITY_HASH: identityHash }, input: largeInput, timeout: 6_000 });
  assert.equal(earlyExit.status, 0, `an original statusline that exits before reading input must not trigger EPIPE (${earlyExit.status}): ${earlyExit.stderr}`);

  const readyPath = join(fixture, 'statusline-ready');
  const orphanPath = join(fixture, 'statusline-orphan');
  const cancellable = Buffer.from(`printf ready > '${readyPath}'; sleep 1; printf orphan > '${orphanPath}'`).toString('base64');
  const capture = spawn(surplus, ['capture', 'claude', `--original=${cancellable}`], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...env, SURPLUS_CLAUDE_IDENTITY_HASH: identityHash } });
  capture.stdin.end(sample);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await readFile(readyPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  await readFile(readyPath);
  assert.equal(capture.kill('SIGTERM'), true, 'the active capture process should accept cancellation');
  const canceled = await new Promise((resolve, reject) => {
    capture.once('error', reject);
    capture.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(canceled, { code: 143, signal: null }, 'capture should finish with the received signal status after terminating its process group');
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await assert.rejects(readFile(orphanPath), { code: 'ENOENT' }, 'cancellation must kill the original statusline process group');

  const altered = `# user replacement\n`;
  await writeFile(wrapper, altered);
  run(surplus, ['uninstall'], { env });
  assert.equal(await readFile(wrapper, 'utf8'), altered, 'uninstall must keep a user-edited wrapper');
  const restoredSettings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(restoredSettings.statusLine, priorStatusLine, 'uninstall must restore the prior Claude statusline');
  run('python3', [join(root, 'scripts/pty-signal-smoke.py'), surplus, join(root, 'tests/fixtures/signal-provider.mjs'), join(root, 'tests/fixtures/fake-codex.mjs')], { cwd: root });
  process.stdout.write('Packed install, first-run capture, statusline pipe/cancellation handling, noninteractive passthrough, bounded timeout, and PTY policy/signal behavior passed.\n');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
