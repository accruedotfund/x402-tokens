/** Env-driven config. Secrets never live in the repo. */

export interface Asset {
  symbol: string;
  mint: string;
  decimals: number;
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
  openrouterKey: string;
  openrouterUrl: string;
  birdeyeKey: string;
  defaultModel: string;
  lecoreUrl: string;
  lecoreKey: string;
  lecoreSpillTokens: number;
  lecoreTopK: number;
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
    openrouterKey: req("OPENROUTER_API_KEY"),
    openrouterUrl: opt("OPENROUTER_URL", "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    birdeyeKey: opt("BIRDEYE_API_KEY", ""),
    defaultModel: opt("DEFAULT_MODEL", "google/gemini-2.5-flash"),
    // leCore in front: HRR sidecar that spills long bodies before the 402 is
    // priced. Unset -> plain passthrough, byte-identical to today.
    lecoreUrl: opt("LECORE_HRR_URL", "").replace(/\/$/, ""),
    lecoreKey: opt("LECORE_HRR_KEY", ""),
    lecoreSpillTokens: Number(opt("LECORE_SPILL_TOKENS", "8000")),
    lecoreTopK: Number(opt("LECORE_TOP_K", "8")),
    lecoreTimeoutMs: Number(opt("LECORE_TIMEOUT_MS", "10000")),
    lecoreRequired: opt("LECORE_REQUIRED", "0") === "1",
    assets,
  };
}
