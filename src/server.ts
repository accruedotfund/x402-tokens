import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { complete, listModels } from "./openrouter.js";
import { clankerPrompt, renderIndex } from "./page.js";
import { quoteLive } from "./quote.js";
import { attach, bindPassthrough, ContextGoneError, prepare, type LecoreResult } from "./lecore.js";
import { challenge, requirements, settle, verify } from "./x402.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const metaDir = join(here, "..", "meta");

const json = (res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s), ...extra });
  res.end(s);
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

// ---------------------------------------------------------------------------
// Observability. One structured "evt" line per chat request — before this,
// the only log was the settle result, so user acquisition was unmeasurable
// server-side. Mirrored to /data/usage_events.jsonl when a volume is mounted
// (none today — Fly log retention is the store until one exists).
// No PII beyond a truncated payer and a truncated IP.
const USAGE_FILE = "/data/usage_events.jsonl";

/** First 8 chars of a payer address — enough to count distinct payers, not to dox one. */
export const shortPayer = (p?: string) => (p ? p.slice(0, 8) : undefined);

/** IPv4 loses its last octet, IPv6 keeps its first three groups. */
export const shortIp = (ip?: string) => {
  if (!ip) return undefined;
  const first = ip.split(",")[0].trim();
  if (first.includes(".")) return first.split(".").slice(0, 3).join(".") + ".x";
  return first.split(":").slice(0, 3).join(":") + "::x";
};

const logEvent = (e: Record<string, unknown>) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
  console.log("evt", line);
  if (existsSync("/data")) {
    try { appendFileSync(USAGE_FILE, line + "\n"); } catch { /* telemetry must never fail a request */ }
  }
};

