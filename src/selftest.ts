import { estimateTokens, grossUp, openrouterUsd, usdToRaw } from "./math.js";

let fails = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  const ok = Object.is(a, b) || a === b;
  if (!ok) {
    fails++;
    console.log(`FAIL ${m}: got ${a} want ${b}`);
  }
};

eq(estimateTokens("abcd"), 1, "4 chars = 1 token");
eq(estimateTokens("abcdefgh"), 2, "8 chars = 2 tokens");

const usd = openrouterUsd(0.00000015, 0.0000006, 100, 50);
eq(Number(usd.toFixed(10)), 0.000045, "openrouter usd");
eq(Number((usd * 3).toFixed(10)), 0.000135, "3x markup");

eq(usdToRaw(1, 1, 6), 1_000_000n, "$1 of a $1/6dp token");
eq(usdToRaw(0.000135, 1, 6), 135n, "tiny 3x bill in yUSDCx");
eq(usdToRaw(0.003, 0.001, 6), 3_000_000n, "$0.003 of a $0.001 token");

eq(grossUp(10000n, 0), 10000n, "no fee");
eq(grossUp(10000n, 20), 10021n, "20 bps gross-up");
eq(grossUp(1n, 20), 2n, "1 raw still grosses");

if (fails) {
  console.log(`${fails} failed`);
  process.exit(1);
}
console.log("selftest ok");
