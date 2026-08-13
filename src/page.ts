import type { Config } from "./config.js";

const esc = (x: unknown) =>
  String(x).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] as string));

/** What you paste into an agent. Keep it imperative and complete. */
export function clankerPrompt(cfg: Config): string {
  const rails = cfg.assets.map((a) =>
    `- ${a.symbol}  mint ${a.mint}  ${a.feeBps}bps tax  price ${a.stableUsd ? `$${a.stableUsd} stable` : `Birdeye ${a.priceMint} at the 402`}`
  ).join("\n");
  return `Use ${cfg.publicUrl} as an OpenAI-compatible inference endpoint. There is no API key.

POST ${cfg.publicUrl}/v1/chat/completions
Content-Type: application/json

Body is a normal OpenRouter/OpenAI chat completion:
{"model":"${cfg.defaultModel}","messages":[{"role":"user","content":"..."}],"max_tokens":256}

You will get HTTP 402. That is the product, not an error.

accepts[] will include one row per live rail. Pick ONE:
${rails}

Every row:
- network: ${cfg.network}
- payTo: ${cfg.payTo}
- feePayer: ${cfg.feePayer}   ← tx feePayer MUST be this. you do not pay SOL.
- maxAmountRequired: already ${cfg.markup}× OpenRouter USD, in that token's raw units, grossed up for its transfer tax. do not reprice it.
- facilitator: ${cfg.facilitator}

Build one Solana legacy Transaction:
1. feePayer = ${cfg.feePayer}
2. exactly one Token-2022 TransferChecked: your ATA of the chosen mint → payTo's ATA, amount = maxAmountRequired, decimals = 6
3. you sign as the token owner. leave the feePayer signature empty.
4. serialize requireAllSignatures=false, base64 that bytes

X-PAYMENT header = base64 of this JSON (utf8):
{"x402Version":1,"scheme":"exact","network":"${cfg.network}","payload":{"transaction":"<base64-tx>"}}

POST the SAME body again with X-PAYMENT set. Do not change model/messages/max_tokens after the 402 — the quote is for that body.

On 200 you get a normal chat.completion.

Raw TOKEN (EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump) and raw USDC will not settle. Wrap first:
- USDC → yUSDCx via FrSERTNCPvTtaDS9AvQp9u1nYGzXDb3kC9MdL8Xxn2NE escrow 2qLm8aCvn6gQVUFeQ7EC5J62Y95gFzc3vReHzD5d5Gj2
- TOKEN → wTOKENx via the same program, escrow 7j682FdwSdTkXNjbMrrLd5wcXQoh23UTZaDReqKXbL2q
Both wraps are Token-2022 with a 20bps transfer tax. Yield is that tax.

Do not use api.cdp.coinbase.com. This service names ${cfg.facilitator}. GET ${cfg.publicUrl}/.well-known/x402.json and ${cfg.publicUrl}/prompt.txt if you want this text again.`;
}

/**
 * Work pattern: Decide, with a Learn spine.
 * One action — prove the 402 — sits above the explanation.
 * Gold is reserved for money. Teal is the room, not a gradient.
 */
