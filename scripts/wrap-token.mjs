/**
 * Wrap pump TOKEN → wTOKEN.
 *
 *   TOKEN_AMOUNT=10000000000 node scripts/wrap-token.mjs   # 10_000 TOKEN
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createTransferCheckedInstruction,
  getAccount, getMint,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";

const PROGRAM = new PublicKey("FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE");
const TOKEN = new PublicKey("EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump");
const W = new PublicKey("Bo7xBF7SY8EyUBPUxRP66SFafxoPf2n5uqiLjbxEebx9");
const ESCROW = new PublicKey("7j682FdwSdTkXNjbMrrLd5wcXQoh23UTZaDReqKXbL2q");
const AMOUNT = BigInt(process.env.TOKEN_AMOUNT ?? "10000000000"); // 10_000 TOKEN

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/jjj.json", "utf8")))
);
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const [authority, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority"), W.toBuffer()], PROGRAM
);
const userTok = getAssociatedTokenAddressSync(TOKEN, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
const userW = getAssociatedTokenAddressSync(W, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

const ixWrap = (amount, bump) => new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: ESCROW, isSigner: false, isWritable: true },
    { pubkey: W, isSigner: false, isWritable: true },
    { pubkey: userW, isSigner: false, isWritable: true },
    { pubkey: authority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([Buffer.from([1]), u64le(amount), Buffer.from([bump])]),
});
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

const tok = await getAccount(conn, userTok, "confirmed", TOKEN_2022_PROGRAM_ID);
console.log("TOKEN", Number(tok.amount) / 1e6, "wrap", Number(AMOUNT) / 1e6, "bump", bump);
if (tok.amount < AMOUNT) {
  console.error("not enough TOKEN");
  process.exit(1);
}

const tx = new Transaction();
try {
  await getAccount(conn, userW, "confirmed", TOKEN_2022_PROGRAM_ID);
} catch {
  tx.add(createAssociatedTokenAccountInstruction(payer.publicKey, userW, payer.publicKey, W, TOKEN_2022_PROGRAM_ID));
}
tx.add(
  createTransferCheckedInstruction(userTok, TOKEN, ESCROW, payer.publicKey, AMOUNT, 6, [], TOKEN_2022_PROGRAM_ID),
  ixWrap(AMOUNT, bump),
);
const sig = await sendAndConfirmTransaction(conn, tx, [payer]);
const w = await getAccount(conn, userW, "confirmed", TOKEN_2022_PROGRAM_ID);
const supply = await getMint(conn, W, "confirmed", TOKEN_2022_PROGRAM_ID);
console.log("sig", sig);
console.log("wTOKEN", Number(w.amount) / 1e6, "supply", Number(supply.supply) / 1e6);
