export type Provider = 'claude' | 'codex';

export interface UsageSnapshot {
  readonly provider: Provider;
  readonly observedAt: string;
  readonly weeklyUsedPercent: number;
  readonly resetsAt: string;
  readonly sessionWindow: 'available' | 'absent' | 'invalid';
  readonly sessionUsedPercent?: number;
  readonly sessionResetsAt?: string;
  readonly identityHash?: string;
  readonly usageAllowed: boolean | null;
  /** Length of the weekly window in minutes, when the provider reports it. */
  readonly windowMinutes?: number;
}

export interface UsageSample {
  readonly observedAt: string;
  readonly used: number;
  readonly resetsAt: string;
  readonly identityHash?: string;
}

export type Strategy = 'pace' | 'near-reset';

export interface Features {
  readonly sessionNotice: boolean;
  readonly promptNudge: boolean;
  readonly statuslineSegment: boolean;
}

export interface ProviderConfig {
  readonly premiumModel: string;
  readonly premiumEffort?: string;
  readonly minWeeklyRemainingPercent: number;
  readonly reservePercent: number;
  readonly expectedUsageUntilResetPercent: number;
  readonly minSessionRemainingPercent: number;
  readonly nearResetMinutes: number;
  readonly maxTelemetryAgeMinutes: number;
  readonly hysteresisPercent: number;
  readonly strategy?: Strategy;
  readonly premiumBurnMultiplier?: number;
  readonly paceMarginPercent?: number;
  readonly minPaceElapsedMinutes?: number;
}

export interface SurplusConfig {
  readonly version: 1;
  readonly providers: Readonly<Record<Provider, ProviderConfig>>;
  readonly features: Features;
}

export interface WorkloadForecast {
  readonly provider: Provider;
  readonly resetAt: string;
  readonly expectedUsagePercent: number;
  readonly source: 'explicit' | 'history';
  readonly setAt: string;
}

export interface ProviderState {
  readonly tier: 'default' | 'premium';
  readonly resetAt: string;
  readonly observedAt: string;
}

export interface Decision {
  readonly tier: 'default' | 'premium';
  readonly model: string;
  readonly effort?: string;
  readonly reason: string;
  readonly weeklyRemainingPercent: number | null;
  readonly minutesUntilReset: number | null;
  readonly pace?: Pace;
}

export interface Pace {
  /** Share of the weekly allowance projected to be unused at reset if premium burn applies. */
  readonly projectedUnusedPercent: number;
  /** Minutes before reset the allowance runs out at the current (default-model) rate; absent when it lasts. */
  readonly runsOutBeforeResetMinutes?: number;
}
