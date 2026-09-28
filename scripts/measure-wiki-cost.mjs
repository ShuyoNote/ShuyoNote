#!/usr/bin/env node
// scripts/measure-wiki-cost.mjs
//
// LLM wiki **第三块（要模型的那一块）** 的前置：**go/no-go 量测**。
//
// ## 为什么要先量、再写
// 需求（`docs/specs/2026-09-28-llm-wiki-requirements.md` §7/§8）写着：**模型成本若不可接受，
// 形态就从"生成专题页"降级成"只做导航索引"**。⇒ 在拿到读数之前写生成层，等于先赌一把再问价。
//
// ## 它量什么（以及**不**量什么）
// 量：给定上下文规模（段数 × 每段字数），本机端点**一次生成**的墙钟耗时与 token 数（端点报就记，
//     不报就写"未报"——**不许用字数除一个系数假装 token 数**）。
// 不量：端到端（真库 + 真检索 + 真落库）—— 那是接进应用之后的事；这份读数只是**成本下界**。
//
// ## 退出码（与工作区五档契约同源）
//   0 = 有读数（真的跑通了）
//   2 = **环境不具备**（端点连不上 / 模型不存在）—— **不算通过**，且**绝不打印假数字**
//   1 = 跑到了但端点报错（值得看的具体错误）
//
// 用法：
//   node scripts/measure-wiki-cost.mjs --base-url http://127.0.0.1:11434 --model qwen2.5:7b
//   node scripts/measure-wiki-cost.mjs --base-url http://127.0.0.1:1234/v1 --model qwen2.5-7b-instruct
//   node scripts/measure-wiki-cost.mjs --segments 2,8,32,128 --chars 800

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const BASE = (arg("base-url", process.env.WIKI_LLM_BASE ?? "http://127.0.0.1:11434")).replace(/\/$/, "");
const MODEL = arg("model", process.env.WIKI_LLM_MODEL ?? "");
const SEGMENTS = arg("segments", "2,8,32").split(",").map((x) => Number(x.trim())).filter((n) => n > 0);
const CHARS = Number(arg("chars", "800"));
const TIMEOUT_MS = Number(arg("timeout-ms", "600000"));

/** OpenAI 兼容端点的判据：URL 里带 `/v1`（Ollama 的原生 API 不带）。 */
const OPENAI_STYLE = /\/v1$/.test(BASE);

function envMissing(why, how) {
  console.error(`环境不具备（不算通过）：${why}`);
  console.error(`  复现：node scripts/measure-wiki-cost.mjs --base-url ${BASE} --model <模型名>`);
  if (how) console.error(`  怎么修：${how}`);
  process.exit(2);
}

/** 造一段"代表性材料"：与 `librarySummary` 的输入同形（若干段正文），不掺假内容。 */
function makeContext(segments) {
  const body = "这是一段用于量测成本的正文。".repeat(Math.ceil(CHARS / 14)).slice(0, CHARS);
  return Array.from({ length: segments }, (_, i) => `【材料 ${i + 1}】${body}`).join("\n\n");
}

const PROMPT = `你是本地笔记库的总结器。下面是若干段材料。请输出 3 条结论，每条后面用 [n] 指出它来自第几段材料。
⚠️ 只许引用上面出现过的材料编号；不确定就不要写。`;

async function probe() {
  const url = OPENAI_STYLE ? `${BASE}/models` : `${BASE}/api/tags`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) envMissing(`端点 ${url} 返回 HTTP ${r.status}`, "确认模型服务在跑（Ollama: `ollama serve`）");
    const j = await r.json();
    const names = OPENAI_STYLE ? (j.data ?? []).map((m) => m.id) : (j.models ?? []).map((m) => m.name);
    if (!MODEL) envMissing("没给 `--model`", `可用模型：${names.slice(0, 8).join(", ") || "(端点没报模型列表)"}`);
    if (names.length && !names.some((n) => n === MODEL || n.startsWith(`${MODEL}:`))) {
      envMissing(`端点里没有模型 \`${MODEL}\``, `可用：${names.slice(0, 8).join(", ")}`);
    }
  } catch (e) {
    envMissing(`连不上 ${url}（${e?.message ?? e}）`, "先起本机模型服务；这是**红线允许**的本机端点");
  }
}

