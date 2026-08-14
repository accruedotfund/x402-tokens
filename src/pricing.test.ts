/** Counterfactual pricing: the caller must SAVE and we must EARN MORE.
 *  Numbers are the measured 60k-needle cell (70,906 tok direct -> 890 forwarded). */
import { quoteRequest } from "./quote.js";
import type { Config } from "./config.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };
const usd = (n: number) => `$${n.toFixed(6)}`;

// gemini-2.5-flash raw rates; stub the model lookup by pre-seeding the cache is
// overkill, so hit the same math the quote uses via a fake Config + real fetch
// is avoided entirely: quoteRequest calls getModel, so we monkeypatch fetch.
const P = 3e-7, C = 2.5e-6;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (u: string | URL | Request) => {
  const url = String(u);
  if (url.includes("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "m", pricing: { prompt: String(P), completion: String(C) }, context_length: 1000000 }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error("unexpected fetch " + url);
}) as typeof fetch;

const base = {
  openrouterUrl: "https://x/api/v1", openrouterKey: "k", defaultModel: "m",
  markup: 3, discount: 0.5, floorMultiple: 1.5, assets: [],
  network: "n", payTo: "p", feePayer: "f", facilitator: "https://f",
} as unknown as Config;

// A body whose FORWARDED size is 890 tokens (~3,560 chars) and whose PRE-SPILL
// size was 70,906 tokens.
const forwarded = { model: "m", max_tokens: 40, messages: [{ role: "user", content: "x".repeat(890 * 4) }] };
const BEFORE = 70906;

const direct = BEFORE * P + 40 * C;          // what buying this body direct costs
const ourCost = 890 * P + 40 * C;            // what we actually spend

console.log(`direct=${usd(direct)}  ourCost=${usd(ourCost)}  (${(direct / ourCost).toFixed(0)}x)\n`);

// --- today's model: markup on the forwarded slice ---
const oldQ = await quoteRequest(base, forwarded);
ok(oldQ.pricing === "markup", "no counterfactual -> markup pricing (unchanged behaviour)");
const oldProfit = oldQ.billedUsd - ourCost;
console.log(`  markup 3x post-spill : user pays ${usd(oldQ.billedUsd)}  profit ${usd(oldProfit)}`);

// --- new model: discount off the counterfactual ---
const newQ = await quoteRequest(base, forwarded, BEFORE);
ok(newQ.pricing === "counterfactual", "counterfactual tokens -> counterfactual pricing");
const newProfit = newQ.billedUsd - ourCost;
console.log(`  50% of direct        : user pays ${usd(newQ.billedUsd)}  profit ${usd(newProfit)}`);

ok(newQ.billedUsd < direct, `caller pays LESS than direct (${usd(newQ.billedUsd)} < ${usd(direct)})`);
ok(Math.abs((newQ.savesVsDirect ?? 0) - 2) < 0.01, `caller saves ~2x (${newQ.savesVsDirect?.toFixed(2)}x)`);
ok(newProfit > oldProfit * 10, `we earn >10x today's margin (${(newProfit / oldProfit).toFixed(1)}x)`);
ok(newQ.billedUsd > ourCost, "never priced under our own cost");

// --- floor: a body that barely spilled must not price under cost ---
const tinySpill = await quoteRequest(base, forwarded, 900);
ok(tinySpill.flooredAtCost === true, "near-zero spill -> floor engages");
ok(tinySpill.billedUsd >= (890 * P + 40 * C) * base.floorMultiple - 1e-12, "floor >= cost x floorMultiple");

// --- discount 0 disables the whole path ---
const off = await quoteRequest({ ...base, discount: 0 } as Config, forwarded, BEFORE);
ok(off.pricing === "markup", "X402_DISCOUNT=0 -> falls back to markup");

globalThis.fetch = origFetch;
console.log(`\nprofit per 1,000 calls: markup ${usd(oldProfit * 1000)} -> counterfactual ${usd(newProfit * 1000)}`);
console.log("pricing selftest OK");
