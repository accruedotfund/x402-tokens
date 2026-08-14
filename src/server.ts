import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { complete, listModels } from "./openrouter.js";
import { clankerPrompt, renderIndex } from "./page.js";
import { quoteLive } from "./quote.js";
import { prepare, type LecoreResult } from "./lecore.js";
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

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let body: { model?: string; messages?: unknown; max_tokens?: number; stream?: boolean };
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
      if (!body.messages) return json(res, 400, { error: "messages required" });

      // leCore in front. MUST precede quoteLive: the 402 is priced from
      // estimateTokens(messages), so spilling after the quote would bill the
      // caller 3x on the whole book and hand them the discount they already
      // paid for. Thread key lets a caller keep one holographic context.
      const thread = (req.headers["x-hrr-context"] as string | undefined)
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

      // price the counterfactual when leCore engaged: the caller pays a fraction of
      // what this body would have cost them direct, not a markup on the slice.
      const q = await quoteLive(cfg, prepped,
        lecoreInfo.engaged ? lecoreInfo.tokensBefore : undefined);
      const reqs = requirements(cfg, q, resource);
      const header = req.headers["x-payment"] as string | undefined;
      if (!header) {
        return json(res, 402, challenge(cfg, q, resource), { "x-402-priced-at": q.pricedAt });
      }
      const v = await verify(cfg, header, reqs);
      if (!v.ok || !v.picked) {
        return json(res, 402, challenge(cfg, q, resource, v.reason ?? "invalid payment"));
      }

      const out = await complete(cfg.openrouterUrl, cfg.openrouterKey, { ...prepped, stream: false }, cfg.publicUrl);
      const settled = await settle(cfg, header, v.picked).catch((e) => ({ success: false, errorReason: (e as Error).message }));
      console.log("settle", JSON.stringify(settled));
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
