/**
 * Pay the live 402 in yUSDCx and print the completion.
 *
 *   SERVICE=http://127.0.0.1:8787 node scripts/pay.mjs
 */
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createTransferCheckedInstruction, getAccount,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";

const SERVICE = (process.env.SERVICE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/jjj.json", "utf8")))
);
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

const body = {
  model: process.env.MODEL || "google/gemini-2.5-flash",
  messages: [{ role: "user", content: "Reply with exactly: x402-tokens e2e ok" }],
  max_tokens: 32,
};

const unpaid = await fetch(`${SERVICE}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const chal = await unpaid.json();
console.log("unpaid", unpaid.status);
if (unpaid.status !== 402) {
  console.log(chal);
  process.exit(1);
}
const req = (chal.accepts ?? []).find((a) => a.extra?.symbol === "yUSDCx") ?? chal.accepts?.[0];
if (!req) {
  console.error("no accept in 402");
  process.exit(1);
}
console.log("402");
console.log("  asset   ", req.asset);
console.log("  amount  ", req.maxAmountRequired, req.extra?.symbol);
console.log("  usd     ", req.extra?.billedUsd);
console.log("  payTo   ", req.payTo);
console.log("  feePayer", req.extra?.feePayer);

const mint = new PublicKey(req.asset);
const payTo = new PublicKey(req.payTo);
const feePayer = new PublicKey(req.extra.feePayer);
const src = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
const dst = getAssociatedTokenAddressSync(mint, payTo, false, TOKEN_2022_PROGRAM_ID);
const bal = await getAccount(conn, src, "confirmed", TOKEN_2022_PROGRAM_ID);
console.log("  balance ", Number(bal.amount) / 1e6, "yUSDCx");
if (bal.amount < BigInt(req.maxAmountRequired)) {
  console.error("insufficient yUSDCx");
  process.exit(1);
}

const { blockhash } = await conn.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer, recentBlockhash: blockhash }).add(
  createTransferCheckedInstruction(
    src, mint, dst, payer.publicKey, BigInt(req.maxAmountRequired), 6, [], TOKEN_2022_PROGRAM_ID,
  ),
);
tx.partialSign(payer);
const b64tx = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
const payload = {
  x402Version: 1,
  scheme: "exact",
  network: req.network,
  payload: { transaction: b64tx },
};
const header = Buffer.from(JSON.stringify(payload)).toString("base64");

const paid = await fetch(`${SERVICE}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-PAYMENT": header },
  body: JSON.stringify(body),
});
const out = await paid.json();
console.log("paid", paid.status);
console.log(JSON.stringify(out, null, 2).slice(0, 2000));
if (paid.status !== 200) process.exit(1);
