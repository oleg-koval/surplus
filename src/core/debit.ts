import type { LaunchDebit, UsageSnapshot } from './types.js';

/** Purely reports whether a debit was recorded against exactly this cached sample (same window, capture time, and account). */
export const debitMatchesSample = (debit: LaunchDebit | undefined, usage: UsageSnapshot): debit is LaunchDebit =>
  debit?.resetsAt === usage.resetsAt && debit.observedAt === usage.observedAt && debit.identityHash === usage.identityHash;

/**
 * Purely adds the pending debit to the sample's weekly used percent, clamped to 100.
 * A debit for another sample (newer capture, new reset window, or different identity), an absent debit, or a non-positive amount returns the sample unchanged.
 */
export const applyLaunchDebit = (usage: UsageSnapshot, debit: LaunchDebit | undefined): UsageSnapshot => {
  if (!debitMatchesSample(debit, usage) || !(debit.percent > 0)) return usage;
  return { ...usage, weeklyUsedPercent: Math.min(100, usage.weeklyUsedPercent + debit.percent) };
};

/**
 * Purely returns the debit after one more premium launch against the sample.
 * Accumulates onto a debit for the same sample and starts afresh otherwise; returns undefined when the per-launch amount is not positive.
 */
export const recordLaunchDebit = (usage: UsageSnapshot, existing: LaunchDebit | undefined, perLaunchPercent: number): LaunchDebit | undefined => {
  if (!(perLaunchPercent > 0)) return undefined;
  const carried = debitMatchesSample(existing, usage) ? existing.percent : 0;
  return {
    resetsAt: usage.resetsAt,
    observedAt: usage.observedAt,
    ...(usage.identityHash ? { identityHash: usage.identityHash } : {}),
    percent: Math.min(100, carried + perLaunchPercent),
  };
};
