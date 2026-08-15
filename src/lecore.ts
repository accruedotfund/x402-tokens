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
    /** "spill" = big body carved + bound here; "attach" = caller referenced a
     *  pre-bound context via X-HRR-Context and we only recalled. */
    mode?: "spill" | "attach";
    reason?: string;
    contextId?: string;
    tokensBefore: number;
    tokensAfter: number;
    spilledTokens?: number;
    /** attach only: how many passages recall returned. */
    recalled?: number;
  };
}

/** The context named in X-HRR-Context no longer exists on the sidecar
 *  (wiped, expired, or never bound here). Surfaced as HTTP 404 BEFORE the 402
 *  so a client with a stale manifest can re-bind without paying. */
export class ContextGoneError extends Error {
  constructor(public contextId: string) {
    super(`hrr context not found: ${contextId}`);
  }
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


/** tool_call ids DEFINED by the assistant messages in a set. */
function definedCallIds(msgs: Msg[]): Set<string> {
  const ids = new Set<string>();
  for (const m of msgs) {
    const calls = (m as { tool_calls?: Array<{ id?: string }> }).tool_calls;
    if (Array.isArray(calls)) for (const c of calls) if (c?.id) ids.add(c.id);
  }
  return ids;
}

/**
 * A tool RESULT and the assistant tool_call that spawned it are one atomic
 * unit — split them and the upstream rejects with
 *   400 "No tool call found for function call output with call_id …"
 * because every function_call_output must match an earlier function_call of
 * the same id. The newest-first split can leave a result LIVE while its call
 * SPILLED (the call is older, so it lands in spill; the result is newer, so it
 * stays live). MEASURED: an agent run compacted 19,738->11,025 tokens and the
 * orphaned result 400'd the whole turn.
 *
 * Fix: pull messages back from the end of spill into live until every live
 * tool result's defining call is also live. Costs a few tokens of compaction,
 * never correctness.
 */
export function keepToolPairs(live: Msg[], spill: Msg[]): { live: Msg[]; spill: Msg[] } {
  const callIdOf = (m: Msg) => (m as { tool_call_id?: string }).tool_call_id;
  const dangles = (l: Msg[]) => {
    const defined = definedCallIds(l);
    return l.some((m) => m.role === "tool" && callIdOf(m) && !defined.has(callIdOf(m) as string));
  };
  let l = live;
  let s = spill;
  while (s.length && dangles(l)) {
    l = [s[s.length - 1], ...l];
    s = s.slice(0, -1);
  }
  return { live: l, spill: s };
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

async function postRaw(url: string, payload: unknown, ms: number, key?: string): Promise<{ status: number; json: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function post(url: string, payload: unknown, ms: number, key?: string): Promise<unknown> {
  const { status, json } = await postRaw(url, payload, ms, key);
  if (status < 200 || status >= 300) throw new Error(`${url} -> ${status}`);
  return json;
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

  // TOOL CONVERSATIONS ARE FORWARDED INTACT. keepToolPairs keeps a call with
  // its result across the spill boundary, but that is not enough for a
  // provider whose tool API is STATEFUL (OpenAI/Azure Responses API): removing
  // ANY message and prepending a recalled-context system message invalidates
  // the server-side correlation, and the continuation 400s with
  //   "No tool call found for function call output with call_id …"
  // MEASURED: multi-turn agent runs on openai/gpt-5.6-sol-pro failed
  // repeatedly while every synthetic spill reproduced clean. So when tool
  // calls are present we do not spill at all — the body forwards whole and the
  // fail-open pricing (markup 1) means the caller is not overcharged for it.
  const hasTools = msgs.some((m) =>
    Array.isArray((m as { tool_calls?: unknown[] }).tool_calls)
    || m.role === "tool"
    || (Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(
      (b) => b?.type === "tool_use" || b?.type === "tool_result")));
  if (hasTools) return off("fail-open: tool-call conversation forwarded intact (stateful provider tool-state)");

  let { live, spill } = split(msgs, cfg.lecoreSpillTokens);
  // Never orphan a tool result from its call across the spill boundary.
  ({ live, spill } = keepToolPairs(live, spill));

  // INTRA-MESSAGE SPILL. Turn-granularity is not enough: a needle-in-a-haystack
  // prompt (and any pasted document) is ONE message holding the whole corpus AND
  // the question, so message-level splitting finds nothing older than the live
  // window and leCore no-ops on exactly the case it exists for. Measured on
  // context-bench NIAH: 10,345 tokens, engaged=false, answered by raw attention.
  // So when the live window is still oversized, carve the LAST message: keep its
  // tail (the actual ask) and spill the head as passages.
  //
  // THE GUARD IS "live is still fat", NOT "spill is empty". Requiring an empty
  // spill was a real, expensive bug: an agent conversation (older turns + a
  // huge recent tool result / pasted corpus) put the older turns in spill and
  // then left the giant last message WHOLE in the live window — MEASURED in
  // production, a 2.78MB Cursor body reported tokens_before == tokens_after ==
  // 677,948, i.e. leCore "engaged" and forwarded the entire book anyway, at
  // $3.39 a call, repeatedly. Single-message bodies spilled fine, which is why
  // it survived testing. Carve whenever the live window is over the threshold.
  if (estimateTokens(live) > cfg.lecoreSpillTokens && live.length > 0) {
    const lastIdx = live.length - 1;
    const body_ = text(live[lastIdx].content);
    const tailChars = cfg.lecoreTailChars;
    if (body_.length > tailChars * 2) {
      const head = body_.slice(0, body_.length - tailChars);
      const tail = body_.slice(body_.length - tailChars);
      // CHUNKING IS LECORE'S DECISION, NOT OURS. We used to slice the head
      // into fixed windows here, which silently destroys any fact that
      // straddles a boundary — MEASURED, a 57-char needle appeared in ZERO of
      // 1,584 chunks, so retrieval was asked to find text that no longer
      // existed. leCore's chunk_text says exactly this in its docstring ("a
      // fact split across two chunks is retrievable from neither") and splits
      // on paragraphs instead. So send the head WHOLE and let the sidecar
      // chunk it with leCore; `chunk: true` on bind does that server-side.
      // Preserve anything already destined for spill — older turns come first
      // so the bound corpus keeps conversation order.
      const passages: Msg[] = [{ role: live[lastIdx].role ?? "user", content: head }];
      spill = [...spill, ...live.slice(0, lastIdx), ...passages];
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
      { tenant_id: cfg.lecoreTenant, items, chunk: true,
       chunk_max_chars: cfg.lecoreChunkChars, chunk_overlap: cfg.lecoreChunkOverlap,
       ...(thread ? { context_id: thread } : {}) }, cfg.lecoreTimeoutMs, cfg.lecoreKey)) as { context_id?: string };
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

/**
 * ATTACH: the caller already bound a corpus (POST /v1/hrr/bind) and now sends
 * a SMALL body naming it via X-HRR-Context. The body never ships twice — we
 * recall top-k against the pre-bound context and prepend it, instead of asking
 * the caller to re-upload megabytes so `prepare` can re-carve them.
 *
 * BILLING BASIS IS THE MARKUP PATH, ON PURPOSE. tokensAfter > tokensBefore
 * here (the body grew by the recalled slice), so quoteRequest's counterfactual
 * guard never fires and the caller pays markup x a tiny body — typically far
 * cheaper than the counterfactual on the full corpus. The receipt stays honest
 * about that basis (pricing: "markup", mode: "attach").
 *
 * A MISSING CONTEXT IS 404, NOT FAIL-OPEN. The caller asked a question about a
 * corpus we do not have; answering without it would be a confident lie billed
 * as memory. ContextGoneError -> HTTP 404 pre-402, so a stale client manifest
 * re-binds without paying. Other sidecar failures honor LECORE_REQUIRED.
 */
export async function attach(
  cfg: Config,
  body: Record<string, unknown>,
  contextId: string,
): Promise<LecoreResult> {
  const msgs = (Array.isArray(body.messages) ? body.messages : []) as Msg[];
  const before = estimateTokens(body.messages);
  const off = (r: string): LecoreResult => ({ body, info: { engaged: false, mode: "attach", reason: r, contextId, tokensBefore: before, tokensAfter: before } });
  if (!cfg.lecoreUrl) return off("LECORE_HRR_URL unset");

  const query = askOf(text(msgs[msgs.length - 1]?.content), cfg.lecoreQueryChars);
  if (!query) return off("empty ask");

  try {
    const { status, json: rec } = await postRaw(`${cfg.lecoreUrl}/internal/v1/hrr/recall`,
      { tenant_id: cfg.lecoreTenant, context_id: contextId, query, top_k: cfg.lecoreTopK },
      cfg.lecoreTimeoutMs, cfg.lecoreKey);
    if (status === 404) throw new ContextGoneError(contextId);
    if (status < 200 || status >= 300) throw new Error(`recall -> ${status}`);
    const items = ((rec as { items?: Array<{ text?: string }> })?.items ?? []);
    const slice = items.map((x) => x?.text ?? "").filter(Boolean).join("\n---\n");
    const rebuilt: Msg[] = slice
      ? [{ role: "system", content: `Relevant earlier context, retrieved from holographic memory:\n${slice}` }, ...msgs]
      : msgs;
    const after = estimateTokens(rebuilt);
    return {
      body: { ...body, messages: rebuilt },
      info: { engaged: true, mode: "attach", contextId, tokensBefore: before, tokensAfter: after, recalled: items.length },
    };
  } catch (e) {
    if (e instanceof ContextGoneError) throw e;
    const why = (e as Error).message.slice(0, 120);
    if (cfg.lecoreRequired) throw new Error(`lecore_unavailable: ${why}`);
    return off(`fail-open attach: ${why}`);
  }
}

/**
 * Thin public bind passthrough -> sidecar /internal/v1/hrr/bind.
 * Free (no 402): auto-spill already binds unpaid bodies before the payment
 * check, so this adds no exposure — it just lets a client bind ONCE and then
 * ask forever with X-HRR-Context. Chunking stays leCore's decision
 * (chunk: true), same as the spill path. item_ids are dropped from the reply:
 * a 3.7MB corpus chunks into thousands and the caller only needs the id.
 */
export async function bindPassthrough(
  cfg: Config,
  body: { items?: Array<{ text?: string }>; corpus?: string; context_id?: string; mode?: string },
): Promise<{ status: number; payload: Record<string, unknown> }> {
  if (!cfg.lecoreUrl) return { status: 503, payload: { error: "hrr_unconfigured: LECORE_HRR_URL unset" } };
  const items = Array.isArray(body.items) && body.items.length
    ? body.items
    : (typeof body.corpus === "string" && body.corpus.trim() ? [{ text: body.corpus }] : []);
  if (!items.length) return { status: 400, payload: { error: "items (array of {text}) or corpus (string) required" } };

  const { status, json } = await postRaw(`${cfg.lecoreUrl}/internal/v1/hrr/bind`,
    { tenant_id: cfg.lecoreTenant, items, chunk: true,
      chunk_max_chars: cfg.lecoreChunkChars, chunk_overlap: cfg.lecoreChunkOverlap,
      ...(body.context_id ? { context_id: body.context_id } : {}),
      ...(body.mode ? { mode: body.mode } : {}) },
    cfg.lecoreTimeoutMs, cfg.lecoreKey);
  if (status < 200 || status >= 300) {
    const j = json as { error?: string; code?: string };
    return { status, payload: { error: j?.error || `bind -> ${status}`, code: j?.code } };
  }
  const out = json as { object?: string; context_id?: string; bound?: number };
  return { status: 200, payload: { object: out.object ?? "hrr.context", context_id: out.context_id, bound: out.bound } };
}
