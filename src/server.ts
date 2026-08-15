import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { complete, listModels } from "./openrouter.js";
import { clankerPrompt, renderIndex } from "./page.js";
import { quoteLive } from "./quote.js";
import { attach, bindPassthrough, ContextGoneError, prepare, type LecoreResult } from "./lecore.js";
import { challenge, requirements, settle, verify } from "./x402.js";
import * as usage from "./usage.js";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * What a CLIENT can use, which is not what the transformer holds. Bodies past
 * the spill threshold are carved and bound to the HRR sidecar before the 402,
 * and `POST /v1/hrr/bind` + `X-HRR-Context` does it explicitly — so the usable
 * ceiling is the bind capacity, not any single model's window.
 */
/**
 * Per-caller context isolation.
 *
 * Every bind used to land in ONE sidecar tenant ("zoo"), so a context was
 * protected only by its id being unguessable — no isolation between callers
 * at all, and the free bind endpoint means anyone can write into that shared
 * space. Callers now supply an opaque namespace (the shim sends a hash of its
 * wallet pubkey) which is hashed into the tenant id, so one wallet's corpora
 * are unreachable from another's even if an id leaks.
 *
 * Hashed, not used raw: the namespace should not become a way to write
 * arbitrary tenant strings into the sidecar, and hashing bounds the shape.
 * Callers that send nothing keep the legacy shared tenant.
 */
function tenantFor(cfg: Config, req: IncomingMessage): string {
  const ns = req.headers["x-openzoo-namespace"];
  if (typeof ns !== "string" || !ns.trim()) return cfg.lecoreTenant;
  const h = createHash("sha256").update(ns.trim()).digest("hex").slice(0, 16);
  return `${cfg.lecoreTenant}_${h}`;
}

/**
 * Tenants to try, in order, for an operation that references an EXISTING
 * context id.
 *
 * A context bound before namespacing — or bound by a different tool that does
 * not send the header — lives in the base tenant, and looking it up in the
 * namespaced one fails. MEASURED in production: an agent bound a corpus with
 * a plain script (tenant "zoo"), then asked through the shim (tenant
 * "zoo_<hash>") and every spill bind came back 400, silently disabling the
 * whole feature for that conversation.
 *
 * New contexts are still created in the caller's own tenant — this fallback
 * only makes a PRE-EXISTING id reachable, so isolation holds going forward
 * while nothing bound earlier is orphaned.
 */
function tenantCandidates(cfg: Config, req: IncomingMessage): string[] {
  const own = tenantFor(cfg, req);
  return own === cfg.lecoreTenant ? [own] : [own, cfg.lecoreTenant];
}

/** Run `fn` against each candidate tenant, returning the first that succeeds. */
async function withTenantFallback<T>(
  cfg: Config,
  req: IncomingMessage,
  fn: (c: Config) => Promise<T>,
): Promise<T> {
  const tenants = tenantCandidates(cfg, req);
  let last: unknown;
  for (let i = 0; i < tenants.length; i++) {
    try {
      return await fn({ ...cfg, lecoreTenant: tenants[i], lecoreTopK: topKFor(cfg, req) });
    } catch (e) {
      last = e;
      // ContextGoneError here means "not in THIS tenant", which is exactly the
      // case the fallback exists for — keep going. Only the last candidate's
      // failure is the real answer.
    }
  }
  throw last;
}


/**
 * Retrieval breadth for THIS request.
 *
 * top_k is the number of chunks the sidecar returns, and the default is tuned
 * for pointed questions. An exhaustive ask ("list every mention of X") over a
 * large corpus needs far more: MEASURED on an 8.7MB Telegram export (~7,000
 * chunks), top_k=16 surfaced ~19KB and an agent's grep found pump.fun and
 * Solana evidence that retrieval had missed — the corpus held it, the pass
 * never saw it. Callers that know they want breadth can now say so, bounded
 * so nobody can ask for the whole corpus and blow the bill up.
 */
function topKFor(cfg: Config, req: IncomingMessage): number {
  const raw = Number(req.headers["x-hrr-top-k"]);
  if (!Number.isFinite(raw)) return cfg.lecoreTopK;
  return Math.min(Math.max(Math.floor(raw), 1), 256);
}

