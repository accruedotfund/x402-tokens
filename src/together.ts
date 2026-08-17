/**
 * MEDIA UPSTREAM — Together.ai.
 *
 * WHY A SECOND UPSTREAM AT ALL. OpenRouter is text: of its 413 models
 * (checked 2026-08-16) exactly 9 emit images, 4 emit audio, and ZERO emit
 * video. A gateway that only speaks /v1/chat/completions therefore cannot
 * serve "make me a video" no matter which model id you throw at it — the
 * capability is absent upstream, not mis-wired locally. Together carries 30
 * image and 38 video models (Sora 2, Veo 3.1, Kling, Seedance, Wan, FLUX-3,
 * pixverse), so it is the media lane.
 *
 * TWO DIFFERENT CONTRACTS ON TWO DIFFERENT API VERSIONS:
 *   images  POST {v1}/images/generations  {model, prompt, ...} -> {data:[{url}]}
 *           synchronous, ~0.14s on FLUX.1-schnell (measured).
 *   video   POST {v2}/videos              {model, prompt, ...} -> {id, status}
 *           async; poll GET {v2}/videos/{id} until status leaves
 *           "in_progress", then read outputs.video_url.
 *
 * THE VIDEO ENDPOINT IS NOT UNDER /v1, AND THAT COSTS AN HOUR IF YOU ASSUME
 * IT IS. There IS a /v1/videos/generations — it accepts a request, validates a
 * nested `payload` field, and then answers `model_not_found` for EVERY model,
 * including ids the catalog returns as type:"video" and including ids that
 * /v1/images/generations resolves by name. That looks exactly like an account
 * entitlement gate and it is not one: it is a dead/legacy route. The live one
 * is POST https://api.together.ai/v2/videos with a FLAT body (no `payload`
 * wrapper), confirmed against Together's own SDK (together-ai@0.49.0,
 * resources/videos.ts pins defaultBaseURL 'https://api.together.ai/v2') and
 * then end-to-end: job 01a00ca0-d2c8-748c-bc11-2e08c655b422 came back 200
 * in_progress on the first call.
 *
 * `resolution` is '720P' or '1080P' — UPPERCASE P. '480p' fails the job
 * asynchronously with InvalidParameter, i.e. after it is accepted, so a
 * lowercase value looks like a submit success and dies 6 seconds later.
 */

export type MediaKind = "image" | "video";

export interface MediaModel {
  id: string;
  kind: MediaKind;
  displayName?: string;
  organization?: string;
  /** Upstream USD for ONE generation at the vendor's example configuration.
   *  See unitCostUsd() for why this is a floor and not a formula. */
  exampleUsd: number;
  /** Verbatim vendor text for what exampleUsd buys ("1080p / 8s"). Surfaced
   *  in /v1/models so a caller can see what they are being quoted against. */
  exampleNote?: string;
  /** Set only when the vendor prices by area rather than per generation. */
  perMegapixelUsd?: number;
  minSteps?: number;
}

interface Cache {
  at: number;
  byId: Map<string, MediaModel>;
}

let cache: Cache | null = null;
const TTL = 10 * 60_000;

interface RawModel {
  id: string;
  type?: string;
  display_name?: string;
  organization?: string;
  pricing?: {
    image?: number | { example_price?: number; example_description?: string };
    video?: number | { example_price?: number; example_description?: string };
    image_pixel?: number | { price_per_megapixel?: number; min_steps?: number };
  };
}

function unwrap(p: unknown): { price: number; note?: string } {
  if (typeof p === "number") return { price: p };
  if (p && typeof p === "object") {
    const o = p as { example_price?: number; example_description?: string };
    return { price: Number(o.example_price ?? 0), note: o.example_description };
  }
  return { price: 0 };
}

export async function listMedia(base: string, key: string): Promise<Cache> {
  if (cache && Date.now() - cache.at < TTL) return cache;
  const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`together /models ${r.status}`);
  const j = (await r.json()) as RawModel[] | { data?: RawModel[] };
  const rows = Array.isArray(j) ? j : (j.data ?? []);
  const byId = new Map<string, MediaModel>();
  for (const m of rows) {
    if (m.type !== "image" && m.type !== "video") continue;
    const kind = m.type as MediaKind;
    const unit = unwrap(m.pricing?.[kind]);
    const px = m.pricing?.image_pixel;
    const pxo = px && typeof px === "object" ? px : undefined;
    byId.set(m.id, {
      id: m.id,
      kind,
      displayName: m.display_name,
      organization: m.organization,
      exampleUsd: unit.price,
      exampleNote: unit.note,
      perMegapixelUsd: pxo?.price_per_megapixel,
      minSteps: pxo?.min_steps,
    });
  }
  cache = { at: Date.now(), byId };
  return cache;
}