async function callOnce(context) {
  const t0 = Date.now();
  const url = OPENAI_STYLE ? `${BASE}/chat/completions` : `${BASE}/api/chat`;
  const body = OPENAI_STYLE
    ? { model: MODEL, stream: false, messages: [{ role: "user", content: `${PROMPT}\n\n${context}` }] }
    : { model: MODEL, stream: false, messages: [{ role: "user", content: `${PROMPT}\n\n${context}` }] };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const wallMs = Date.now() - t0;
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    console.error(`  ✗ HTTP ${r.status}：${text.slice(0, 200)}`);
    process.exit(1);
  }
  const j = await r.json();
  const promptTokens = OPENAI_STYLE ? j.usage?.prompt_tokens : j.prompt_eval_count;
  const completionTokens = OPENAI_STYLE ? j.usage?.completion_tokens : j.eval_count;
  const answer = OPENAI_STYLE ? j.choices?.[0]?.message?.content : j.message?.content;
  return {
    wallMs,
    promptTokens: typeof promptTokens === "number" ? promptTokens : null,
    completionTokens: typeof completionTokens === "number" ? completionTokens : null,
    answerChars: (answer ?? "").length,
    /** ⭐ 回链纪律的现场抽查：结论里引用的材料编号有没有超出输入范围（第三块也要守这条）。 */
    maxRef: Math.max(0, ...[...String(answer ?? "").matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))),
  };
}

await probe();
console.log(`量测端点：${BASE}（${OPENAI_STYLE ? "OpenAI 兼容" : "Ollama 原生"}）· 模型：${MODEL}`);
console.log(`每段 ${CHARS} 字 · 段数梯度：${SEGMENTS.join(" / ")}\n`);
console.log("段数 | 上下文字数 | 墙钟(ms) | prompt tokens | completion tokens | 结论字数 | 最大回链号");
console.log("---- | ---------- | -------- | ------------- | ----------------- | -------- | ----------");

const rows = [];
for (const n of SEGMENTS) {
  const ctx = makeContext(n);
  const r = await callOnce(ctx);
  const refBad = r.maxRef > n;
  rows.push({ n, chars: ctx.length, ...r, refBad });
  console.log(
    `${String(n).padStart(4)} | ${String(ctx.length).padStart(10)} | ${String(r.wallMs).padStart(8)} | ` +
      `${String(r.promptTokens ?? "未报").padStart(13)} | ${String(r.completionTokens ?? "未报").padStart(17)} | ` +
      `${String(r.answerChars).padStart(8)} | ${String(r.maxRef || "-").padStart(10)}${refBad ? "  ⚠️ 越界" : ""}`,
  );
}

const big = rows[rows.length - 1];
console.log("\n=== 怎么判（阈值**待 owner 定**，这里只给读数与算式）===");
console.log(`· 最大那一档：${big.chars} 字上下文 ⇒ ${big.wallMs} ms`);
if (big.promptTokens) console.log(`· 端点报的 prompt tokens：${big.promptTokens}（≈ ${(big.chars / big.promptTokens).toFixed(2)} 字/token）`);
console.log("· 粗算：一次「库地图 + 专题页」要跑多少档 × 每档多少 ms ⇒ 就是用户等待时间与电费");
console.log("· **go/no-go**：若「一页专题」的耗时/占用超出可用范围 ⇒ 按需求 §7 降级为「只做导航索引」（那不需要模型）");
if (rows.some((r) => r.refBad)) {
  console.log("⚠️ 出现了越界回链（`[n]` 超过输入段数）⇒ 第三块的**强制引用**还没有现场证据，别急着做 UI");
}
console.log("\n（本读数只是成本下界：没算真库取材、真检索、真落库。）");
