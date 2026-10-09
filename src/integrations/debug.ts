/** Emits bounded, credential-free integration diagnostics only when explicitly requested. */
export const integrationDebug = (integration: 'hermes' | 'pi', message: string, env = process.env): void => {
  if (env.SURPLUS_DEBUG === '1') process.stderr.write(`surplus debug: ${integration}: ${message}\n`);
};