const CLIENT_USABLE_CONTEXT = 128_000_000;
/** One POST cannot carry the whole ceiling: the edge 413s near ~32MiB. */
const MAX_SINGLE_POST_TOKENS = 9_800_000;
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
// server-side. The same event now also goes to the usage store (in-memory ring
// + /data/usage_events.jsonl when a volume is mounted), which is what
// GET /v1/usage and /v1/usage/summary read.
//
// The STORED row keeps the full payer address (public on-chain, and a payer
// has to be able to look themselves up); the LOG LINE keeps the 8-char form it
// has always had. IPs are truncated at capture in both, and no endpoint ever
// returns one.

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
  const stored: Record<string, unknown> = { ts: new Date().toISOString(), ...e };
  usage.record(stored as usage.UsageEvent); // never throws — telemetry must not fail a request
  console.log("evt", JSON.stringify({ ...stored, payer: shortPayer(stored.payer as string | undefined) }));
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

    // -----------------------------------------------------------------------
    // Usage. Three reads, no writes.
    //
    //   /v1/usage/local    this machine's shard only — the fan-out target, and
    //                      the honest answer to "what does ONE machine know?"
    //   /v1/usage          one payer's own history, merged across machines
    //   /v1/usage/summary  aggregate, non-identifying counters
    //
    // AUTH — deliberately none. The key is a Solana address that is already
    // public on-chain, as are the amounts and the settle transactions, so a
    // token here would only stop the payer from reading their own receipts.
    // What we do NOT publish is anything not already public: no IPs at any
    // resolution, no request bodies, no prompts. The unauthenticated status is
    // stated in the response so nobody assumes these rows are private.
    if (req.method === "GET" && url.pathname === "/v1/usage/local") {
      const payer = url.searchParams.get("payer");
      if (!payer) return json(res, 200, usage.localSummary());
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 5000);
      return json(res, 200, {
        machine: usage.machineId,
        events: usage.localEventsFor(payer, limit).map(usage.publicEvent),
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/usage") {
      const payer = (url.searchParams.get("payer") || (req.headers["x-payer"] as string) || "").trim();
      if (!payer) {
        return json(res, 400, {
          error: "pass ?payer=<solana address> (or an X-Payer header) to see that payer's usage",
          aggregate: `${cfg.publicUrl}/v1/usage/summary`,
        });
      }
      if (payer.length < 6) return json(res, 400, { error: "payer must be at least 6 characters (prefix match allowed)" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 1000);
      const scan = Math.max(limit, 2000); // totals cover more than the rows we print back
      const q = `/v1/usage/local?payer=${encodeURIComponent(payer)}&limit=${scan}`;
      const mine = usage.localEventsFor(payer, scan).map(usage.publicEvent);
      const { results, expected, responded } = await usage.fanout<{ events: usage.PublicEvent[] }>(q);
      const merged = [...mine, ...results.flatMap((r) => r.events || [])]
        .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
      const roll = usage.aggregate(merged);
      return json(res, 200, {
        payer,
        matched: merged.length ? (merged[0].payer === payer ? "exact" : "prefix") : "none",
        ...roll,
        events: merged.slice(0, limit),
        events_returned: Math.min(limit, merged.length),
        events_matched: merged.length,
        coverage: usage.coverage(expected, responded, {
          totals_cover: `the ${merged.length} matched event(s) still retained — not all time`,
          auth: "unauthenticated: keyed on a public Solana address, so anyone who knows the address can read these rows. No IPs, bodies or prompts are returned.",
        }),
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/usage/summary") {
      const mine = usage.localSummary();
      const { results, expected, responded } = await usage.fanout<usage.Shard>("/v1/usage/local");
      const merged = usage.mergeShards([mine, ...results]);
      return json(res, 200, {
        app: "x402-tokens",
        ...merged,
        coverage: usage.coverage(expected, responded, {
          identifying: "none — payer counts are distinct 8-char prefixes, never full addresses or IPs",
        }),
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
        // CLIENT-USABLE context, not the transformer window. Every model here
        // sits behind leCore auto-spill (+ POST /v1/hrr/bind), so a caller can
        // hand any of them a corpus far past its attention limit — that is the
        // whole product. Advertising the raw window tells clients to chunk
        // when they don't have to. The true attention limit stays visible as
        // max_model_len; single-POST ceiling is separate because a body that
        // big 413s at the edge regardless of what the model can hold.
        context_length: CLIENT_USABLE_CONTEXT,
        context_window: CLIENT_USABLE_CONTEXT,
        max_single_post_tokens: MAX_SINGLE_POST_TOKENS,
        ...(m.context ? { max_model_len: m.context } : {}),
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
      const { status, payload } = await bindPassthrough({ ...cfg, lecoreTenant: tenantFor(cfg, req) }, body);
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
        const r = thread
          ? await withTenantFallback(cfg, req, (c) => prepare(c, body as Record<string, unknown>, thread))
          : await prepare({ ...cfg, lecoreTenant: tenantFor(cfg, req), lecoreTopK: topKFor(cfg, req) }, body as Record<string, unknown>, thread);
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
          const a = await withTenantFallback(cfg, req, (c) => attach(c, prepped, headerCtx));
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
        // WHY leCore did not engage. Without this a fail-open is invisible in
        // telemetry — it looks identical to "engaged and forwarded", and the
        // only symptom is a surprising bill.
        lecore_reason: lecoreInfo.engaged ? undefined : lecoreInfo.reason,
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
        evt("failed_settle", { payer: settled.payer ?? v.payer, reason, billedUsd: q.billedUsd });
        // clean 402, retryable: the client rebuilds (fresh blockhash / topped-up
        // balance) and pays against the re-quote below.
        return json(res, 402, challenge(cfg, q, resource, `payment failed: ${reason}`), { "x-402-priced-at": q.pricedAt });
      }

      const out = await complete(cfg.openrouterUrl, cfg.openrouterKey, { ...prepped, stream: false }, cfg.publicUrl);
      evt(out.status >= 200 && out.status < 300 ? "paid_200" : "paid_upstream_error", {
        payer: settled.payer ?? v.payer,
        upstream: out.status,
        billedUsd: q.billedUsd,
        tx: settled.transaction, // public on-chain; the receipt a caller can verify themselves
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
      usage.initUsage(); // notices the volume (if any) and replays its tail into the ring
      const s = createServer((req, res) => {
        handler(req, res).catch((e) => json(res, 500, { error: (e as Error).message.slice(0, 160) }));
      });
      // "::" = dual stack (IPv4-mapped still accepted). 0.0.0.0 bound IPv4 only,
      // which left the machine unreachable on its Fly 6PN address — the usage
      // fan-out between machines talks over exactly that address.
      s.listen(port, process.env.BIND_HOST || "::", () => console.log(`x402-tokens :${port}  ${cfg.publicUrl}`));
      return s;
    },
  };
}

export { loadConfig };
void extname;
