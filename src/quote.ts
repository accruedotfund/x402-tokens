import type { Asset, Config } from "./config.js";
import { estimateTokens, grossUp, openrouterUsd, usdToRaw } from "./math.js";
import { getModel } from "./openrouter.js";

export interface QuoteLine {
  symbol: string;
  mint: string;
  network: string;
  decimals: number;
  tokenUsd: number;
  billedUsd: number;
  netRaw: string;
  grossRaw: string;
  feeBps: number;
  pricedAt: string;
}

export interface Quote {
  model: string;
  promptTokensEst: number;
  maxOut: number;
  openrouterUsd: number;
  markup: number;
  billedUsd: number;
  pricedAt: string;
  accepts: QuoteLine[];
}

export async function quoteRequest(cfg: Config, body: { model?: string; messages?: unknown; max_tokens?: number }): Promise<Quote> {
  const modelId = body.model || cfg.defaultModel;
  const model = await getModel(cfg.openrouterUrl, cfg.openrouterKey, modelId);
  const promptTokens = estimateTokens(body.messages);
  const maxOut = Math.min(Math.max(1, Number(body.max_tokens ?? 256)), 4096);
  const baseUsd = openrouterUsd(model.prompt, model.completion, promptTokens, maxOut);
  const billedUsd = baseUsd * cfg.markup;
  const pricedAt = new Date().toISOString();

  const accepts: QuoteLine[] = [];
  for (const a of cfg.assets) {
    const tokenUsd = a.stableUsd ?? 1;
    const net = usdToRaw(billedUsd, tokenUsd, a.decimals);
    const gross = grossUp(net, a.feeBps);
    accepts.push({
      symbol: a.symbol,
      mint: a.mint,
      network: cfg.network,
      decimals: a.decimals,
      tokenUsd,
      billedUsd,
      netRaw: net.toString(),
      grossRaw: gross.toString(),
      feeBps: a.feeBps,
      pricedAt,
    });
  }
  return {
    model: modelId,
    promptTokensEst: promptTokens,
    maxOut,
    openrouterUsd: baseUsd,
    markup: cfg.markup,
    billedUsd,
    pricedAt,
    accepts,
  };
}

/** Live USD for a non-stable. Birdeye, fail-closed. */
export async function spotUsd(cfg: Config, a: Asset): Promise<number> {
  if (a.stableUsd) return a.stableUsd;
  if (!cfg.birdeyeKey) throw new Error("BIRDEYE_API_KEY required to price " + a.symbol);
  const u = new URL("https://public-api.birdeye.so/defi/price");
  u.searchParams.set("address", a.priceMint);
  const r = await fetch(u, { headers: { "X-API-KEY": cfg.birdeyeKey, "x-chain": "solana" } });
  if (!r.ok) throw new Error(`birdeye ${r.status}`);
  const j = (await r.json()) as { success?: boolean; data?: { value?: number } };
  const v = j.data?.value;
  if (!j.success || !(typeof v === "number") || !(v > 0)) throw new Error("birdeye gave no price for " + a.priceMint);
  return v;
}

export async function quoteLive(cfg: Config, body: { model?: string; messages?: unknown; max_tokens?: number }): Promise<Quote> {
  const q = await quoteRequest(cfg, body);
  for (const line of q.accepts) {
    const a = cfg.assets.find((x) => x.mint === line.mint);
    if (!a || a.stableUsd) continue;
    const tokenUsd = await spotUsd(cfg, a);
    const net = usdToRaw(q.billedUsd, tokenUsd, a.decimals);
    line.tokenUsd = tokenUsd;
    line.netRaw = net.toString();
    line.grossRaw = grossUp(net, a.feeBps).toString();
  }
  return q;
}