export function renderIndex(cfg: Config): string {
  const rails = cfg.assets.map((a) => a.symbol).join(" or ");
  const curl = `curl -sS ${cfg.publicUrl}/v1/chat/completions \\
  -H 'content-type: application/json' \\
  -d '{"model":"${cfg.defaultModel}","messages":[{"role":"user","content":"say hi"}]}'`;
  const clanker = clankerPrompt(cfg);

  return `<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>tokens — pay tokens for tokens</title>
<meta name=description content="OpenRouter behind x402. Inference is 3× USD, paid in ${esc(rails)}, priced at the 402.">
<link rel=icon href=/token.jpg>
<style>
:root{
  color-scheme:dark;
  --bg:oklch(13% .014 165);
  --surface:oklch(17% .017 165);
  --line:oklch(28% .022 165);
  --ink:oklch(95% .012 165);
  --mid:oklch(72% .02 165);
  --dim:oklch(54% .022 165);
  --accent:oklch(84% .19 158);
  --accent-ink:oklch(16% .04 158);
  --money:oklch(85% .15 92);
  --ok:oklch(80% .16 152);
  --bad:oklch(72% .16 25);
  --sans:"Söhne","Helvetica Neue",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  --mono:"Berkeley Mono",ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  --0:clamp(.88rem,.83rem + .2vw,.97rem);
  --1:clamp(1.05rem,.96rem + .4vw,1.25rem);
  --2:clamp(1.6rem,1.2rem + 1.6vw,2.6rem);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:var(--0)/1.55 var(--sans);
  -webkit-font-smoothing:antialiased;
  padding:clamp(1.25rem,4vw,3.5rem) 1.25rem 6rem;
}
main{max-width:64rem;margin:0 auto;display:grid;gap:2.5rem}
@media(min-width:840px){
  .top{display:grid;grid-template-columns:1fr 16rem;gap:2.5rem;align-items:start}
}
.kicker{font-family:var(--mono);font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
h1{font-size:var(--2);letter-spacing:-.035em;line-height:1.05;margin:.4rem 0 0;max-width:16ch;text-wrap:balance}
h1 em{font-style:normal;color:var(--accent)}
.lede{color:var(--mid);font-size:var(--1);max-width:46ch;margin:.9rem 0 0}
.coin{width:100%;max-width:16rem;border-radius:50%;border:1px solid var(--line);display:block}
.prove{
  border:1px solid var(--line);border-radius:14px;background:var(--surface);
  padding:1.15rem 1.2rem 1.25rem
}
.prove h2{margin:0 0 .35rem;font-size:1rem;letter-spacing:-.02em}
.row{display:flex;flex-wrap:wrap;gap:.5rem;margin:.8rem 0}
button,.copy{
  font:640 .92rem/1 var(--sans);letter-spacing:-.01em;
  border-radius:10px;padding:.75rem 1rem;cursor:pointer;border:1px solid var(--accent);
  background:var(--accent);color:var(--accent-ink)
}
button:hover,.copy:hover{filter:brightness(1.06)}
button:disabled{opacity:.45;cursor:not-allowed}
button.ghost{background:transparent;color:var(--ink);border-color:var(--line)}
button:focus-visible,.copy:focus-visible,a.try:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
a.try{
  display:inline-flex;align-items:center;gap:.4rem;margin-top:1.15rem;
  font:640 var(--1)/1 var(--sans);letter-spacing:-.02em;text-decoration:none;
  border-radius:12px;padding:.9rem 1.15rem;border:1px solid var(--accent);
  background:var(--accent);color:var(--accent-ink)
}
a.try:hover{filter:brightness(1.06);color:var(--accent-ink)}
pre{
  margin:.6rem 0 0;padding:.85rem 1rem;border-radius:10px;overflow:auto;
  background:oklch(11% .014 165);border:1px solid var(--line);
  font: .82rem/1.45 var(--mono);color:var(--money);max-height:28rem
}
pre.err{color:var(--bad)}
.meta{color:var(--dim);font-family:var(--mono);font-size:.75rem;margin-top:.45rem}
ol{margin:.4rem 0 0;padding:0 0 0 1.2rem;max-width:58ch;color:var(--mid)}
li{margin:.45rem 0}
li strong{color:var(--ink)}
code{font-family:var(--mono);color:var(--money);font-size:.92em}
a{color:var(--accent)}
a:hover{color:var(--ink)}
.grid{display:grid;gap:1rem}
@media(min-width:700px){.grid{grid-template-columns:1fr 1fr}}
.card{border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;background:var(--surface)}
.card h3{margin:0 0 .35rem;font-size:.95rem}
.card p{margin:0;color:var(--mid)}
.live{color:var(--ok);font-family:var(--mono);font-size:.75rem}
footer{color:var(--dim);font-size:.85rem}
</style>
<body>
<main>
  <div class=top>
    <div>
      <div class=kicker>x402 · openrouter · ${esc(cfg.markup)}× usd</div>
      <h1>pay <em>tokens</em> for tokens</h1>
      <p class=lede>OpenRouter with no API key. You pay in ${esc(rails)}. Paste the clanker prompt into whatever is holding your keys. The 402 names the exact amount, in USD, at that second, times ${esc(cfg.markup)}.</p>
      <a class=try href="https://thunder-rose-pepper-zest.grok.me">try it yourself</a>
    </div>
    <img class=coin src=/token.jpg width=256 height=256 alt="TOKEN transit token">
  </div>

  <section class=prove>
    <div class=kicker>prompt your clanker</div>
    <h2>Dump this into Claude / Grok / Codex. It has everything.</h2>
    <p class=lede style="margin-top:.4rem;font-size:var(--0)">No SDK. No OpenRouter key. If it can POST and sign one Solana <code>TransferChecked</code>, it can buy inference here. Raw prompt also at <a href="/prompt.txt"><code>/prompt.txt</code></a>.</p>
    <div class=row>
      <button id=copyclanker type=button>copy prompt</button>
    </div>
    <pre id=clanker>${esc(clanker)}</pre>
    <div class=meta>rails: ${esc(cfg.assets.map((a) => a.symbol).join(" · "))} · payTo ${esc(cfg.payTo)}</div>
  </section>

  <section class=prove>
    <div class=kicker>prove it</div>
    <h2>Hit the endpoint. It should 402 you.</h2>
    <p class=lede style="margin-top:.4rem;font-size:var(--0)">No wallet in the browser. This button is a GET-equivalent POST with no <code>X-PAYMENT</code>. If the service is up you get a challenge, not a completion.</p>
    <div class=row>
      <button id=hit type=button>call /v1/chat/completions unpaid</button>
      <button id=copycurl class=ghost type=button>copy curl</button>
    </div>
    <pre id=out>${esc(curl)}</pre>
    <div class=meta id=status>unpaid POST · expect HTTP 402</div>
  </section>

  <section>
    <div class=kicker>for degenerates</div>
    <ol>
      <li><strong>Wrap first.</strong> Raw USDC and raw TOKEN will not settle. USDC → yUSDCx or TOKEN → wTOKENx. Same program, 20bps Token-2022 tax, yield stays in the wrap.</li>
      <li><strong>POST the same body again</strong> with header <code>X-PAYMENT</code> = base64 of an x402 payload whose transaction is a <code>TransferChecked</code> of <code>maxAmountRequired</code> of the chosen wrap to <code>${esc(cfg.payTo)}</code>, fee payer <code>${esc(cfg.feePayer)}</code>.</li>
      <li>The facilitator at <a href="${esc(cfg.facilitator)}">${esc(cfg.facilitator)}</a> verifies and sponsors gas. You need no SOL.</li>
      <li>On 200 you get a normal OpenRouter chat completion. The key never leaves this host.</li>
    </ol>
  </section>

  <div class=grid>
    <div class=card>
      <h3>Price</h3>
      <p>OpenRouter's published USD rate for the model, times ${esc(cfg.markup)}. yUSDCx is $1. wTOKENx is Birdeye spot of <a href="https://pump.fun/coin/EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump">TOKEN</a> <em>at the 402</em>. Both wraps take 20bps on transfer — that's the yield.</p>
    </div>
    <div class=card>
      <h3>What is live today</h3>
      <p class=live>yUSDCx · wTOKENx</p>
      <p style="margin-top:.4rem">TOKEN <code>EVULo…pump</code> on <a href="https://pump.fun/coin/EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump">pump.fun</a>. Spendable rail is wTOKENx <code>Bo7xBF7SY8EyUBPUxRP66SFafxoPf2n5uqiLjbxEebx9</code> — Token-2022, 20bps tax, PDA fee authority.</p>
    </div>
  </div>

  <footer>
    <a href="https://thunder-rose-pepper-zest.grok.me">try it yourself</a>
    · facilitator <a href="${esc(cfg.facilitator)}/supported">${esc(cfg.facilitator)}</a>
    · source <a href="https://github.com/accruedotfund/x402-tokens">accruedotfund/x402-tokens</a>
    · <a href="/prompt.txt">prompt.txt</a>
    · <a href="/.well-known/x402.json">manifest</a>
    · <a href="/healthz">healthz</a>
  </footer>
</main>
<script>
const out = document.getElementById("out");
const status = document.getElementById("status");
const hit = document.getElementById("hit");
const curl = ${JSON.stringify(curl)};
const clanker = ${JSON.stringify(clanker)};
document.getElementById("copyclanker").onclick = async () => {
  await navigator.clipboard.writeText(clanker);
  document.getElementById("copyclanker").textContent = "copied";
  setTimeout(() => document.getElementById("copyclanker").textContent = "copy prompt", 1200);
};
document.getElementById("copycurl").onclick = async () => {
  await navigator.clipboard.writeText(curl);
  document.getElementById("copycurl").textContent = "copied";
  setTimeout(() => document.getElementById("copycurl").textContent = "copy curl", 1200);
};
hit.onclick = async () => {
  hit.disabled = true;
  status.textContent = "calling…";
  out.classList.remove("err");
  try {
    const r = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: ${JSON.stringify(cfg.defaultModel)}, messages: [{ role: "user", content: "say hi" }] }),
    });
    const j = await r.json();
    out.textContent = JSON.stringify(j, null, 2);
    status.textContent = "HTTP " + r.status + (r.status === 402 ? " · that's the challenge. pay maxAmountRequired of the yUSDCx accept." : "");
    if (r.status !== 402) out.classList.add("err");
  } catch (e) {
    out.classList.add("err");
    out.textContent = String(e);
    status.textContent = "failed";
  } finally {
    hit.disabled = false;
  }
};
</script>
`;
}
