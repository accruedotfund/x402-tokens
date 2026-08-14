/**
 * leCore in front of the passthrough.
 *
 * Moose: "the best way to run a model is with a holographic transformer
 * anyway... We add leCore in front and boom" -> every model on the zoo gets
 * HRR memory, without the provider knowing.
 *
 * WHY THIS RUNS BEFORE THE QUOTE, not before the upstream fetch: server.ts
 * prices the 402 from `estimateTokens(body.messages)`. If the spill happened
 * after the quote, a user pasting a book would be billed 3x on the WHOLE book
 * and only then get the benefit. Spilling first is the entire economic point:
 * the 402 names 3x of the *retrieved slice*, so long context on this zoo is
 * structurally cheaper than the same model on OpenRouter direct.
 *
 * FAIL-OPEN, deliberately, and it differs from the lecore gateway. app.py is
 * fail-closed (never answer without attach) because there the memory IS the
 * product. Here memory is an upgrade on a passthrough someone already paid
 * for, so an HRR outage must not take the whole zoo down. Set
 * LECORE_REQUIRED=1 to make it fail-closed instead. Either way the outcome is
 * reported in `x402.lecore` -- a silent downgrade would be a lie about what
 * was billed.
 */
import type { Config } from "./config.js";
import { estimateTokens } from "./math.js";

export interface LecoreResult {
  /** body to forward + price. Unchanged when leCore did not engage. */
  body: Record<string, unknown>;
  info: {
    engaged: boolean;
    reason?: string;
    contextId?: string;
    tokensBefore: number;
    tokensAfter: number;
    spilledTokens?: number;
  };
}

interface Msg { role?: string; content?: unknown }

const text = (c: unknown): string =>
  typeof c === "string" ? c
    : Array.isArray(c) ? c.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : "")).join("\n")
      : "";

/** The ASK inside a body that also carries corpus: last paragraph, capped.
 *  Used only as the retrieval query — the model still receives the full tail. */
export function askOf(s: string, max: number): string {
  const t = (s || "").trimEnd();
  if (t.length <= max) return t.trim();
  const para = t.split(/\n\s*\n/).pop() || t;
  return (para.length <= max ? para : para.slice(-max)).trim();
}


/** Newest-first walk: keep whole recent turns inside the live window, spill the rest. */
function split(msgs: Msg[], keepTokens: number): { live: Msg[]; spill: Msg[] } {
  const live: Msg[] = [];
  let used = 0;
  let i = msgs.length - 1;
  for (; i >= 0; i--) {
    const t = estimateTokens([msgs[i]]);
    if (used + t > keepTokens && live.length > 0) break;
    live.unshift(msgs[i]);
    used += t;
  }
  return { live, spill: msgs.slice(0, i + 1) };
}

