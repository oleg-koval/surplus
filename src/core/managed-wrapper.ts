import { fileURLToPath } from 'node:url';

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const defaultCliPath = (): string => process.argv[1] ?? fileURLToPath(import.meta.url);
const legacyWrapperContents = (provider: string): string => `#!/bin/sh\nexec surplus run ${provider} "$@"\n`;
const quotedShellWord = "'(?:[^']|'\\\\'')*'";

/**
 * Generates a provider wrapper that invokes this installed Surplus entrypoint
 * directly instead of resolving a mutable `surplus` command through PATH.
 */
export const managedWrapperContents = (
  provider: string,
  nodePath = process.execPath,
  cliPath = defaultCliPath(),
): string => `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliPath)} run ${shellQuote(provider)} "$@"\n`;

/** Recognizes current and older Surplus wrappers without treating user files as managed. */
export const isManagedWrapperContents = (provider: string, contents: string): boolean => {
  if (contents === legacyWrapperContents(provider) || contents === managedWrapperContents(provider)) return true;
  return new RegExp(`^#!/bin/sh\\nexec ${quotedShellWord} ${quotedShellWord} run ${shellQuote(provider)} "\\$@"\\n$`).test(contents);
};
