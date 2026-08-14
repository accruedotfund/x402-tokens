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
  /** "counterfactual" = discounted against what buying direct would cost. */
  pricing: "markup" | "counterfactual";
  directUsd?: number;
  discount?: number;
  savesVsDirect?: number;
  flooredAtCost?: boolean;
}

export async function quoteRequest(
  cfg: Config,
  body: { model?: string; messages?: unknown; max_tokens?: number },
  counterfactualTokens?: number,
): Promise<Quote> {
  const modelId = body.model || cfg.defaultModel;
  const model = await getModel(cfg.openrouterUrl, cfg.openrouterKey, modelId);
  const promptTokens = estimateTokens(body.messages);
  const maxOut = Math.min(Math.max(1, Number(body.max_tokens ?? 256)), 4096);
  const baseUsd = openrouterUsd(model.prompt, model.completion, promptTokens, maxOut);

  // COUNTERFACTUAL PRICING. A markup on the tokens we forward is
  // anti-correlated with a product whose whole job is to forward fewer tokens:
  // MEASURED on a 60k needle, leCore cut a $0.021372 direct call to $0.000367 of
  // real cost, so the same 3x markup that earned $0.042744/call without leCore
  // earned $0.000734 WITH it -- shipping the feature cut revenue 58x. Charging
  // 2x post-spill makes it worse, not better.
  //
  // So when leCore engaged we price against what the caller WOULD have paid
  // buying this body direct (counterfactualTokens = pre-spill), discounted.
  // At discount 0.5 the caller pays half of list and we clear ~14x today's
  // margin. This is value-based pricing and the storefront must say so in those
  // words -- "half the price of buying direct", never "3x provider take", which
  // becomes a lie the moment someone computes the real token spend.
  //
  // The floor exists because a discount on a pathological body could otherwise
  // price under our own cost.
  const direct = counterfactualTokens && counterfactualTokens > promptTokens
    ? openrouterUsd(model.prompt, model.completion, counterfactualTokens, maxOut)
    : null;
  const counterfactual = direct !== null && cfg.discount > 0;
  const floorUsd = baseUsd * cfg.floorMultiple;
  const billedUsd = counterfactual
    ? Math.max(direct * cfg.discount, floorUsd)
    : baseUsd * cfg.markup;
  const pricedAt = new Date().toISOString();

  const accepts: QuoteLine[] = [];
  for (const a of cfg.assets) {
    const tokenUsd = a.stableUsd ?? 1;
    const net = usdToRaw(billedUsd, tokenUsd, a.decimals);
    const gross = grossUp(net, a.feeBps);
    accepts.push({
      symbol: a.symbol,
      mint: a.mint,
      network: a.network ?? cfg.network,
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
    pricing: counterfactual ? "counterfactual" : "markup",
    directUsd: direct ?? undefined,
    discount: counterfactual ? cfg.discount : undefined,
    savesVsDirect: direct ? direct / billedUsd : undefined,
    flooredAtCost: counterfactual ? direct * cfg.discount < floorUsd : undefined,
  };
}

/** Live USD from DexScreener, picking the DEEPEST pool. Fail-closed.
 *
 *  Deepest, not first: a token can quote on two DEXes at different prices with
 *  wildly different depth (measured at add time: ROBINHOODS was $0.000005463 on
 *  a $5,200 uniswap pool and $0.000005531 on a $71 pancakeswap pool). Pricing a
 *  payment off the $71 pool is pricing off noise. */
export async function dexScreenerUsd(a: Asset): Promise<number> {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${a.priceMint}`);
  if (!r.ok) throw new Error(`dexscreener ${r.status} for ${a.symbol}`);
  const j = (await r.json()) as { pairs?: Array<{ chainId?: string; priceUsd?: string; liquidity?: { usd?: number } }> };
  const pools = (j.pairs ?? []).filter(
    (p) => (!a.priceChain || p.chainId === a.priceChain) && Number(p.priceUsd) > 0,
  );
  if (!pools.length) throw new Error(`dexscreener has no ${a.priceChain ?? ""} pool for ${a.symbol}`);
  pools.sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0));
  const best = pools[0];
  const usd = Number(best.priceUsd);
  if (!(usd > 0)) throw new Error(`dexscreener gave no usable price for ${a.symbol}`);
  return usd;
}

/** Live USD for a non-stable. Fail-closed on every source. */
export async function spotUsd(cfg: Config, a: Asset): Promise<number> {
  if (a.stableUsd) return a.stableUsd;
  if (a.priceSource === "dexscreener") return dexScreenerUsd(a);
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

export async function quoteLive(cfg: Config, body: { model?: string; messages?: unknown; max_tokens?: number }, counterfactualTokens?: number): Promise<Quote> {
  const q = await quoteRequest(cfg, body, counterfactualTokens);
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
