/** Robinhood Chain rails: real DexScreener prices, real raw amounts.
 *  Hits the live API on purpose — a mocked price would prove nothing about
 *  whether these three mints are actually quotable. */
import { dexScreenerUsd } from "./quote.js";
import { usdToRaw } from "./math.js";
import type { Asset } from "./config.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

// Rows now settle via the X402Wrapper twins (mint = twin, priced off the
// underlying — the twin has no market and NAV >= 1 underlying per share).
const rh = (symbol: string, twin: string, underlying: string): Asset => ({
  symbol, mint: twin, decimals: 18, feeBps: 2, priceMint: underlying,
  network: "eip155:4663", priceSource: "dexscreener", priceChain: "robinhood",
  eip712: { name: `Wrapped ${symbol} (x402)`, version: "1" },
});

const RAILS = [
  rh("ODDBALLER", "0x1AE410a93C8b05c872D2FE2718e9BB66392AF903", "0x923eb7BD5B84a1a114CB57212cE2F2e87AE60E2A"),
  rh("IOU", "0x90c2B5DA6097DbbB3632469108A38F4F91eD0434", "0xf391999FACbEE613D4024191Dd31060540BF0bEd"),
  rh("ROBINHOODS", "0xD906653C147cF35329161665a4AaaAd3bc118743", "0xC42cF61C16aaC797b991cf9C1ac8Ae70bA74A286"),
];

// a representative counterfactual-priced call (the 60k needle cell, half of direct)
const BILLED_USD = 0.010686;

let priced = 0;
for (const a of RAILS) {
  let usd: number;
  try {
    usd = await dexScreenerUsd(a);
  } catch (e) {
    // A pool can vanish (IOU's did, 2026-08-14). The contract with the quote
    // path is fail-closed per asset: no live spot -> the row drops out of
    // accepts[]. That is correct behavior, not a test failure — but at least
    // one rail must still be quotable or the whole chain is dark.
    console.log(`ok - ${a.symbol}: no live pool -> row fails closed (${(e as Error).message})`);
    continue;
  }
  priced++;
  ok(usd > 0, `${a.symbol}: live price $${usd}`);
  const raw = usdToRaw(BILLED_USD, usd, a.decimals);
  ok(raw > 0n, `${a.symbol}: $${BILLED_USD} -> ${raw} raw (${Number(raw) / 1e18} tokens)`);
  // 18-decimal tokens at sub-cent prices produce enormous raw integers; assert
  // we are in bigint territory and have not silently lost precision to a double.
  ok(typeof raw === "bigint", `${a.symbol}: raw amount is bigint, not float`);
}
ok(priced >= 1, `at least one Robinhood rail is live-priceable (${priced}/3)`);

// chain filter must reject a mint that has no pool on the named chain
const bogus = { ...RAILS[0], priceChain: "ethereum" };
let threw = false;
try { await dexScreenerUsd(bogus); } catch { threw = true; }
ok(threw, "wrong priceChain -> fail-closed, never a silent fallback price");

// --- X402Wrapper twin math -------------------------------------------------
// The twins (see /Users/stacc/x402-wrappers) charge a transfer fee of 200 ppm
// DEDUCTED from the signed value, rounded UP: delivered = v - ceil(v*200/1e6).
// The 402 row carries feeBps=2 and the gateway grosses up with grossUp(net, 2).
// Property: for any net amount, the grossed-up value always delivers >= net.
{
  const { grossUp } = await import("./math.js");
  const PPM = 200n;
  const delivered = (v: bigint) => v - (v * PPM + 999_999n) / 1_000_000n; // ceil fee
  const cases: bigint[] = [1n, 2n, 999n, 1000n, 1001n, 4999n, 5000n, 9997n, 9998n, 10_000n];
  // representative 18-decimal magnitudes, incl. the measured ODDBALLER quote
  cases.push(187_000_000_000_000_000_000_000n, 10n ** 18n, 10n ** 18n + 1n, 123_456_789_012_345_678_901n);
  for (let i = 0n; i < 10_000n; i++) cases.push(i * 977n + 1n); // dense sweep
  let worstOver = 0n;
  for (const net of cases) {
    const gross = grossUp(net, 2);
    const got = delivered(gross);
    if (got < net) ok(false, `twin gross-up UNDER-delivers: net=${net} gross=${gross} delivered=${got}`);
    if (got - net > worstOver) worstOver = got - net;
  }
  ok(worstOver <= 2n, `twin gross-up: ${cases.length} nets all delivered >= net, max overshoot +${worstOver} raw`);
}

console.log("\nrh rails selftest OK");
