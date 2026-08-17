/**
 * Drain PumpSwap coin-creator WSOL vault for TOKEN into ~/jjj.json.
 * WzMa's canonical WSOL ATA is owned by Red1rrqv… so we collect into a
 * fresh WSOL account we own, then close it.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID,
  createInitializeAccountInstruction, createCloseAccountInstruction,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/Users/stacc/claude/pumpfee/package.json");
const { getPumpAmmProgram } = require("@pump-fun/pump-sdk");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const creator = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/jjj.json", "utf8")))
);
const conn = new Connection(RPC, "confirmed");
const dest = Keypair.generate();

const before = await conn.getBalance(creator.publicKey);
console.log("claimer", creator.publicKey.toBase58());
console.log("SOL    ", before / LAMPORTS_PER_SOL);
console.log("tmp wsol", dest.publicKey.toBase58());

const rent = await conn.getMinimumBalanceForRentExemption(165);
const prog = getPumpAmmProgram(conn);
const collectIx = await prog.methods.collectCoinCreatorFee()
  .accountsPartial({
    coinCreator: creator.publicKey,
    coinCreatorTokenAccount: dest.publicKey,
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  })
  .instruction();

const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
const msg = new TransactionMessage({
  payerKey: creator.publicKey,
  recentBlockhash: blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }),
    SystemProgram.createAccount({
      fromPubkey: creator.publicKey,
      newAccountPubkey: dest.publicKey,
      lamports: rent,
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(dest.publicKey, NATIVE_MINT, creator.publicKey),
    collectIx,
    createCloseAccountInstruction(dest.publicKey, creator.publicKey, creator.publicKey),
  ],
}).compileToV0Message();
const tx = new VersionedTransaction(msg);
tx.sign([creator, dest]);

const sim = await conn.simulateTransaction(tx, { sigVerify: false });
console.log("sim", JSON.stringify(sim.value.err));
if (sim.value.logs) console.log(sim.value.logs.slice(-16).join("\n"));
if (sim.value.err) process.exit(2);

const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
const after = await conn.getBalance(creator.publicKey);
console.log("CLAIM", sig);
console.log("SOL after", after / LAMPORTS_PER_SOL, "delta", (after - before) / LAMPORTS_PER_SOL);
