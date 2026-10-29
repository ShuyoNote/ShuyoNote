#!/usr/bin/env node
// check-rustfmt.mjs —— **Rust 格式门禁**：全仓 `cargo fmt --check` 必须干净（只有登记过的例外）。
//
// ## 为什么要有它（incident，2026-10-29）
// owner 拍「给 CI 加上 fmt 步骤」之前，这个仓库**没有任何东西守着 Rust 格式**：
// `.github/workflows/ci.yml` 的 rust job 只跑 `cargo test`，`pnpm verify` 的默认组是纯 Node。
// 于是 2026-10-29 全仓 `cargo fmt`（91 文件 / 近 1.5 万行）只能靠人手跑一次；
// 下一笔改 Rust 的人把代码写回旧排版，**没有任何读数会红**。
//
// ## 两个**登记例外**（不是偷懒，是判据本身要求）
// · `src-tauri/src/capabilities_gen.rs`：**生成物**，必须与 `gen-capabilities` 的输出逐字节一致；
//   重排它会让 `check-capabilities` 红。
// · `src-tauri/src/plugins.rs`：`check-capabilities` 按**原排版**解析 dispatch 的 match 臂；
//   重排后它会把参数口径读错（2026-10-29 实测：假红 5 条）。⇒ 这两个文件保持原样。
//   ⚠️ 例外表就是下面 `ALLOW`；**新增例外要写理由**，别为了变绿往里塞。
//
// ## 判据与退出码
// 0 = 干净（跑过 `cargo fmt --check`，差异只落在上面两个登记文件上）
// 1 = 有发现（有**未登记**的文件需要 rustfmt）
// 2 = 环境不具备（找不到 cargo/rustfmt，或 `cargo fmt` 失败但**没有** `Diff in` 行 ⇒ 判不了，不算通过）
// ⛔ 绝不把「命令没跑起来」当成「0 处问题」（`docs/TESTING.md` 的 fmt 那一节记着这条坑）。
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOW = new Map([
  [
    "src-tauri/src/capabilities_gen.rs",
    "生成物：必须与 `gen-capabilities` 输出逐字节一致，重排会让 `check-capabilities` 红",
  ],
  [
    "src-tauri/src/plugins.rs",
    "`check-capabilities` 按原排版解析 dispatch 的 match 臂，重排会让它把参数口径读错（假红）",
  ],
]);

const r = spawnSync("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--all", "--", "--check"], {
  cwd: ROOT,
  encoding: "utf8",
  env: process.env,
});
if (r.error) {
  console.error(`环境不具备：找不到 cargo/rustfmt（${r.error.message}）—— 不算通过`);
  process.exit(2);
}
const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
// cargo fmt 的差异行形态：`Diff in /abs/path/file.rs:12:`（每处一行）
const diffFiles = [
  ...new Set(
    [...out.matchAll(/^Diff in (.+?):\d+:/gm)].map((m) => {
      const abs = m[1].trim();
      return relative(ROOT, resolve(ROOT, abs));
    }),
  ),
];
if (r.status === 0) {
  console.log("✓ rustfmt 干净：全仓 .rs 已按 rustfmt 格式化（0 处差异）");
  process.exit(0);
}
if (diffFiles.length === 0) {
  console.error(
    `cargo fmt 退出码 ${r.status}，但输出里**没有** \`Diff in\` 行 —— 判不了（可能没找到清单/工具没跑起来），不算通过`,
  );
  process.exit(2);
}
const bad = diffFiles.filter((f) => !ALLOW.has(f));
if (bad.length > 0) {
  console.error(`✗ rustfmt 不干净：${bad.length} 个**未登记**的文件需要格式化（登记例外只有 ${ALLOW.size} 个）：`);
  for (const f of bad) console.error(`  - ${f}`);
  console.error("修：`cargo fmt --manifest-path src-tauri/Cargo.toml --all`（⛔ 别把未登记文件塞进 ALLOW 变绿）");
  process.exit(1);
}
console.log(`✓ rustfmt 干净：差异只落在 ${ALLOW.size} 个**已登记例外**上（其余 0 处）`);
for (const [f, why] of ALLOW) console.log(`  · ${f}（${why}）`);
process.exit(0);
