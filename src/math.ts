/** Pure quote maths. No I/O — selftest hits these. */

export function estimateTokens(messages: unknown): number {
  const s = typeof messages === "string" ? messages : JSON.stringify(messages ?? "");
  return Math.max(1, Math.ceil(s.length / 4));
}

export function openrouterUsd(promptPrice: number, completionPrice: number, promptTokens: number, maxOut: number): number {
  const usd = promptTokens * promptPrice + maxOut * completionPrice;
  if (!Number.isFinite(usd) || usd < 0) throw new Error("bad openrouter price");
  return usd;
}

/** Ceiling conversion of a USD bill into raw token units at a USD spot.
 *
 *  DONE IN BIGINT, not float64. The previous version computed
 *  `(usd / tokenUsd) * 10 ** decimals` as a double and rejected anything past
 *  Number.MAX_SAFE_INTEGER as "amount overflow". That holds for 6-decimal
 *  Solana mints, and breaks the moment an 18-decimal EVM token is cheap:
 *  MEASURED, $0.010686 of ODDBALLER at $5.712e-8 is 1.87e23 raw units, ~2e7x
 *  past 2^53. It was never an overflow, it was the wrong number type — and a
 *  payment rail that throws on a legitimate quote silently drops that asset.
 *
 *  USD and spot are carried at 1e12 fixed point (ample for sub-nano prices);
 *  a spot that rounds to zero there fails closed rather than dividing by it. */
const FX = 1_000_000_000_000n; // 1e12

export function usdToRaw(usd: number, tokenUsd: number, decimals: number): bigint {
  if (!(tokenUsd > 0) || !Number.isFinite(tokenUsd)) throw new Error("no spot");
  if (!(usd >= 0) || !Number.isFinite(usd)) throw new Error("bad usd");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("bad decimals");
  const spotFx = BigInt(Math.round(tokenUsd * Number(FX)));
  if (spotFx <= 0n) throw new Error("spot rounds to zero at 1e-12 — refusing to price");
  const usdFx = BigInt(Math.round(usd * Number(FX)));
  const num = usdFx * 10n ** BigInt(decimals);
  const raw = (num + spotFx - 1n) / spotFx; // ceiling
  return raw > 0n ? raw : 1n;
}

/**
 * Token-2022 transfer-fee gross-up. `feeBps` is out of 10_000.
 * Sign `gross` so the destination receives `net` after withhold.
 */
export function grossUp(net: bigint, feeBps: number): bigint {
  if (feeBps <= 0) return net;
  if (feeBps >= 10_000) throw new Error("fee bps >= 100%");
  return (net * 10_000n + BigInt(10_000 - feeBps) - 1n) / BigInt(10_000 - feeBps);
}
