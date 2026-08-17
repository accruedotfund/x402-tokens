/**
 * Signed-namespace verification.
 *
 * `X-Openzoo-Namespace` used to be trusted as-is: tenantFor() (server.ts)
 * hashed whatever string a caller sent into a tenant id, so any caller could
 * squat on, read, or pollute another caller's leCore memory just by sending
 * the SAME namespace string — no proof the caller controls the identity the
 * namespace is meant to represent (a wallet, per the comment above tenantFor
 * that already says "the shim sends a hash of its wallet pubkey").
 *
 * This ties a namespace claim to a signature over that namespace, produced
 * by the caller's own wallet key — Solana ed25519 or EVM secp256k1, the same
 * two chain families x402 payments already settle on (config.ts assets[]).
 * Only the wallet that "owns" a namespace string can now claim it.
 *
 * NOT reusing x402.ts's verify(): that function forwards the payment payload
 * to an external facilitator's /verify endpoint and never checks a signature
 * locally in this process — there is no local signer-recovery code anywhere
 * in this codebase to call into. This module adds it using @noble/curves and
 * @noble/hashes, which are ALREADY vendored transitively via @solana/web3.js
 * / @solana/spl-token (see package-lock.json) — promoted to a direct
 * dependency in package.json rather than pulling in a new crypto library.
 */
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export type Chain = "solana" | "evm";

export interface SignedNamespaceHeaders {
  namespace: string;
  signature?: string;
  signer?: string;
  timestamp?: string;
  chain?: string;
}

export interface SignedNamespaceResult {
  ok: boolean;
  reason?: string;
  signer?: string;
  chain?: Chain;
}

/**
 * The exact bytes the wallet signs. Colon-delimited, mirroring x402's own
 * "name a resource, name a moment" convention elsewhere in this codebase
 * (see requirements()/challenge() in x402.ts) — a fixed, unambiguous format
 * a wallet's `signMessage`/`personal_sign` can sign directly, with no JSON
 * canonicalization to disagree about between client and server.
 */
export function namespaceMessage(namespace: string, timestamp: string): string {
  return `openzoo-namespace:${namespace}:${timestamp}`;
}

function detectChain(signer: string): Chain | undefined {
  if (/^0x[0-9a-fA-F]{40}$/.test(signer)) return "evm";
  try {
    if (bs58.decode(signer).length === 32) return "solana";
  } catch {
    // not valid base58 — fall through
  }
  return undefined;
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

function verifySolana(message: string, signatureB58: string, signerB58: string): boolean {
  let sig: Uint8Array;
  let pub: Uint8Array;
  try {
    sig = bs58.decode(signatureB58);
    pub = bs58.decode(signerB58);
  } catch {
    return false;
  }
  if (sig.length !== 64 || pub.length !== 32) return false;
  try {
    return ed25519.verify(sig, new TextEncoder().encode(message), pub);
  } catch {
    return false;
  }
}

/** EIP-191 `personal_sign` recovery — the signing path every EVM wallet
 *  exposes (eth_sign/personal_sign/`signMessage`), so no bespoke client
 *  signing code beyond calling the wallet is required. */
function verifyEvm(message: string, signatureHex: string, signerHex: string): boolean {
  const hex = signatureHex.startsWith("0x") || signatureHex.startsWith("0X")
    ? signatureHex.slice(2)
    : signatureHex;
  if (hex.length !== 130) return false; // 65 bytes: r(32) + s(32) + v(1)
  const sigBytes = hexToBytes(hex);
  if (!sigBytes) return false;

  const rs = sigBytes.slice(0, 64);
  let v = sigBytes[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return false;

  const messageBytes = new TextEncoder().encode(message);
  const prefixed = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const digest = keccak_256(new Uint8Array([...prefixed, ...messageBytes]));

  try {
    const sig = secp256k1.Signature.fromCompact(rs).addRecoveryBit(v);
    const pubPoint = sig.recoverPublicKey(digest);
    const pubBytes = pubPoint.toBytes(false); // uncompressed, 65 bytes: 0x04 || X || Y
    const addr = "0x" + bytesToHex(keccak_256(pubBytes.slice(1)).slice(-20));
    return addr.toLowerCase() === signerHex.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Verify a namespace claim against its signature, with a replay window on
 * the timestamp. Never throws — malformed input just fails closed with a
 * reason string. This module only answers "is this claim valid right now";
 * callers (tenantFor in server.ts) decide what an invalid claim falls back
 * to.
 */
export function verifySignedNamespace(
  h: SignedNamespaceHeaders,
  windowMs: number,
): SignedNamespaceResult {
  if (!h.namespace.trim()) return { ok: false, reason: "empty namespace" };
  if (h.namespace.includes(":")) return { ok: false, reason: "namespace must not contain ':'" };
  if (!h.signature || !h.signer || !h.timestamp) {
    return { ok: false, reason: "missing namespace signature headers" };
  }

  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const now = Date.now();
  const CLOCK_SKEW_MS = 30_000; // tolerate a modest clock drift on the caller's side
  if (ts > now + CLOCK_SKEW_MS) return { ok: false, reason: "namespace timestamp is in the future" };
  if (now - ts > windowMs) return { ok: false, reason: "namespace signature expired" };

  const chain = h.chain === "solana" || h.chain === "evm" ? h.chain : detectChain(h.signer);
  if (!chain) return { ok: false, reason: "cannot determine signer chain from X-Openzoo-Namespace-Signer" };

  const message = namespaceMessage(h.namespace, h.timestamp);
  const valid = chain === "solana"
    ? verifySolana(message, h.signature, h.signer)
    : verifyEvm(message, h.signature, h.signer);

  if (!valid) return { ok: false, reason: "signature does not match namespace claim" };
  return { ok: true, signer: h.signer, chain };
}