export function createServerFor(cfg: Config) {
  const resource = `${cfg.publicUrl}/v1/chat/completions`;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", cfg.publicUrl);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = renderIndex(cfg);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/token.jpg") {
      const p = join(metaDir, "token.jpg");
      if (!existsSync(p)) return json(res, 404, { error: "no token.jpg" });
      const buf = readFileSync(p);
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": buf.length, "cache-control": "public, max-age=86400" });
      return res.end(buf);
    }

    if (req.method === "GET" && (url.pathname === "/metadata.json" || url.pathname === "/token.json")) {
      const p = join(metaDir, "metadata.json");
      if (!existsSync(p)) return json(res, 404, { error: "no metadata" });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" });
      return res.end(readFileSync(p));
    }

    if (req.method === "GET" && (url.pathname === "/prompt.txt" || url.pathname === "/clanker.txt")) {
      const text = clankerPrompt(cfg);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text) });
      return res.end(text);
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, {
        ok: true,
        rails: cfg.assets.map((a) => a.symbol),
        facilitator: cfg.facilitator,
        markup: cfg.markup,
      });
    }

    if (req.method === "GET" && (url.pathname === "/.well-known/x402.json" || url.pathname === "/quote")) {
      const dummy = { model: cfg.defaultModel, messages: [{ role: "user", content: "ping" }], max_tokens: 32 };
      const q = await quoteLive(cfg, dummy);
      if (url.pathname === "/quote") return json(res, 200, q);
      return json(res, 200, {
        x402Version: 1,
        name: "x402-tokens",
        facilitator: cfg.facilitator,
        resources: [{
          resource,
          type: "http",
          x402Version: 1,
          description: "OpenRouter chat completions. 3× USD, priced at the 402.",
          accepts: requirements(cfg, q, resource),
        }],
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const models = await listModels(cfg.openrouterUrl, cfg.openrouterKey);
      const data = [...models.byId.values()].map((m) => ({
        id: m.id,
        object: "model",
        owned_by: "openrouter",
        pricing: { prompt: m.prompt * cfg.markup, completion: m.completion * cfg.markup, unit: "USD", markup: cfg.markup },
      }));
      return json(res, 200, { object: "list", data });
    }

    // "The body never ships twice": bind a corpus once, then ask with
    // X-HRR-Context on small bodies. Free — see bindPassthrough for why.
    if (req.method === "POST" && url.pathname === "/v1/hrr/bind") {
      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      const { status, payload } = await bindPassthrough(cfg, body);
      logEvent({
        path: url.pathname,
        status: "free",
        bodyBytes: Buffer.byteLength(raw),
        ip: shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined),
        http: status,
      });
      return json(res, status, payload);
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const raw = await readBody(req);
      let body: { model?: string; messages?: unknown; max_tokens?: number; stream?: boolean };
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      if (!body.messages) return json(res, 400, { error: "messages required" });
      const bodyBytes = Buffer.byteLength(raw);
      const ip = shortIp((req.headers["fly-client-ip"] as string) || req.socket.remoteAddress || undefined);

      // leCore in front. MUST precede quoteLive: the 402 is priced from
      // estimateTokens(messages), so spilling after the quote would bill the
      // caller 3x on the whole book and hand them the discount they already
      // paid for. Thread key lets a caller keep one holographic context.
      const headerCtx = req.headers["x-hrr-context"] as string | undefined;
      const thread = headerCtx
        || (typeof (body as { user?: unknown }).user === "string" ? (body as { user: string }).user : undefined);
      let prepped: Record<string, unknown> = body as Record<string, unknown>;
      let lecoreInfo: LecoreResult["info"];
      try {
        const r = await prepare(cfg, body as Record<string, unknown>, thread);
        prepped = r.body;
        lecoreInfo = r.info;
      } catch (e) {
        return json(res, 503, { error: (e as Error).message });
      }

      // ATTACH: an EXPLICIT X-HRR-Context on a body too small to spill means
      // "the corpus is already bound — recall against it". Header only:
      // body.user is a stock OpenAI field and treating it as a context id
      // would 404 every ordinary small request that happens to set it.
      // A dead context 404s BEFORE the 402 so a stale manifest re-binds free.
      if (headerCtx && !lecoreInfo.engaged && cfg.lecoreUrl) {
        try {
          const a = await attach(cfg, prepped, headerCtx);
          prepped = a.body;
          lecoreInfo = a.info;
        } catch (e) {
          if (e instanceof ContextGoneError) {
            return json(res, 404, { error: { message: "hrr_context_not_found", code: "context_not_found", context_id: headerCtx } });
          }
          return json(res, 503, { error: (e as Error).message });
        }
      }

      // price the counterfactual when leCore engaged: the caller pays a fraction of
      // what this body would have cost them direct, not a markup on the slice.
      //
      // FAIL-OPEN MUST NOT BILL A MARKUP. If the sidecar times out on a fat body
      // we forward the whole thing — and the markup path would then charge
      // X402_MARKUP x the UNSPILLED cost, i.e. ~6x what buying direct costs, for
      // a call where our memory did nothing. MEASURED: a 967,288-token body
      // failed open at the 120s timeout. When leCore was supposed to engage and
      // didn't, price at direct (markup 1) — we still cover cost, and we never
      // punish a caller for our own outage.
      const shouldHaveEngaged = Boolean(cfg.lecoreUrl)
        && !lecoreInfo.engaged
        && String(lecoreInfo.reason || "").startsWith("fail-open");
      const q = await quoteLive(
        shouldHaveEngaged ? { ...cfg, markup: 1 } : cfg,
        prepped,
        lecoreInfo.engaged ? lecoreInfo.tokensBefore : undefined,
      );
      const reqs = requirements(cfg, q, resource);
      // one analytics line per chat request, whatever the outcome
      const evt = (status: string, extra: Record<string, unknown> = {}) => logEvent({
        path: url.pathname,
        status,
        model: String(body.model || cfg.defaultModel),
        bodyBytes,
        ip,
        tokens_before: lecoreInfo.tokensBefore,
        tokens_after: lecoreInfo.tokensAfter,
        spill_tokens: lecoreInfo.spilledTokens,
        recalled: lecoreInfo.recalled,
        corpus_reuse: lecoreInfo.mode === "attach" || undefined,
        ...extra,
      });
      const header = req.headers["x-payment"] as string | undefined;
      if (!header) {
        evt("402_quoted", { billedUsd: q.billedUsd });
        return json(res, 402, challenge(cfg, q, resource), { "x-402-priced-at": q.pricedAt });
      }
      const v = await verify(cfg, header, reqs);
      if (!v.ok || !v.picked) {
        evt("402_invalid", { reason: (v.reason ?? "invalid payment").slice(0, 200) });
        return json(res, 402, challenge(cfg, q, resource, v.reason ?? "invalid payment"));
      }

      // SETTLE BEFORE THE UPSTREAM CALL. The old order (serve, then settle)
      // made every failed settle free inference: 8 "Simulation failed" settles
      // in the 2026-08-14 logs each shipped a full model response and collected
      // nothing. It also widened the blockhash window — the payer signs a
      // recent blockhash, and burning upstream-inference seconds before /settle
      // pushed slow calls past expiry (the empty-logs simulation failure).
      // No confirmed settle, no tokens. The trade: a call whose upstream then
      // errors has already settled — the receipt names the tx so it can be
      // made right, which beats free inference on every payment that cannot
      // clear.
      const settled = (await settle(cfg, header, v.picked).catch((e) => ({ success: false, errorReason: (e as Error).message }))) as
        { success?: boolean; errorReason?: string; transaction?: string; payer?: string };
      console.log("settle", JSON.stringify(settled));
      if (!settled.success) {
        const reason = (settled.errorReason ?? "settle failed").slice(0, 300);
        evt("failed_settle", { payer: shortPayer(settled.payer ?? v.payer), reason, billedUsd: q.billedUsd });
        // clean 402, retryable: the client rebuilds (fresh blockhash / topped-up
        // balance) and pays against the re-quote below.
        return json(res, 402, challenge(cfg, q, resource, `payment failed: ${reason}`), { "x-402-priced-at": q.pricedAt });
      }

      const out = await complete(cfg.openrouterUrl, cfg.openrouterKey, { ...prepped, stream: false }, cfg.publicUrl);
      evt(out.status >= 200 && out.status < 300 ? "paid_200" : "paid_upstream_error", {
        payer: shortPayer(settled.payer ?? v.payer),
        upstream: out.status,
        billedUsd: q.billedUsd,
      });
      return json(res, out.status, {
        ...(out.json as object),
        x402: {
          billedUsd: q.billedUsd,
          pricing: q.pricing,
          directUsd: q.directUsd,
          savesVsDirect: q.savesVsDirect,
          markup: q.pricing === "markup" ? q.markup : undefined,
          paid: v.picked.asset,
          amount: v.picked.maxAmountRequired,
          settle: settled,
          lecore: lecoreInfo,
        },
      });
    }

    return json(res, 404, { error: "not found" });
  };

  return {
    handler,
    listen(port = cfg.port) {
      const s = createServer((req, res) => {
        handler(req, res).catch((e) => json(res, 500, { error: (e as Error).message.slice(0, 160) }));
      });
      s.listen(port, "0.0.0.0", () => console.log(`x402-tokens :${port}  ${cfg.publicUrl}`));
      return s;
    },
  };
}

export { loadConfig };
void extname;