async function post(url: string, payload: unknown, ms: number, key?: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function prepare(
  cfg: Config,
  body: Record<string, unknown>,
  thread?: string,
): Promise<LecoreResult> {
  const msgs = (Array.isArray(body.messages) ? body.messages : []) as Msg[];
  const before = estimateTokens(body.messages);
  const off = (r: string): LecoreResult => ({ body, info: { engaged: false, reason: r, tokensBefore: before, tokensAfter: before } });

  if (!cfg.lecoreUrl) return off("LECORE_HRR_URL unset");
  if (before <= cfg.lecoreSpillTokens) return off("under spill threshold");

  let { live, spill } = split(msgs, cfg.lecoreSpillTokens);

  // INTRA-MESSAGE SPILL. Turn-granularity is not enough: a needle-in-a-haystack
  // prompt (and any pasted document) is ONE message holding the whole corpus AND
  // the question, so message-level splitting finds nothing older than the live
  // window and leCore no-ops on exactly the case it exists for. Measured on
  // context-bench NIAH: 10,345 tokens, engaged=false, answered by raw attention.
  // So when the live window is still oversized, carve the LAST message: keep its
  // tail (the actual ask) and spill the head as passages.
  if (spill.length === 0 && live.length > 0) {
    const lastIdx = live.length - 1;
    const body_ = text(live[lastIdx].content);
    const tailChars = cfg.lecoreTailChars;
    if (body_.length > tailChars * 2) {
      const head = body_.slice(0, body_.length - tailChars);
      const tail = body_.slice(body_.length - tailChars);
      // OVERLAPPING WINDOWS. Fixed non-overlapping slices silently destroy any
      // fact that straddles a boundary: MEASURED on a 500k needle at position
      // 0.02, the 57-char needle line appeared in ZERO of 1,584 chunks
      // (`needle_chunk=[]`, all 1,584 bound), so retrieval could never have
      // found it and the miss looked like a ranker failure. It was a chunker
      // failure. Whether a fact is cut in half depends only on where it lands,
      // which is why the miss was positional and perfectly reproducible.
      // An overlap >= the longest fact guarantees every fact is wholly
      // contained in at least one window.
      const chunk = cfg.lecoreChunkChars;
      const overlap = Math.min(cfg.lecoreChunkOverlap, Math.floor(chunk / 2));
      const stride = Math.max(1, chunk - overlap);
      const passages: Msg[] = [];
      for (let i = 0; i < head.length; i += stride) {
        passages.push({ role: live[lastIdx].role ?? "user", content: head.slice(i, i + chunk) });
        if (i + chunk >= head.length) break;
      }
      spill = [...live.slice(0, lastIdx), ...passages];
      live = [{ ...live[lastIdx], content: tail }];
    }
  }
  if (spill.length === 0) return off("nothing older than the live window");

  try {
    // 1. BIND the older turns, role-marked so the ranker sees who said what.
    const items = spill.map((m) => ({ text: `${m.role ?? "user"}: ${text(m.content)}` }))
      .filter((it) => it.text.trim().length > 0);
    if (items.length === 0) return off("spill was empty after flattening");

    const bind = (await post(`${cfg.lecoreUrl}/internal/v1/hrr/bind`,
      { tenant_id: cfg.lecoreTenant, items, ...(thread ? { context_id: thread } : {}) }, cfg.lecoreTimeoutMs, cfg.lecoreKey)) as { context_id?: string };
    const contextId = bind?.context_id;
    if (!contextId) throw new Error("bind returned no context_id");

    // 2. RECALL the slice relevant to the live ask. This is what the user pays for.
    //
    // SEARCH WITH THE ASK, NOT THE ASK PLUS A PAGE OF THE CORPUS. The tail we
    // forward to the model is deliberately generous (LECORE_TAIL_CHARS, so the
    // model keeps local context), but using all of it as the QUERY is a bug that
    // silently inverts the ranking: measured on a 15k NIAH, a 2,000-char tail was
    // ~1,900 chars of filler, so the query vector looked like filler and the
    // filler chunks won at cosine 0.90 while the needle -- the least filler-like
    // passage in the corpus -- never made top-8. The ranker was right; the
    // question was wrong. Search with the last paragraph (the actual ask).
    const query = askOf(text(live[live.length - 1]?.content) || text(msgs[msgs.length - 1]?.content),
                        cfg.lecoreQueryChars);
    const rec = (await post(`${cfg.lecoreUrl}/internal/v1/hrr/recall`,
      { tenant_id: cfg.lecoreTenant, context_id: contextId, query, top_k: cfg.lecoreTopK }, cfg.lecoreTimeoutMs, cfg.lecoreKey)) as
      { items?: Array<{ text?: string }> };
    const slice = (rec?.items ?? []).map((x) => x?.text ?? "").filter(Boolean).join("\n---\n");

    const rebuilt: Msg[] = slice
      ? [{ role: "system", content: `Relevant earlier context, retrieved from holographic memory:\n${slice}` }, ...live]
      : live;
    const after = estimateTokens(rebuilt);
    return {
      body: { ...body, messages: rebuilt },
      info: { engaged: true, contextId, tokensBefore: before, tokensAfter: after, spilledTokens: before - after },
    };
  } catch (e) {
    const why = (e as Error).message.slice(0, 120);
    if (cfg.lecoreRequired) throw new Error(`lecore_unavailable: ${why}`);
    return off(`fail-open: ${why}`);
  }
}
