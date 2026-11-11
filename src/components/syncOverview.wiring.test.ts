// 判据：同步面板「状态总览」四格（owner 2026-11-11 选 A，对齐效果图 01）。
//
// 四条口径（都是**来源可点名**的，⛔ 不许写死数字/凭空造参数）：
// ① 四格都在：上次成功 / 下次自动 / 当前状态 / 失败数（四个 data-testid 齐全）；
// ② 上次成功 ← history 里最近一条 ok（⛔ 没有就写「—」，不编）；
// ③ 下次自动 ← 最近一轮 + 后台节拍 120s（标「约」，与 lan_state 的 BACKGROUND_ROUND_MS 同值）；
// ④ 记录块默认展开（要能看见，而不是永远收着）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "SyncPanel.tsx");
const src = readFileSync(SRC, "utf8");

describe("同步状态总览（效果图 01 的四格）", () => {
  it("① 四格都在：上次成功 / 下次自动 / 当前状态 / 失败", () => {
    for (const id of [
      "sync-overview-last-ok",
      "sync-overview-next",
      "sync-overview-syncing",
      "sync-overview-failed",
    ]) {
      expect(src, `缺 ${id}`).toContain(`data-testid="${id}"`);
    }
    expect(src).toContain('className="sync-overview"');
  });

  it("② 上次成功只从 history 的 ok 行取；没有就写「—」（不编数字）", () => {
    expect(src).toContain("history.find((h) => h.ok)");
    expect(src).toContain('overviewLastOkAt ? relTime(overviewLastOkAt) : "—"');
  });

  it("③ 下次自动 = 最近一轮 + 120_000ms（与 BACKGROUND_ROUND_MS 同值，标「约」）", () => {
    expect(src).toContain("overviewLastRoundAt + 120_000");
    expect(src).toContain("约 ${leftSec} 秒后");
  });

  it("④ 记录块默认展开（记录要能被看见）", () => {
    expect(src).toContain("const [historyOpen, setHistoryOpen] = useState(true)");
  });
});
