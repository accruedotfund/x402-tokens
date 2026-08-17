/**
 * Create the wLEOS wrap over LEOS (legacy SPL Token → Token-2022 + TransferFee).
 *
 *   node scripts/create-leos.mjs
 *
 * LEOS is a LEGACY SPL mint with NINE decimals, which makes it the first asset
 * on the facilitator that is neither Token-2022 nor 6 decimals:
 *
 *   - the escrow ATA must live under TOKEN_PROGRAM_ID, not TOKEN_2022_PROGRAM_ID.
 *     The program reads `escrow.owner()` to decide which program moves the
 *     underlying, so an escrow under the wrong program is not a recoverable
 *     mistake — it is a different account address.
 *   - the wrapped mint takes the UNDERLYING's decimals. That is not a style
 *     choice: `mint_customizer/yield_bearing.rs` returns `mint.base.decimals`
 *     and the deployed build reads `mint_decimals()` at runtime, so a 6-decimal
 *     twin over a 9-decimal underlying would mis-scale every transfer_checked.
 *
 * Everything else matches yUSDCx/wTOKENx: both fee authorities and the mint
 * authority are the program PDA (withdraw is authority-gated — a keypair there
 * stalls the crank), and deliberately no freeze authority.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";

const PROGRAM = new PublicKey("FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE");
const LEOS = new PublicKey("5xgsnby6P9zqGK71J7H4yJLxzqPvNbC7rDZxNzjHmj7e");
const TREASURY = new PublicKey("WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb");
const FEE_BPS = 20;
const MAX_FEE = BigInt("18446744073709551615"); // no cap: a maximum makes the
                                                // rate regressive and creates a
                                                // size above which it stops.

const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + "/jjj.json", "utf8")))
);
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

// Read the underlying rather than trusting the constant above — decimals and
// the owning program are the two facts this whole script is keyed to.
const info = await conn.getParsedAccountInfo(LEOS);
const parsed = info.value?.data?.parsed?.info;
if (!parsed) {
  console.log("  FAILED: could not read underlying mint");
  process.exit(1);
}
const DECIMALS = parsed.decimals;
const UNDERLYING_PROGRAM = new PublicKey(info.value.owner);
if (!UNDERLYING_PROGRAM.equals(TOKEN_PROGRAM_ID) && !UNDERLYING_PROGRAM.equals(TOKEN_2022_PROGRAM_ID)) {
  console.log(`  FAILED: unknown token program ${UNDERLYING_PROGRAM.toBase58()}`);
  process.exit(1);
}

const mint = Keypair.generate();
const [authority, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority"), mint.publicKey.toBuffer()], PROGRAM
);

const len = getMintLen([ExtensionType.TransferFeeConfig]);
const rent = await conn.getMinimumBalanceForRentExemption(len);
const escrow = getAssociatedTokenAddressSync(LEOS, authority, true, UNDERLYING_PROGRAM);
const treasuryAta = getAssociatedTokenAddressSync(mint.publicKey, TREASURY, false, TOKEN_2022_PROGRAM_ID);
const scratch = getAssociatedTokenAddressSync(mint.publicKey, authority, true, TOKEN_2022_PROGRAM_ID);

console.log("\nwLEOSx on mainnet");
console.log("  underlying  ", LEOS.toBase58());
console.log("  underlying  ", `${DECIMALS} decimals, program ${UNDERLYING_PROGRAM.toBase58()}`);
console.log("  wrapped     ", mint.publicKey.toBase58());
console.log("  authority   ", authority.toBase58(), "bump", bump);
console.log("  escrow      ", escrow.toBase58());
console.log("  SOL         ", (await conn.getBalance(payer.publicKey)) / 1e9);

const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
    space: len, lamports: rent, programId: TOKEN_2022_PROGRAM_ID,
  }),
  // Extensions BEFORE InitializeMint — Token-2022 requires it.
  createInitializeTransferFeeConfigInstruction(
    mint.publicKey, authority, authority, FEE_BPS, MAX_FEE, TOKEN_2022_PROGRAM_ID
  ),
  createInitializeMintInstruction(mint.publicKey, DECIMALS, authority, null, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(payer.publicKey, escrow, authority, LEOS, UNDERLYING_PROGRAM),
  createAssociatedTokenAccountInstruction(payer.publicKey, scratch, authority, mint.publicKey, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(payer.publicKey, treasuryAta, TREASURY, mint.publicKey, TOKEN_2022_PROGRAM_ID),
);

try {
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, mint]);
  const out = {
    underlying: LEOS.toBase58(),
    underlyingProgram: UNDERLYING_PROGRAM.toBase58(),
    decimals: DECIMALS,
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
  writeFileSync(new URL("../meta/leos.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n  created in ${sig}`);
  console.log(`  fee ${FEE_BPS}bps · both fee authorities = PDA · no freeze authority\n`);
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.log(`\n  FAILED: ${String(e.message).slice(0, 300)}`);
  (e.logs ?? []).slice(-6).forEach((l) => console.log(`    ${l}`));
  process.exit(1);
}
