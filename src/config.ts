/** Env-driven config. Secrets never live in the repo. */

export interface Asset {
  symbol: string;
  mint: string;
  decimals: number;
  /** CAIP-2 network this asset settles on. Defaults to cfg.network (Solana).
   *  Robinhood Chain is eip155:4663 — assets are no longer all one chain. */
  network?: string;
  /** Where spotUsd looks. Birdeye has no Robinhood Chain; DexScreener does. */
  priceSource?: "birdeye" | "dexscreener";
  /** DexScreener chain slug, e.g. "robinhood". */
  priceChain?: string;
  /** Token-2022 transfer-fee basis points (out of 10_000). */
  feeBps: number;
  /**
   * Mint Birdeye should price. For yUSDCx this is USDC (NAV ≈ $1).
   * For the memecoin wrap this is the underlying pump mint — the wrap
   * usually has no market of its own.
   */
  priceMint: string;
  /** If set, treat as $1 stable and skip Birdeye. */
  stableUsd?: number;
}

export interface Config {
  port: number;
  publicUrl: string;
  facilitator: string;
  network: string;
  payTo: string;
  feePayer: string;
  markup: number;
  discount: number;
  floorMultiple: number;
  openrouterKey: string;
  openrouterUrl: string;
  birdeyeKey: string;
  defaultModel: string;
  lecoreUrl: string;
  lecoreKey: string;
  lecoreTenant: string;
  lecoreSpillTokens: number;
  lecoreTopK: number;
  lecoreTailChars: number;
  lecoreChunkChars: number;
  lecoreQueryChars: number;
  lecoreChunkOverlap: number;
  lecoreTimeoutMs: number;
  lecoreRequired: boolean;
  assets: Asset[];
}

const req = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const opt = (k: string, d: string) => process.env[k] || d;

export function loadConfig(): Config {
  const yusdcx: Asset = {
    symbol: "yUSDCx",
    mint: opt("YUSDCX_MINT", "6ZjjxcoicqM4nniddkuPVwew4PDwY3swbfHsGbCuLuTv"),
    decimals: 6,
    feeBps: Number(opt("YUSDCX_FEE_BPS", "20")),
    priceMint: opt("USDC_MINT", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    stableUsd: 1,
  };

  const assets: Asset[] = [yusdcx];

  // --- Robinhood Chain rails (eip155:4663) --------------------------------
  // Verified on-chain 2026-08-14 against rpc.mainnet.chain.robinhood.com:
  // all three are ERC-20, 18 decimals, no transfer fee. Priced by DexScreener
  // (chain slug "robinhood"); Birdeye does not index this chain.
  //
  // ⚠️ THIN LIQUIDITY, and it is why this rail is OPT-IN. At add time the pools
  // held ODDBALLER $317 / IOU $3,380 / ROBINHOODS $5,200. A quote is only as
  // real as the depth behind it: taking payment in a token you cannot sell is
  // taking payment in nothing. RH_RAILS=1 turns them on deliberately.
  if (opt("RH_RAILS", "0") === "1") {
    const RH_NETWORK = opt("RH_NETWORK", "eip155:4663");
    const rh = (symbol: string, mint: string): Asset => ({
      symbol, mint, decimals: 18, feeBps: 0, priceMint: mint,
      network: RH_NETWORK, priceSource: "dexscreener", priceChain: opt("RH_CHAIN_SLUG", "robinhood"),
    });
    assets.push(rh("ODDBALLER", "0x923eb7BD5B84a1a114CB57212cE2F2e87AE60E2A"));
    assets.push(rh("IOU", "0xf391999FACbEE613D4024191Dd31060540BF0bEd"));
    assets.push(rh("ROBINHOODS", "0xC42cF61C16aaC797b991cf9C1ac8Ae70bA74A286"));
  }
  // Wrapped memecoin is OFF until the mint exists and the facilitator
  // allowlists it. Setting MEME_MINT is what turns the rail on.
  if (process.env.MEME_MINT) {
    assets.push({
      symbol: opt("MEME_SYMBOL", "wTOKENx"),
      mint: process.env.MEME_MINT,
      decimals: Number(opt("MEME_DECIMALS", "6")),
      feeBps: Number(opt("MEME_FEE_BPS", "20")),
      priceMint: opt("MEME_UNDERLYING", process.env.MEME_MINT),
    });
  }

  return {
    port: Number(opt("PORT", "8787")),
    publicUrl: opt("PUBLIC_URL", "http://localhost:8787").replace(/\/$/, ""),
    facilitator: opt("X402_FACILITATOR", "https://x402.accrue.fund").replace(/\/$/, ""),
    network: opt("X402_NETWORK", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
    payTo: opt("X402_PAY_TO", "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb"),
    feePayer: opt("X402_FEE_PAYER", "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb"),
    markup: Number(opt("X402_MARKUP", "3")),
    // counterfactual pricing: fraction of what buying this body direct would cost
    discount: Number(opt("X402_DISCOUNT", "0.5")),
    // never price under our own forwarded cost x this
    floorMultiple: Number(opt("X402_FLOOR_MULTIPLE", "1.5")),
    openrouterKey: req("OPENROUTER_API_KEY"),
    openrouterUrl: opt("OPENROUTER_URL", "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    birdeyeKey: opt("BIRDEYE_API_KEY", ""),
    defaultModel: opt("DEFAULT_MODEL", "google/gemini-2.5-flash"),
    // leCore in front: HRR sidecar that spills long bodies before the 402 is
    // priced. Unset -> plain passthrough, byte-identical to today.
    lecoreUrl: opt("LECORE_HRR_URL", "").replace(/\/$/, ""),
    lecoreKey: opt("LECORE_HRR_KEY", ""),
    lecoreTenant: opt("LECORE_TENANT", "zoo"),
    lecoreSpillTokens: Number(opt("LECORE_SPILL_TOKENS", "8000")),
    lecoreTopK: Number(opt("LECORE_TOP_K", "8")),
    // tail = the actual ask kept verbatim; chunk = passage size for the head
    lecoreTailChars: Number(opt("LECORE_TAIL_CHARS", "2000")),
    lecoreChunkChars: Number(opt("LECORE_CHUNK_CHARS", "1200")),
    // the retrieval QUERY is the ask alone, not the whole forwarded tail
    lecoreQueryChars: Number(opt("LECORE_QUERY_CHARS", "400")),
    // overlap >= the longest fact you expect, or boundary-straddling facts vanish
    lecoreChunkOverlap: Number(opt("LECORE_CHUNK_OVERLAP", "300")),
    lecoreTimeoutMs: Number(opt("LECORE_TIMEOUT_MS", "10000")),
    lecoreRequired: opt("LECORE_REQUIRED", "0") === "1",
    assets,
  };
}
