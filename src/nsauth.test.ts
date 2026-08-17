/** Signed-namespace verification: a valid signature is accepted and derives
 *  the tenant from the SIGNER, not the raw string; a tampered/expired/
 *  mismatched claim is rejected; unsigned namespaces still fall through
 *  unchanged (the soft-launch path tenantFor relies on). */
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { namespaceMessage, verifySignedNamespace } from "./nsauth.js";

const ok = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exit(1); } console.log("ok -", m); };
const WINDOW = 5 * 60 * 1000;

// --- Solana signer -------------------------------------------------------
const solKp = ed25519.keygen();
const solSigner = bs58.encode(solKp.publicKey);
function signSolana(namespace: string, ts: string): string {
  const msg = new TextEncoder().encode(namespaceMessage(namespace, ts));
  return bs58.encode(ed25519.sign(msg, solKp.secretKey));
}

// --- EVM signer ------------------------------------------------------------
const evmPriv = secp256k1.utils.randomSecretKey();
const evmPub = secp256k1.getPublicKey(evmPriv, false);
const evmAddrBytes = keccak_256(evmPub.slice(1)).slice(-20);
const evmSigner = "0x" + Array.from(evmAddrBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
function signEvm(namespace: string, ts: string): string {
  const message = namespaceMessage(namespace, ts);
  const messageBytes = new TextEncoder().encode(message);
  const prefixed = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const digest = keccak_256(new Uint8Array([...prefixed, ...messageBytes]));
  const sig = secp256k1.sign(digest, evmPriv);
  const v = (sig.recovery ?? 0) + 27;
  return "0x" + sig.toCompactHex() + v.toString(16).padStart(2, "0");
}

// 1. valid Solana signature
{
  const ts = String(Date.now());
  const ns = "player-one";
  const v = verifySignedNamespace({ namespace: ns, signature: signSolana(ns, ts), signer: solSigner, timestamp: ts }, WINDOW);
  ok(v.ok === true, "solana: valid signature verifies");
  ok(v.chain === "solana" && v.signer === solSigner, "solana: reports signer + chain");
}

// 2. valid EVM signature
{
  const ts = String(Date.now());
  const ns = "player-two";
  const v = verifySignedNamespace({ namespace: ns, signature: signEvm(ns, ts), signer: evmSigner, timestamp: ts }, WINDOW);
  ok(v.ok === true, "evm: valid signature verifies");
  ok(v.chain === "evm" && v.signer?.toLowerCase() === evmSigner.toLowerCase(), "evm: reports signer + chain");
}

// 3. tampered namespace after signing -> rejected
{
  const ts = String(Date.now());
  const sig = signSolana("real-namespace", ts);
  const v = verifySignedNamespace({ namespace: "stolen-namespace", signature: sig, signer: solSigner, timestamp: ts }, WINDOW);
  ok(v.ok === false, "solana: signature for a DIFFERENT namespace does not verify (no squatting via replay)");
}

// 4. wrong signer claimed -> rejected
{
  const ts = String(Date.now());
  const ns = "someones-namespace";
  const otherKp = ed25519.keygen();
  const sig = signSolana(ns, ts); // signed by solKp
  const v = verifySignedNamespace({ namespace: ns, signature: sig, signer: bs58.encode(otherKp.publicKey), timestamp: ts }, WINDOW);
  ok(v.ok === false, "solana: signature does not verify against a DIFFERENT claimed signer");
}

// 5. expired timestamp -> rejected
{
  const ts = String(Date.now() - WINDOW - 60_000);
  const ns = "old-claim";
  const sig = signSolana(ns, ts);
  const v = verifySignedNamespace({ namespace: ns, signature: sig, signer: solSigner, timestamp: ts }, WINDOW);
  ok(v.ok === false && v.reason === "namespace signature expired", "solana: a claim older than the window is rejected as expired");
}

// 6. future timestamp beyond clock skew -> rejected
{
  const ts = String(Date.now() + 10 * 60_000);
  const ns = "future-claim";
  const sig = signSolana(ns, ts);
  const v = verifySignedNamespace({ namespace: ns, signature: sig, signer: solSigner, timestamp: ts }, WINDOW);
  ok(v.ok === false, "solana: a timestamp far in the future is rejected");
}

// 7. namespace containing ':' rejected outright (message-format ambiguity)
{
  const v = verifySignedNamespace({ namespace: "a:b", signature: "x", signer: solSigner, timestamp: String(Date.now()) }, WINDOW);
  ok(v.ok === false && v.reason === "namespace must not contain ':'", "a namespace containing ':' is refused before any crypto runs");
}

// 8. unsigned request (no sig/signer/ts at all) -> ok:false with a clear reason, never throws
{
  const v = verifySignedNamespace({ namespace: "plain" }, WINDOW);
  ok(v.ok === false && v.reason === "missing namespace signature headers", "an unsigned namespace claim fails closed with a clear reason, not a throw");
}

// 9. tenant hash mirrors tenantFor's own derivation (server.ts): keyed on
//    signer AND namespace, so ONE wallet can still run several isolated
//    tenants, but a DIFFERENT wallet claiming the identical namespace label
//    lands in a DIFFERENT tenant — the squatting hole is closed either way.
{
  const ts = String(Date.now());
  const otherKp = ed25519.keygen();
  const otherSigner = bs58.encode(otherKp.publicKey);
  const tenantOf = (v: { chain?: string; signer?: string }, namespace: string) =>
    createHash("sha256").update(`${v.chain}:${v.signer}:${namespace}`).digest("hex").slice(0, 16);

  const a = verifySignedNamespace({ namespace: "ns-a", signature: signSolana("ns-a", ts), signer: solSigner, timestamp: ts }, WINDOW);
  const b = verifySignedNamespace({ namespace: "ns-b", signature: signSolana("ns-b", ts), signer: solSigner, timestamp: ts }, WINDOW);
  ok(a.ok && b.ok, "solana: both namespaces verify independently");
  ok(tenantOf(a, "ns-a") !== tenantOf(b, "ns-b"), "same wallet, different namespace labels -> different tenants (multi-project isolation preserved)");

  const squat = verifySignedNamespace({ namespace: "ns-a", signature: (() => {
    const msg = new TextEncoder().encode(namespaceMessage("ns-a", ts));
    return bs58.encode(ed25519.sign(msg, otherKp.secretKey));
  })(), signer: otherSigner, timestamp: ts }, WINDOW);
  ok(squat.ok === true, "a different wallet CAN sign the same namespace label (it's just a label, not a lock)");
  ok(tenantOf(a, "ns-a") !== tenantOf(squat, "ns-a"), "but it lands in a DIFFERENT tenant than the first wallet's ns-a — no squatting, because the signer is in the hash too");
}
