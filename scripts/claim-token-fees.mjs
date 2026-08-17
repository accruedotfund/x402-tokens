/**
 * Claim pump.fun creator fees for TOKEN (EVULo…pump) into ~/jjj.json.
 * Pump bonding-curve vault first, then PumpSwap AMM WSOL vault.
 */
import {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, getAccount,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/Users/stacc/claude/pumpfee/package.json");
const { OnlinePumpSdk, getPumpProgram, bondingCurvePda, creatorVaultPda } = require("@pump-fun/pump-sdk");

const MINT = new PublicKey("EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump");
const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const creator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/jjj.json", "utf8")))
);

const conn = new Connection(RPC, "confirmed");
const online = new OnlinePumpSdk(conn);

async function send(ixs, label) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: creator.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
      ...ixs,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([creator]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  console.log(label, "sim", JSON.stringify(sim.value.err));
  if (sim.value.err) {
    console.log((sim.value.logs || []).slice(-10).join("\n"));
    return null;
  }
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(label, "sig", sig);
  return sig;
}

console.log("claimer", creator.publicKey.toBase58());
const before = await conn.getBalance(creator.publicKey);
console.log("SOL    ", before / LAMPORTS_PER_SOL);

const bc = bondingCurvePda(MINT);
const acc = await conn.getAccountInfo(bc);
if (!acc) {
  console.error("no bonding curve");
  process.exit(1);
}
const bcCreator = new PublicKey(acc.data.subarray(49, 81));
console.log("creator on curve", bcCreator.toBase58());
if (!bcCreator.equals(creator.publicKey)) {
  console.error("jjj.json is not the creator");
  process.exit(1);
}

const vault = creatorVaultPda(creator.publicKey);
const claimable = await online.getCreatorVaultBalanceBothPrograms(creator.publicKey);
console.log("pump vault", vault.toBase58(), (await conn.getBalance(vault)) / LAMPORTS_PER_SOL, "SOL");
console.log("claimable both", Number(claimable) / LAMPORTS_PER_SOL, "SOL");

const prog = getPumpProgram(conn);
const pumpIx = await prog.methods.collectCreatorFee()
  .accounts({ creator: creator.publicKey, creatorVault: vault })
  .instruction();
await send([pumpIx], "pump-vault");

const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, creator.publicKey, false, TOKEN_PROGRAM_ID);
const createAta = createAssociatedTokenAccountIdempotentInstruction(
  creator.publicKey, wsolAta, creator.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID
);

const built = await online.collectCoinCreatorFeeV2Instructions(
  creator.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID, creator.publicKey
);
// skip the first ix if we already drained pump vault — still include ATA create
const ammIxs = built.slice(1);
await send([createAta, ...ammIxs], "amm-wsol");

try {
  const w = await getAccount(conn, wsolAta, "confirmed", TOKEN_PROGRAM_ID);
  console.log("wsol", Number(w.amount) / LAMPORTS_PER_SOL);
  if (w.amount > 0n) {
    await send([createCloseAccountInstruction(wsolAta, creator.publicKey, creator.publicKey)], "unwrap");
  }
} catch (e) {
  console.log("wsol", e.message.slice(0, 80));
}

const after = await conn.getBalance(creator.publicKey);
console.log("SOL after", after / LAMPORTS_PER_SOL, "delta", (after - before) / LAMPORTS_PER_SOL);
console.log("vault after", (await conn.getBalance(vault)) / LAMPORTS_PER_SOL);
console.log("claimable after", Number(await online.getCreatorVaultBalanceBothPrograms(creator.publicKey)) / LAMPORTS_PER_SOL);
