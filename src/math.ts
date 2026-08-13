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

/** Ceiling conversion of a USD bill into raw token units at a USD spot. */
export function usdToRaw(usd: number, tokenUsd: number, decimals: number): bigint {
  if (!(tokenUsd > 0) || !Number.isFinite(tokenUsd)) throw new Error("no spot");
  if (!(usd >= 0) || !Number.isFinite(usd)) throw new Error("bad usd");
  const raw = (usd / tokenUsd) * 10 ** decimals;
  const ceil = Math.ceil(raw);
  if (!Number.isFinite(ceil) || ceil > Number.MAX_SAFE_INTEGER) throw new Error("amount overflow");
  return BigInt(Math.max(1, ceil));
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
