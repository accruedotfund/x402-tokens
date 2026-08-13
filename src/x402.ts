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
    markup: number;
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
    description: `OpenRouter ${q.model} × ${cfg.markup} at ${a.pricedAt}`,
    maxTimeoutSeconds: 120,
    extra: {
      facilitator: cfg.facilitator,
      feePayer: cfg.feePayer,
      symbol: a.symbol,
      billedUsd: a.billedUsd,
      tokenUsd: a.tokenUsd,
      pricedAt: a.pricedAt,
      markup: cfg.markup,
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

export async function verify(cfg: Config, header: string, reqs: Requirements[]): Promise<{ ok: boolean; reason?: string; picked?: Requirements }> {
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
    const j = (await r.json()) as { isValid?: boolean; invalidReason?: string };
    return { ok: !!j.isValid, reason: j.invalidReason, picked };
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