export async function getMedia(base: string, key: string, id: string): Promise<MediaModel> {
  const all = await listMedia(base, key);
  const m = all.byId.get(id);
  if (!m) throw new Error(`unknown media model ${id}`);
  return m;
}

/** Test hook — the catalog is a 10-minute cache and tests must not inherit it. */
export function _clearMediaCache() { cache = null; }

/**
 * UPSTREAM COST FOR ONE GENERATION, ROUNDED UP ON PURPOSE.
 *
 * Token math does not apply here and there is no honest formula to recover:
 * Together's own `example_description` strings are mutually inconsistent
 * across models — "1080p / 8s", "per 5 seconds of video", "0.090/s at 1080p
 * without audio", "$0.115/sec & 720P: from $0.249/sec". Parsing that prose
 * into a rate would be inventing precision we do not have, and the failure is
 * not symmetric: we SETTLE BEFORE THE UPSTREAM CALL (see server.ts), so every
 * dollar we underprice is a dollar we simply lose, while an overprice is
 * visible to the caller in the 402 before they agree to it.
 *
 * So: treat exampleUsd as the price of ONE generation at the vendor's example
 * configuration, and scale it by whole example-length blocks when the caller
 * asks for a longer clip. Images priced per megapixel use the area they
 * actually requested. Both round up. The quote carries priceModel so the
 * caller can see this is an estimate against a vendor example, not a metered
 * rate — never present it as the latter.
 */
export function unitCostUsd(m: MediaModel, opts: { width?: number; height?: number; seconds?: number; n?: number }): number {
  const n = Math.max(1, Math.floor(opts.n ?? 1));
  if (m.kind === "image") {
    if (m.perMegapixelUsd && opts.width && opts.height) {
      const mp = (opts.width * opts.height) / 1_000_000;
      return m.perMegapixelUsd * Math.max(mp, 0.25) * n;
    }
    return m.exampleUsd * n;
  }
  // video: the example note names a clip length for most models; when we can
  // read one, bill whole blocks of it, else one block. Never fewer than one.
  const secsInExample = readSeconds(m.exampleNote) ?? 5;
  const want = Math.max(1, Number(opts.seconds ?? secsInExample));
  const blocks = Math.max(1, Math.ceil(want / secsInExample));
  return m.exampleUsd * blocks * n;
}

/** Pull a clip length out of vendor prose ("1080p / 8s", "per 5 seconds of
 *  video"). Returns undefined when the string does not name one — the caller
 *  then assumes a single block rather than guessing a rate. */
export function readSeconds(note?: string): number | undefined {
  if (!note) return undefined;
  const m = note.match(/(\d+(?:\.\d+)?)\s*(?:s\b|sec\b|secs\b|seconds\b)/i);
  if (!m) return undefined;
  const v = Number(m[1]);
  return v > 0 && v <= 600 ? v : undefined;
}

export interface ImageResult {
  status: number;
  json: unknown;
}

export async function generateImage(base: string, key: string, body: Record<string, unknown>): Promise<ImageResult> {
  const r = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({ error: `together ${r.status}` }));
  return { status: r.status, json };
}

/**
 * Normalize a caller's resolution to what the video API will actually accept.
 *
 * This is not cosmetic tidying. An unaccepted value ('480p', '720p') passes
 * submit and fails the JOB six seconds later — and we settle before the
 * upstream call, so the caller would have paid for a clip that never renders.
 * Anything we do not recognise becomes 720P rather than being forwarded
 * verbatim to fail.
 */
export function normalizeResolution(v: unknown): "720P" | "1080P" {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "1080P" || s === "1080" ? "1080P" : "720P";
}

/** Submit a video job. FLAT body against the v2 base — see the header note:
 *  the /v1 route with a nested `payload` exists but answers model_not_found
 *  for every model in the catalog. */
export async function submitVideo(videoBase: string, key: string, model: string, args: Record<string, unknown>): Promise<ImageResult> {
  const r = await fetch(`${videoBase}/videos`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...args, model }),
  });
  const json = await r.json().catch(() => ({ error: `together ${r.status}` }));
  return { status: r.status, json };
}

export async function pollVideo(videoBase: string, key: string, id: string): Promise<ImageResult> {
  const r = await fetch(`${videoBase}/videos/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const json = await r.json().catch(() => ({ error: `together ${r.status}` }));
  return { status: r.status, json };
}
