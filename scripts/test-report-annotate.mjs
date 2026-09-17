#!/usr/bin/env node
// 把 `test-report.mjs --json <报告>` 里**失败/违规**的条目打成 GitHub 注解。
//
// ## 为什么存在（2026-09-17 的真实教训）
// CI 在默认组连续红了三次（`7a6df321` / `bb993251` / `6569e2b9`），而**没有任何人能说出是哪条门禁红**：
//   · 步骤日志要鉴权；
//   · artifact（`test-report-checks.json`，报告其实**已经生成了**）下载也要鉴权；
//   · `check-runs/{id}/annotations` 是唯一的公开通道，而它当时是**空的**——因为工作流从没写过注解。
// 结果：红只变成了一句"又红了"，团队为此白花半天去猜（本机全绿、Linux 上红，猜不出是 22 条里的哪条）。
// ⇒ 失败证据必须**落到不需要鉴权就能读的地方**，这一步就是那条路。
//
// 用法：`node scripts/test-report-annotate.mjs <报告.json>`（CI 里紧跟门禁步骤，`if: failure()` 调用）
// 退出码：**永远 0**——它只报告，不改变结论（红还是红，由原步骤决定）。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 注解消息里不放换行（GitHub 的注解是单行；多行会被截断成半句）。 */
const oneLine = (s, max = 900) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** GitHub 工作流命令：`::error::` 会被渲染成该 check run 的注解。 */
function annotate(title, message) {
  // 转义规则见 GitHub docs：`%` → `%25`、`\r` → `%0D`、`\n` → `%0A`，
  // 属性区还要转 `:` 与 `,`。
  const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const escProp = (s) => esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  process.stdout.write(`::error title=${escProp(title)}::${esc(message)}\n`);
}

const path = resolve(process.argv[2] ?? "test-report-checks.json");
let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  // 报告都不在（例如步骤在写报告之前就崩了）——也要说清，否则又是一次"红了但没证据"。
  annotate("门禁报告缺失", `${path} 读不到（${err.message}）：失败发生在写报告之前，请看这一步之前的日志`);
  process.exit(0);
}

const results = Array.isArray(report.results) ? report.results : [];
const failed = results.filter((r) => r.status === "failed");
const skipped = results.filter((r) => r.status === "skipped");

for (const r of failed) {
  const detail = [
    r.incident ? `挡什么：${r.incident}` : "",
    r.commands?.length ? `命令：${r.commands.map((c) => `${c.cmdline} ⇒ ${c.status}${c.code != null ? `(${c.code})` : ""}`).join("；")}` : "",
    r.failures?.length ? `失败明细：${r.failures.slice(0, 5).join(" ｜ ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  annotate(`门禁红了：${r.id}`, `（分组 ${r.group}）${r.label ?? ""} ${detail}`);
}

for (const v of report.baselineViolations ?? []) {
  annotate("基线退步", oneLine(v));
}

// 一条汇总：一眼能看出"红的是哪几条 / 跳过了什么"（跳过也要报，否则"没跑"会被当成"通过"）。
annotate(
  failed.length ? `门禁失败汇总（${failed.length} 条）` : "门禁步骤失败，但没有失败的门禁条目",
  oneLine(
    [
      failed.length ? `失败：${failed.map((r) => r.id).join(", ")}` : "",
      skipped.length ? `跳过：${skipped.map((r) => `${r.id}（${r.reason ?? ""}）`).join(", ")}` : "",
      `共 ${results.length} 条门禁；平台 ${report.platform ?? "?"}；node ${report.node ?? "?"}`,
    ]
      .filter(Boolean)
      .join(" · "),
  ),
);

process.exit(0);
