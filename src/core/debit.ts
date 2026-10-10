import type { LaunchDebit, UsageSnapshot } from './types.js';

/** Purely reports whether a debit was recorded against exactly this cached sample (same window, capture time, and account). */
export const debitMatchesSample = (debit: LaunchDebit | undefined, usage: UsageSnapshot): debit is LaunchDebit =>
  debit?.resetsAt === usage.resetsAt && debit.observedAt === usage.observedAt && debit.identityHash === usage.identityHash;

/**
 * Purely returns the weekly percent to hold back for the sample: the stored debit when it is bound to exactly this sample, otherwise 0.
 * A non-positive per-launch setting disables the debit, so a stored amount is ignored.
 */
export const pendingDebitPercent = (usage: UsageSnapshot | undefined, debit: LaunchDebit | undefined, perLaunchPercent: number): number =>
  usage && perLaunchPercent > 0 && debitMatchesSample(debit, usage) ? debit.percent : 0;

/** Purely reports whether the stored debit belongs to a strictly newer sample (later reset window, or later capture in the same window). */
const isNewerThan = (debit: LaunchDebit, usage: UsageSnapshot): boolean => {
  const byReset = Date.parse(debit.resetsAt) - Date.parse(usage.resetsAt);
  if (byReset !== 0 && Number.isFinite(byReset)) return byReset > 0;
  const byCapture = Date.parse(debit.observedAt) - Date.parse(usage.observedAt);
  return Number.isFinite(byCapture) && byCapture > 0;
};

/**
 * Purely returns the debit after one more premium launch against the sample.
 * Accumulates onto a debit for the same sample, starts afresh over an older one, and keeps a debit bound to a newer sample unchanged.
 * Returns the existing debit untouched when the per-launch amount is not positive, since there is nothing to add.
 */
export const recordLaunchDebit = (usage: UsageSnapshot, existing: LaunchDebit | undefined, perLaunchPercent: number): LaunchDebit | undefined => {
  if (existing && isNewerThan(existing, usage)) return existing;
  if (!(perLaunchPercent > 0)) return debitMatchesSample(existing, usage) ? existing : undefined;
  const carried = debitMatchesSample(existing, usage) ? existing.percent : 0;
  return {
    resetsAt: usage.resetsAt,
    observedAt: usage.observedAt,
    ...(usage.identityHash ? { identityHash: usage.identityHash } : {}),
    percent: Math.min(100, carried + perLaunchPercent),
  };
};

/**
 * Purely removes one launch's reservation from the debit bound to the sample, returning undefined when nothing is left.
 * A debit bound to any other sample is returned unchanged.
 */
export const releaseLaunchDebit = (usage: UsageSnapshot, existing: LaunchDebit | undefined, perLaunchPercent: number): LaunchDebit | undefined => {
  if (!debitMatchesSample(existing, usage)) return existing;
  const percent = existing.percent - perLaunchPercent;
  return percent > 0 ? { ...existing, percent } : undefined;
};
