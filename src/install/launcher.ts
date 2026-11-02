export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

const quotedWord = "'(?:[^']|'\\\\'')+'";
const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Sentinels let the recognizing patterns be derived from the generator, so the two cannot drift apart.
const nodeMark = '@@NODE@@';
const cliMark = '@@CLI@@';

/**
 * Shell preamble that keeps the recorded node and CLI as first choices but survives either disappearing
 * (a version manager removing a Node version, a global package moving): node falls back to PATH, and when the
 * recorded CLI file cannot be run with node the `surplus` bin on PATH is used as is (it may be a shim script or
 * native binary that only its own launcher can run). Variables stay empty when nothing is found.
 */
const resolve = (node: string, cli: string): string =>
  `N=${shellQuote(node)}; C=${shellQuote(cli)}; S=; [ -x "$N" ] || N=$(command -v node); [ -n "$N" ] && [ -f "$C" ] || S=$(command -v surplus)`;

/**
 * Builds the provider hook command. It runs the Surplus hook when node and the CLI can be found and otherwise
 * stays silent; it always exits 0 so a vanished Node install can never surface as a hook error.
 */
export const resilientHookCommand = (provider: string, event: string, node: string, cli: string): string =>
  `${resolve(node, cli)}; if [ -n "$N" ] && [ -f "$C" ]; then "$N" "$C" hook ${provider} ${event}; elif [ -n "$S" ]; then "$S" hook ${provider} ${event}; fi; exit 0`;

const decodeOriginal = '/bin/sh -c "$(printf %s "$O" | base64 -d 2>/dev/null || printf %s "$O" | base64 -D)"';

/**
 * Builds the Claude statusline capture command. The user's original statusline travels as base64 in `$O`;
 * when node or the CLI cannot be found it runs that original directly so the statusline keeps working.
 */
export const resilientCaptureCommand = (node: string, cli: string, encodedOriginal = ''): string =>
  `O=${shellQuote(encodedOriginal)}; ${resolve(node, cli)}; `
  + `if [ -n "$N" ] && [ -f "$C" ]; then "$N" "$C" capture claude \${O:+--original="$O"}; `
  + `elif [ -n "$S" ]; then "$S" capture claude \${O:+--original="$O"}; elif [ -n "$O" ]; then ${decodeOriginal}; fi`;

const pattern = (template: string, replacements: readonly (readonly [string, string])[]): RegExp => {
  let source = escapePattern(template);
  for (const [mark, replacement] of replacements) source = source.replaceAll(escapePattern(shellQuote(mark)), replacement);
  return new RegExp(`^${source}$`);
};

/** Recognizes a command produced by {@link resilientHookCommand} for any recorded node and CLI path. */
export const isResilientHookCommand = (command: string, provider: string, event: string): boolean =>
  pattern(resilientHookCommand(provider, event, nodeMark, cliMark), [[nodeMark, quotedWord], [cliMark, quotedWord]]).test(command);

const encodedWord = "'([A-Za-z0-9+/]*={0,2})'";
const capturePattern = (): RegExp =>
  pattern(resilientCaptureCommand(nodeMark, cliMark, 'ORIGINAL'), [[nodeMark, quotedWord], [cliMark, quotedWord], ['ORIGINAL', encodedWord]]);

/**
 * Recognizes a command produced by {@link resilientCaptureCommand} for any recorded node and CLI path and
 * returns its still-encoded original statusline ('' when none), or undefined for any other command.
 */
export const resilientCaptureOriginal = (command: string): string | undefined => capturePattern().exec(command)?.[1];
