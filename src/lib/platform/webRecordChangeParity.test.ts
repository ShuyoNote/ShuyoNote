// R139「治根」的**两侧同形**判据：桌面（Rust）与 Web（TS）各有一份 `record_change`，
// 而"别把整篇快照堆进同步日志"这件事**必须两边同时做** —— 只做一边，另一边照旧每保存一次
// 追加一份全量快照 ✗（实测：那让一个空间的库 2 天涨到 672 MB，占全库 91%，98.7% 是重复 ✗）。
//
// 为什么判据长这样（而不是跑行为）：Web 侧唯一的可观察出口是 `doPush`（要真的同步服务端 ✗），
// 所以**行为**那半由桌面侧的运行期判据承重（`sync::tests::recording_the_same_entity_twice_before_push_coalesces`
// ⇒ 变异组逐字红 `left: 3 / right: 1`，实现后 `1 passed` ✓）；本文件钉的是**两侧同形＋同一套边界**，
// 这是本仓既有的做法（另有 `historyPanelInspect.test.ts` 读 `versions.rs` 源码、`libraryMap.test.ts` 同类 ✓）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const RUST = readFileSync(join(ROOT, "src-tauri", "src", "sync.rs"), "utf8");
const WEB = readFileSync(join(ROOT, "src", "lib", "platform", "web.ts"), "utf8");

/** 取 `record_change` 那段（Rust 到下一个 `pub fn`；Web 到函数尾的 `}` 之前留够窗口 ✓）。 */
const rustFn = (() => {
  const i = RUST.indexOf("pub fn record_change(");
  expect(i, "找不到 Rust 的 record_change").toBeGreaterThan(-1);
  const j = RUST.indexOf("\npub fn ", i + 10);
  return RUST.slice(i, j < 0 ? i + 4000 : j);
})();
const webFn = (() => {
  const i = WEB.indexOf("function recordChange(");
  expect(i, "找不到 Web 的 recordChange").toBeGreaterThan(-1);
  return WEB.slice(i, i + 2600);
})();

describe("R139 · 同步日志的合并：桌面与 Web 两侧同形", () => {
  it("两边都**只并 upsert**（delete 是墓碑，不许并）", () => {
    expect(rustFn, "Rust 侧没把合并限定在 upsert").toMatch(/op\s*==\s*"upsert"/);
    expect(webFn, "Web 侧没把合并限定在 upsert").toMatch(/op\s*===\s*"upsert"/);
  });

  it("两边都**只删自己设备写的**（中继/别人的行不许动）", () => {
    expect(rustFn, "Rust 侧缺 device_id 过滤").toMatch(/device_id\s*=\s*\?3/);
    expect(webFn, "Web 侧缺 device_id 过滤").toMatch(/device_id\s*=\s*\?/);
  });

  it("两边都**只删还没推出去的**（游标来自 sync_profiles.last_pushed_seq）", () => {
    for (const [who, src] of [["Rust", rustFn], ["Web", webFn]]) {
      expect(src, `${who} 侧没读 last_pushed_seq（那就无从判断"还没推出去"）`).toContain("last_pushed_seq");
      expect(src, `${who} 侧没拿工作空间 id 去取档案（档案是按 ws_id 存的）`).toMatch(/workspaces/);
    }
  });

  it("两边都是**删旧行 ＋ 插新行**，不是就地改 payload（新的 seq/id ⇒ 对端游标语义不变）", () => {
    for (const [who, src, del] of [
      ["Rust", rustFn, /DELETE FROM changes/],
      ["Web", webFn, /DELETE FROM changes/],
    ] as const) {
      expect(src, `${who} 侧没有 DELETE（就没法"删旧行"）`).toMatch(del);
      // 就地改的话会出现 `UPDATE changes SET payload` —— 那会把对端游标语义改坏 ✗
      expect(src, `${who} 侧不许就地改 payload（对端会永远看不到这次更新 ✗）`).not.toMatch(/UPDATE changes SET payload/);
    }
    expect(rustFn, "Rust 侧仍要插新行").toMatch(/INSERT INTO changes/);
    expect(webFn, "Web 侧仍要插新行").toMatch(/INSERT INTO changes/);
  });

  it("两侧注释都点名了同一条来由（R139 实测：91% / 98.7%），免得后人以为这是可选优化", () => {
    for (const [who, src] of [["Rust", rustFn], ["Web", webFn]]) {
      expect(src, `${who} 侧没写清"为什么"（这是数据体积的承重改动 ✗）`).toMatch(/R139|整篇快照|全量快照/);
    }
  });
});
