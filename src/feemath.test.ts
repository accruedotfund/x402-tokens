/** Fee math vs the ACTUAL Token-2022 rounding, plus the spot-price cache.
 *
 *  1. grossUp must survive Token-2022's own fee rule (fee = ceil(amount*bps/1e4),
 *     verified 20bps on-chain for yUSDCx 6Zjjx…LuTv on 2026-08-14): for every
 *     net, payTo must receive >= net after withhold, and never absurdly more.
 *     This clears the fee-accounting suspicion on the 8 failed settles — the
 *     quote's maxAmountRequired is gross, receipt is net, and the math holds
 *     for every amount, so short-received was never the failure mode.
 *
 *  2. spotUsdCached: fresh within TTL (one upstream hit), soft-stale on
 *     price-API failure (429 must not 500 a quote), fail-closed past the bound.
 */
import { grossUp } from "./math.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };

// --- 1. gross-up sweep against Token-2022 ceiling fee ---------------------
const t22fee = (amount: bigint, bps: bigint) => (amount * bps + 9_999n) / 10_000n; // ceil, uncapped maximumFee (yUSDCx: u64::MAX)

let worstOver = 0n;
const check = (net: bigint, bps: number) => {
  const gross = grossUp(net, bps);
  const received = gross - t22fee(gross, BigInt(bps));
  if (received < net) { console.error(`FAIL net=${net} bps=${bps}: received ${received} < net`); process.exit(1); }
  const over = received - net;
  if (over > worstOver) worstOver = over;
};
for (let net = 1n; net <= 50_000n; net++) check(net, 20);
for (const net of [999_999n, 1_000_000n, 123_456_789n, 10n ** 15n, 10n ** 18n]) {
  check(net, 20); check(net, 1); check(net, 100); check(net, 9_999);
}
ok(true, "received >= net for every swept amount (20bps + edge bps)");
ok(worstOver <= 2n, `gross-up is tight: worst over-delivery ${worstOver} raw units`);

// --- 2. spot cache: fresh TTL, soft-stale fallback, bounded ---------------
process.env.SPOT_TTL_MS = "60000";
process.env.SPOT_STALE_MAX_MS = "600000";
const { spotUsdCached, _clearSpotCache } = await import("./quote.js");
type Asset = import("./config.js").Asset;
type Config = import("./config.js").Config;

let fetches = 0;
let mode: "ok" | "429" = "ok";
const origFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetches++;
  if (mode === "429") return new Response("rate limited", { status: 429 });
  return new Response(JSON.stringify({ success: true, data: { value: 0.5 } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const cfg = { birdeyeKey: "k" } as unknown as Config;
const asset = { symbol: "wTOKENx", mint: "MEME_MINT", decimals: 6, feeBps: 20, priceMint: "UNDERLYING" } as Asset;

_clearSpotCache();
const first = await spotUsdCached(cfg, asset);
ok(first.usd === 0.5 && !first.stale && fetches === 1, "first quote hits the price API");
const second = await spotUsdCached(cfg, asset);
ok(second.usd === 0.5 && !second.stale && fetches === 1, "second quote inside TTL is served from cache (no API hit)");

mode = "429";
process.env.SPOT_TTL_MS = "0"; // force TTL expiry so the 429 path runs
const stale = await spotUsdCached(cfg, asset);
ok(stale.usd === 0.5 && stale.stale === true, "429 with a recent price -> soft-stale last-known price, NOT a 500");
ok(stale.at === first.at, "stale result reports when the spot was actually fetched");

process.env.SPOT_STALE_MAX_MS = "0"; // price now older than the bound
let threw = false;
try { await spotUsdCached(cfg, asset); } catch { threw = true; }
ok(threw, "past the staleness bound the quote fails closed, as before");

globalThis.fetch = origFetch;
console.log("feemath + spot-cache selftest OK");
