/**
 * Create the wTOKEN wrap over pump TOKEN (Token-2022 → Token-2022 + TransferFee).
 *
 *   node scripts/create-wtoken.mjs
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";

const PROGRAM = new PublicKey("FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE");
const TOKEN = new PublicKey("EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump");
const TREASURY = new PublicKey("WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb");
const FEE_BPS = 20;
const MAX_FEE = BigInt("18446744073709551615");

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/jjj.json", "utf8")))
);
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const mint = Keypair.generate();
const [authority, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority"), mint.publicKey.toBuffer()], PROGRAM
);

const len = getMintLen([ExtensionType.TransferFeeConfig]);
const rent = await conn.getMinimumBalanceForRentExemption(len);
const escrow = getAssociatedTokenAddressSync(TOKEN, authority, true, TOKEN_2022_PROGRAM_ID);
const treasuryAta = getAssociatedTokenAddressSync(mint.publicKey, TREASURY, false, TOKEN_2022_PROGRAM_ID);
const scratch = getAssociatedTokenAddressSync(mint.publicKey, authority, true, TOKEN_2022_PROGRAM_ID);

console.log("wTOKEN");
console.log("  underlying", TOKEN.toBase58());
console.log("  wrapped   ", mint.publicKey.toBase58());
console.log("  authority ", authority.toBase58(), "bump", bump);
console.log("  escrow    ", escrow.toBase58());
console.log("  SOL       ", (await conn.getBalance(payer.publicKey)) / 1e9);

const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
    space: len, lamports: rent, programId: TOKEN_2022_PROGRAM_ID,
  }),
  createInitializeTransferFeeConfigInstruction(
    mint.publicKey, authority, authority, FEE_BPS, MAX_FEE, TOKEN_2022_PROGRAM_ID
  ),
  createInitializeMintInstruction(mint.publicKey, 6, authority, null, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(payer.publicKey, escrow, authority, TOKEN, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(payer.publicKey, scratch, authority, mint.publicKey, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(payer.publicKey, treasuryAta, TREASURY, mint.publicKey, TOKEN_2022_PROGRAM_ID),
);

const sig = await sendAndConfirmTransaction(conn, tx, [payer, mint]);
const out = {
  underlying: TOKEN.toBase58(),
  wrapped: mint.publicKey.toBase58(),
  authority: authority.toBase58(),
  bump,
  escrow: escrow.toBase58(),
  scratch: scratch.toBase58(),
  treasuryAta: treasuryAta.toBase58(),
  program: PROGRAM.toBase58(),
  feeBps: FEE_BPS,
  createSig: sig,
};
writeFileSync(new URL("../meta/wtoken.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("  created", sig);
console.log(JSON.stringify(out, null, 2));
