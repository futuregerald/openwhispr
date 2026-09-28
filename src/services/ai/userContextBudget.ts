const SELF_HOSTED_PROVIDERS = new Set(["lan", "custom"]);

export function budgetTokensForProvider(providerId: string): number {
  return SELF_HOSTED_PROVIDERS.has(providerId) ? NaN : Infinity;
}

export function budgetTokensForSelfHostedMode(mode: string): number {
  return mode === "self-hosted" ? NaN : Infinity;
}
