import type { ProviderConfig } from './types.js';
import type { CodexDiscovery } from '../providers/codex.js';

const effortRank: Readonly<Record<string, number>> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 5 };

export const codexUpgradeConfig = (config: ProviderConfig, discovery: CodexDiscovery | undefined): ProviderConfig => {
  if (!discovery) return config;
  const model = config.premiumModel === 'auto' ? discovery.effectiveModel : config.premiumModel;
  const candidate = model ? discovery.models.find((item) => item.model === model) : undefined;
  const effort = config.premiumEffort;
  const supportsEffort = candidate?.supportedReasoningEfforts?.some((item) => item.reasoningEffort === effort) ?? false;
  const currentRank = discovery.effectiveEffort ? effortRank[discovery.effectiveEffort] : undefined;
  const targetRank = effort ? effortRank[effort] : undefined;
  const alreadyHighEnough = config.premiumModel === 'auto'
    && (currentRank === undefined || targetRank === undefined || currentRank >= targetRank);
  if (!candidate || !effort || !supportsEffort || !model || alreadyHighEnough) return { ...config, minWeeklyRemainingPercent: 101 };
  return { ...config, premiumModel: config.premiumModel === 'auto' ? 'auto' : model };
};
