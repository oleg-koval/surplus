import { fileURLToPath } from 'node:url';

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Generates a provider wrapper that invokes this installed Surplus entrypoint
 * directly instead of resolving a mutable `surplus` command through PATH.
 */
export const managedWrapperContents = (
  provider: string,
  nodePath = process.execPath,
  cliPath = fileURLToPath(import.meta.url),
): string => `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliPath)} run ${shellQuote(provider)} "$@"\n`;
