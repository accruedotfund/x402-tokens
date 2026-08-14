/**
 * A/B harness for elizaOS context-bench. NOT part of the x402 server.
 *
 * The zoo charges a 402 per call, and context-bench issues hundreds, so
 * benchmarking through x402-tokens would measure Solana settlement rather than
 * leCore. This exposes the SAME src/lecore.ts prepare() over a plain
 * OpenAI-compatible endpoint with no payment, so the only variable between
 * arms is HRR memory:
 *
 *   arm A (control) : OPENAI_BASE_URL=https://openrouter.ai/api/v1
 *   arm B (leCore)  : OPENAI_BASE_URL=http://127.0.0.1:8899/v1   <- this file
 *
 * Same model, same key, same prompts, same scorer. Anything that moves is
 * leCore. Every request logs tokens before/after to bench_lecore.jsonl so the
 * spill is auditable after the fact rather than asserted.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync } from "node:fs";
import { prepare } from "./lecore.js";
import type { Config } from "./config.js";

const PORT = Number(process.env.BENCH_PROXY_PORT || 8899);
const UPSTREAM = (process.env.BENCH_UPSTREAM || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const KEY = process.env.OPENROUTER_API_KEY || "";
const LOG = process.env.BENCH_LOG || "/tmp/bench_lecore.jsonl";

const cfg = {
  lecoreUrl: (process.env.LECORE_HRR_URL || "").replace(/\/$/, ""),
  lecoreKey: process.env.LECORE_HRR_KEY || "",
  lecoreTenant: process.env.LECORE_TENANT || "ctxbench",
  lecoreSpillTokens: Number(process.env.LECORE_SPILL_TOKENS || 4000),
  lecoreTopK: Number(process.env.LECORE_TOP_K || 8),
  lecoreTailChars: Number(process.env.LECORE_TAIL_CHARS || 2000),
  lecoreChunkChars: Number(process.env.LECORE_CHUNK_CHARS || 1200),
  lecoreQueryChars: Number(process.env.LECORE_QUERY_CHARS || 400),
  lecoreChunkOverlap: Number(process.env.LECORE_CHUNK_OVERLAP || 300),
  lecoreTimeoutMs: Number(process.env.LECORE_TIMEOUT_MS || 30000),
  lecoreRequired: process.env.LECORE_REQUIRED === "1",
} as Config;

const read = (req: IncomingMessage) =>
  new Promise<string>((res, rej) => {
    const c: Buffer[] = [];
    req.on("data", (x) => c.push(x));
    req.on("end", () => res(Buffer.concat(c).toString("utf8")));
    req.on("error", rej);
  });

const send = (res: ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://x").pathname;

    if (req.method === "GET" && path === "/v1/models") {
      const r = await fetch(`${UPSTREAM}/models`, { headers: { authorization: `Bearer ${KEY}` } });
      return send(res, r.status, await r.json());
    }
    if (req.method === "GET" && path === "/healthz") {
      return send(res, 200, { ok: true, lecore: Boolean(cfg.lecoreUrl), upstream: UPSTREAM });
    }
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      return send(res, 404, { error: "not found" });
    }

    const body = JSON.parse((await read(req)) || "{}") as Record<string, unknown>;
    const t0 = Date.now();
    const prep = await prepare(cfg, body);
    const lecoreMs = Date.now() - t0;

    const t1 = Date.now();
    const up = await fetch(`${UPSTREAM}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        "http-referer": "https://tokens.accrue.fund",
        "x-title": "lecore-context-bench",
      },
      body: JSON.stringify({ ...prep.body, stream: false }),
    });
    const json = await up.json().catch(() => ({ error: `upstream ${up.status}` }));

    appendFileSync(LOG, JSON.stringify({
      ts: new Date().toISOString(),
      arm: cfg.lecoreUrl ? "lecore" : "control",
      model: body.model,
      engaged: prep.info.engaged,
      reason: prep.info.reason,
      tokensBefore: prep.info.tokensBefore,
      tokensAfter: prep.info.tokensAfter,
      lecoreMs,
      upstreamMs: Date.now() - t1,
      status: up.status,
    }) + "\n");

    return send(res, up.status, json);
  } catch (e) {
    return send(res, 500, { error: (e as Error).message.slice(0, 200) });
  }
}).listen(PORT, "127.0.0.1", () =>
  console.log(`bench proxy :${PORT} -> ${UPSTREAM}  lecore=${cfg.lecoreUrl || "OFF"}  log=${LOG}`),
);
