import type { Config } from "./config.js";
import type { Quote } from "./quote.js";

export interface Requirements {
  scheme: "exact";
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
  extra: {
    facilitator: string;
    feePayer: string;
    symbol: string;
    billedUsd: number;
    tokenUsd: number;
    pricedAt: string;
    /** price API was unreachable; this line rode the last-known spot
     *  (pricedAt names when that spot was fetched). */
    priceStale?: boolean;
    /** how this price was formed. "counterfactual" = a DISCOUNT off what
     *  buying this body direct would cost, not a markup on what we forward. */
    pricing: "markup" | "counterfactual";
    directUsd?: number;
    savesVsDirect?: number;
    markup?: number;
  };
}

export function requirements(cfg: Config, q: Quote, resource: string): Requirements[] {
  return q.accepts.map((a) => ({
    scheme: "exact" as const,
    network: a.network,
    asset: a.mint,
    maxAmountRequired: a.grossRaw,
    payTo: cfg.payTo,
    resource,
    description: q.pricing === "counterfactual"
      ? `${q.model} — ${(q.savesVsDirect ?? 1).toFixed(1)}× cheaper than buying direct, at ${a.pricedAt}`
      : `OpenRouter ${q.model} × ${cfg.markup} at ${a.pricedAt}`,
    maxTimeoutSeconds: 120,
    extra: {
      facilitator: cfg.facilitator,
      feePayer: cfg.feePayer,
      symbol: a.symbol,
      billedUsd: a.billedUsd,
      tokenUsd: a.tokenUsd,
      pricedAt: a.pricedAt,
      priceStale: a.priceStale,
      // Advertising a markup while running a ~29x gross margin is a lie the
      // first time someone counts tokens. State the basis, and only quote a
      // multiplier when a multiplier is actually what formed the price.
      pricing: q.pricing,
      directUsd: q.directUsd,
      savesVsDirect: q.savesVsDirect,
      markup: q.pricing === "markup" ? cfg.markup : undefined,
    },
  }));
}

export function challenge(cfg: Config, q: Quote, resource: string, error = "payment required") {
  return {
    x402Version: 1,
    accepts: requirements(cfg, q, resource),
    error,
    help: `Don't hold yUSDCx yet? ${cfg.facilitator}/start — or wrap USDC. This is 3× OpenRouter, priced at this 402.`,
  };
}

export async function verify(cfg: Config, header: string, reqs: Requirements[]): Promise<{ ok: boolean; reason?: string; picked?: Requirements; payer?: string }> {
  let payload: { network?: string; payload?: unknown };
  try {
    payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed X-PAYMENT header" };
  }
  const picked = reqs.find((r) => r.network === payload.network) ?? reqs[0];
  if (!picked) return { ok: false, reason: "no matching requirements" };
  try {
    const r = await fetch(`${cfg.facilitator}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: picked }),
    });
    const j = (await r.json()) as { isValid?: boolean; invalidReason?: string; payer?: string };
    return { ok: !!j.isValid, reason: j.invalidReason, picked, payer: j.payer };
  } catch (e) {
    return { ok: false, reason: `facilitator unreachable: ${(e as Error).message.slice(0, 80)}` };
  }
}

export async function settle(cfg: Config, header: string, picked: Requirements) {
  const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const r = await fetch(`${cfg.facilitator}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: payload, paymentRequirements: picked }),
  });
  return r.json().catch(() => ({ success: false }));
}
