/**
 * Subscription tiers, keys, and entitlement.
 *
 * WHY THIS EXISTS ALONGSIDE x402: pay-per-call is the default and stays the
 * default — no account, no signup. A subscription is the OTHER shape of the
 * same product, for people who want a monthly bill instead of a wallet, and
 * for the thing x402 cannot express: priority. Moose's read is the design
 * brief — do not undercut on price, sell the better lane.
 *
 * A tier grants exactly two things:
 *   1. monthly credit, drawn down per request instead of settling on-chain
 *   2. a retrieval-breadth ceiling (top_k), which is the honest "priority
 *      service" — more of the corpus reaches the model per question
 *
 * Nothing here gates capability. A free x402 caller gets the same models, the
 * same binding, the same answers; a subscriber gets budgeted billing and a
 * wider net. Selling artificial capability locks would be the wrong product.
 */

export interface Tier {
  name: string;
  whopPlanId: string;
  priceUsd: number;
  /** Retrieval breadth ceiling — the paid-for "priority" knob (see topKFor). */
  maxTopK: number;
  /** Monthly inference credit in USD, drawn down instead of an on-chain settle. */
  monthlyCreditUsd: number;
  checkout: string;
}

export const TIERS: Record<string, Tier> = {
  explorer: {
    name: "explorer",
    whopPlanId: "plan_E89VjhFPmT9Rh",
    priceUsd: 19,
    maxTopK: 32,
    monthlyCreditUsd: 25,
    checkout: "https://whop.com/checkout/plan_E89VjhFPmT9Rh",
  },
  builder: {
    name: "builder",
    whopPlanId: "plan_vIiW2mPjOLe9E",
    priceUsd: 49,
    maxTopK: 96,
    monthlyCreditUsd: 75,
    checkout: "https://whop.com/checkout/plan_vIiW2mPjOLe9E",
  },
  scale: {
    name: "scale",
    whopPlanId: "plan_KMI62d2Fy2Qgu",
    priceUsd: 199,
    maxTopK: 256,
    monthlyCreditUsd: 350,
    checkout: "https://whop.com/checkout/plan_KMI62d2Fy2Qgu",
  },
};

const PLAN_TO_TIER = new Map(Object.values(TIERS).map((t) => [t.whopPlanId, t]));

/** A key is `oz_live_<32 hex>`; we store only its sha256, never the key. */
export const KEY_PREFIX = "oz_live_";

export interface KeyRecord {
  keyHash: string;
  tier: string;
  membershipId: string;
  createdAt: number;
  /** Credit consumed this period, in USD. Reset when the period rolls. */
  spentUsd: number;
  periodStart: number;
}

/**
 * Verify a membership with Whop and resolve its tier.
 *
 * Checked LIVE rather than trusted from a webhook payload: a webhook can be
 * replayed or spoofed, and a cancelled subscription must stop working without
 * waiting for us to receive an event.
 */
export async function tierForMembership(
  membershipId: string,
  apiKey: string,
): Promise<{ tier: Tier; valid: boolean; status?: string } | null> {
  const r = await fetch(`https://api.whop.com/api/v2/memberships/${membershipId}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) return null;
  const m = (await r.json()) as { plan?: string; status?: string; valid?: boolean };
  const tier = m.plan ? PLAN_TO_TIER.get(m.plan) : undefined;
  if (!tier) return null;
  // Whop's `valid` covers trialing/active/past-due semantics in one flag.
  return { tier, valid: m.valid === true, status: m.status };
}

/** Ceiling a tier imposes on retrieval breadth, or the free default. */
export function maxTopKFor(tier: Tier | null, freeDefault: number): number {
  return tier ? tier.maxTopK : freeDefault;
}

/** Does this subscriber have credit left this period? */
export function hasCredit(rec: KeyRecord, tier: Tier): boolean {
  return rec.spentUsd < tier.monthlyCreditUsd;
}

/** Roll the billing period if a month has elapsed. Mutates and returns rec. */
export function rollPeriod(rec: KeyRecord, now = Date.now()): KeyRecord {
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  if (now - rec.periodStart >= THIRTY_DAYS) {
    rec.periodStart = now;
    rec.spentUsd = 0;
  }
  return rec;
}
