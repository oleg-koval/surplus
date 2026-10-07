export const managedWrapperContents = (provider: string): string => `#!/bin/sh\nexec surplus run ${provider} "$@"\n`;
