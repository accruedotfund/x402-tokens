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

  const { live, spill } = split(msgs, cfg.lecoreSpillTokens);
  if (spill.length === 0) return off("nothing older than the live window");

  try {
    // 1. BIND the older turns, role-marked so the ranker sees who said what.
    const items = spill.map((m) => ({ text: `${m.role ?? "user"}: ${text(m.content)}` }))
      .filter((it) => it.text.trim().length > 0);
    if (items.length === 0) return off("spill was empty after flattening");

    const bind = (await post(`${cfg.lecoreUrl}/v1/hrr/bind`,
      { items, ...(thread ? { context_id: thread } : {}) }, cfg.lecoreTimeoutMs, cfg.lecoreKey)) as { context_id?: string };
    const contextId = bind?.context_id;
    if (!contextId) throw new Error("bind returned no context_id");

    // 2. RECALL the slice relevant to the live ask. This is what the user pays for.
    const query = text(live[live.length - 1]?.content) || text(msgs[msgs.length - 1]?.content);
    const rec = (await post(`${cfg.lecoreUrl}/v1/hrr/recall`,
      { context_id: contextId, query, top_k: cfg.lecoreTopK }, cfg.lecoreTimeoutMs, cfg.lecoreKey)) as
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
