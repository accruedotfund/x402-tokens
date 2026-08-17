/** bs58 ships no types; @solana/web3.js pulls it in transitively and this
 *  repo now imports it directly in nsauth.ts for the same base58 decoding
 *  Solana wallets/pubkeys already use. Minimal ambient shape for what we
 *  actually call. */
declare module "bs58" {
  function encode(buf: Uint8Array): string;
  function decode(str: string): Uint8Array;
  function decodeUnsafe(str: string): Uint8Array | undefined;
  const bs58: { encode: typeof encode; decode: typeof decode; decodeUnsafe: typeof decodeUnsafe };
  export default bs58;
}
