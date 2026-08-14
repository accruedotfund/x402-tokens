// Live verification of the failed-settle path: a structurally VALID payment
// from a fresh, unfunded derived wallet. verify() passes (signature, single
// TransferChecked, amount == maxAmountRequired), settle simulation fails
// (no funds), and the gateway must now return a clean 402 "payment failed:"
// instead of serving free inference. Nothing can move: the wallet is empty.
import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const GATEWAY = process.env.GATEWAY || "https://x402-tokens.fly.dev";
const RPC = process.env.OPENZOO_RPC || "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");

// 1. get the live 402
const first = await fetch(`${GATEWAY}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
});
console.log("unpaid status:", first.status);
const chal = await first.json();
const accept = chal.accepts.find((a) => a.extra?.symbol === "yUSDCx");
console.log("quoted:", accept.maxAmountRequired, "raw", accept.extra.symbol, "-> payTo", accept.payTo);

// 2. underfunded derived wallet, structurally valid payment
const broke = Keypair.generate();
console.log("derived (unfunded) payer:", broke.publicKey.toBase58());
const mint = new PublicKey(accept.asset);
const src = getAssociatedTokenAddressSync(mint, broke.publicKey, false, TOKEN_2022_PROGRAM_ID);
const dst = getAssociatedTokenAddressSync(mint, new PublicKey(accept.payTo), true, TOKEN_2022_PROGRAM_ID);
const ix = createTransferCheckedInstruction(src, mint, dst, broke.publicKey, BigInt(accept.maxAmountRequired), 6, [], TOKEN_2022_PROGRAM_ID);
const { blockhash } = await conn.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer: new PublicKey(accept.extra.feePayer), recentBlockhash: blockhash });
tx.add(ix);
tx.partialSign(broke);
const header = Buffer.from(JSON.stringify({
  x402Version: 1, scheme: accept.scheme, network: accept.network,
  payload: { transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") },
})).toString("base64");

// 3. paid attempt -> must be 402 "payment failed:", never model output
const paid = await fetch(`${GATEWAY}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-payment": header },
  body: JSON.stringify({ model: "google/gemini-2.5-flash", messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
});
const body = await paid.json();
console.log("\npaid-attempt status:", paid.status);
console.log("error:", body.error);
console.log("has model output (choices):", "choices" in body);
if (paid.status === 402 && String(body.error).startsWith("payment failed: ") && !("choices" in body)) {
  console.log("\nFAILED-SETTLE PATH OK: clean 402, no free inference");
} else {
  console.error("\nUNEXPECTED — inspect above");
  process.exit(1);
}
