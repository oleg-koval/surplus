export type Provider = 'claude' | 'codex';

export interface UsageSnapshot {
  readonly provider: Provider;
  readonly observedAt: string;
  readonly weeklyUsedPercent: number;
  readonly resetsAt: string;
  readonly sessionUsedPercent?: number;
  readonly sessionResetsAt?: string;
  readonly identityHash?: string;
  readonly usageAllowed: boolean | null;
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
}

export interface SurplusConfig {
  readonly version: 1;
  readonly providers: Readonly<Record<Provider, ProviderConfig>>;
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
}
