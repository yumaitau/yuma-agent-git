import { MICROS_PER_SECOND } from '../ci/config';

/**
 * Price table for usage events (issue #61), versioned: each event stores the
 * version that priced it, and a new version is a new entry here, never an
 * edit, so old reports keep their numbers. Model prices are USD micros per
 * million tokens. "Subscription" models (ChatGPT and Claude plans used
 * through their usage windows) are recorded at zero dollars with full token
 * counts. A model or instance not listed is recorded unpriced (NULL dollars).
 */

export interface ModelPrice {
  input: number;
  output: number;
  cached: number;
  billing: 'metered' | 'subscription';
}

export interface PriceVersion {
  version: string;
  /** Events at or after this time (ms) use this version. */
  from: number;
  models: Record<string, ModelPrice>;
  /** CI compute, USD micros per second, by runner kind. */
  instances: Record<string, number>;
  /** Stored bytes, USD micros per GB-month (a `storage` event is one day). */
  storage_gb_month: number;
}

const SUBSCRIPTION: ModelPrice = {
  input: 0,
  output: 0,
  cached: 0,
  billing: 'subscription',
};

export const PRICES: readonly PriceVersion[] = [
  {
    version: '2026-10-01',
    from: 0,
    models: {
      // Workers AI list price for the default agent model
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast': {
        input: 293_000,
        output: 2_253_000,
        cached: 293_000,
        billing: 'metered',
      },
      'chatgpt-subscription': SUBSCRIPTION,
      'claude-subscription': SUBSCRIPTION,
    },
    instances: {
      // the built-in container pool, at the rate CI reserves against (ci/config.ts)
      builtin: MICROS_PER_SECOND,
      // self-hosted runners run on the customer's own machines
      self_hosted: 0,
    },
    // R2 standard storage list price
    storage_gb_month: 15_000,
  },
];

/** The price version in force at `at`. */
export function priceVersionAt(at: number): PriceVersion {
  let chosen = PRICES[0]!;
  for (const version of PRICES) if (version.from <= at) chosen = version;
  return chosen;
}

/** USD micros for a token event, or null when the model has no price. */
export function tokenCost(
  version: PriceVersion,
  model: string | null,
  tokens: { input: number; output: number; cached: number },
  billing: 'metered' | 'subscription',
): number | null {
  if (billing === 'subscription') return 0;
  const price = model ? version.models[model] : undefined;
  if (!price) return null;
  if (price.billing === 'subscription') return 0;
  return Math.round(
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cached * price.cached) /
      1_000_000,
  );
}

/** USD micros for keeping `bytes` stored for one day. */
export function storageDayCost(version: PriceVersion, bytes: number): number {
  return Math.round((bytes * version.storage_gb_month) / 1e9 / 30);
}
