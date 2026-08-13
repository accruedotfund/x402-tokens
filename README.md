# x402-tokens

OpenRouter behind [x402](https://x402.org). You do not bring an API key. You pay.

**Inference costs 3× OpenRouter's published USD rate**, converted at the moment the 402 is issued.

Today the rail is **yUSDCx** on Solana (wrapped USDC, 6 decimals, treated as $1). A memecoin wrap will use the same 3× USD math at Birdeye spot. It is not listed yet — we are proving the pipe on yUSDCx first.

```
POST /v1/chat/completions     unpaid → 402
                              X-PAYMENT → OpenRouter completion
GET  /                        how to use it, plus a live 402 button
GET  /healthz
GET  /quote
GET  /.well-known/x402.json
```

Facilitator: `https://x402.accrue.fund`  
Fee payer / payTo: `WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb`

## Prove it

```bash
curl -sS https://x402-tokens.fly.dev/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"google/gemini-2.5-flash","messages":[{"role":"user","content":"say hi"}]}'
```

Expect HTTP 402 and an `accepts[]` row for yUSDCx. `scripts/pay.mjs` signs that challenge and reprints the completion.

## Run

```bash
cp .env.example .env   # OPENROUTER_API_KEY required
npm i
npm run build
npm run selftest
node bin/x402-tokens.mjs
```

`scripts/wrap-yusdcx.mjs` wraps USDC → yUSDCx. `scripts/pay.mjs` does the paid call. Both read `~/jjj.json`.

Unaudited. Holds an OpenRouter key, never user funds.
