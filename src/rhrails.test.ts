/** Robinhood Chain rails: real DexScreener prices, real raw amounts.
 *  Hits the live API on purpose — a mocked price would prove nothing about
 *  whether these three mints are actually quotable. */
import { dexScreenerUsd } from "./quote.js";
import { usdToRaw } from "./math.js";
import type { Asset } from "./config.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

const rh = (symbol: string, mint: string): Asset => ({
  symbol, mint, decimals: 18, feeBps: 0, priceMint: mint,
  network: "eip155:4663", priceSource: "dexscreener", priceChain: "robinhood",
});

const RAILS = [
  rh("ODDBALLER", "0x923eb7BD5B84a1a114CB57212cE2F2e87AE60E2A"),
  rh("IOU", "0xf391999FACbEE613D4024191Dd31060540BF0bEd"),
  rh("ROBINHOODS", "0xC42cF61C16aaC797b991cf9C1ac8Ae70bA74A286"),
];

// a representative counterfactual-priced call (the 60k needle cell, half of direct)
const BILLED_USD = 0.010686;

for (const a of RAILS) {
  const usd = await dexScreenerUsd(a);
  ok(usd > 0, `${a.symbol}: live price $${usd}`);
  const raw = usdToRaw(BILLED_USD, usd, a.decimals);
  ok(raw > 0n, `${a.symbol}: $${BILLED_USD} -> ${raw} raw (${Number(raw) / 1e18} tokens)`);
  // 18-decimal tokens at sub-cent prices produce enormous raw integers; assert
  // we are in bigint territory and have not silently lost precision to a double.
  ok(typeof raw === "bigint", `${a.symbol}: raw amount is bigint, not float`);
}

// chain filter must reject a mint that has no pool on the named chain
const bogus = { ...RAILS[0], priceChain: "ethereum" };
let threw = false;
try { await dexScreenerUsd(bogus); } catch { threw = true; }
ok(threw, "wrong priceChain -> fail-closed, never a silent fallback price");

console.log("\nrh rails selftest OK");
