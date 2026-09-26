// 冲突横幅（`SyncPanel` 的 P0.1 那一条）**分两类说** —— 丙-⑤ 的第一刀。
//
// 背景（为什么要分）：横幅原来只有一类，"保留本地 / 采用服务端"两颗按钮对**所有**冲突页都给。
// 但在戳判序下，冲突页其实有两种，能做的事**不一样**：
//   · **有「待取回的远端版本」**（页级保留了本地）⇒ 两颗按钮真的动数据；
//   · **戳判"用远端"已生效**（对端戳更晚）⇒ 本机那一版在覆盖前已被 `sync.rs` 存进**版本历史**
//     ⇒ 没有"待取回"的对象可裁决；对它调 `resolvePendingRemote` 只会报错 ——
//     而那正是"按钮看着能点、其实什么都没发生"的老毛病。
// 所以：第一类摆按钮，第二类**说清去哪找回**（工具栏「版本历史」）。
//
// ⚠️ 断言一律对着**去过注释**的源码（注释里到处在解释旧形状）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const panel = stripComments(readFileSync(join(process.cwd(), "src/components/SyncPanel.tsx"), "utf8"));

describe("冲突横幅：分两类", () => {
  it("① 分类依据是「这页有没有待取回的远端版本」（不是按标题/按 index 猜）", () => {
    expect(panel, "缺少「有得裁决」那一类").toContain(
      "const conflictsWithStash = conflicts.filter((c) => pending.some((p) => p.page_id === c.entity_id))",
    );
    expect(panel, "缺少「已按判序采用远端」那一类").toContain(
      "const conflictsTakenRemote = conflicts.filter((c) => !pending.some(",
    );
  });

  it("② 两颗按钮**只对第一类**渲染（拿第二类的 id 去裁决 = 报错的假按钮）", () => {
    expect(panel).toContain('resolveAll(conflictsWithStash.map((c) => c.entity_id), "keep_local")');
    expect(panel).toContain('resolveAll(conflictsWithStash.map((c) => c.entity_id), "take_remote")');
    expect(panel, "第二种排列组合不该存在（拿「已采用远端」那批去裁决）").not.toContain(
      "resolveAll(conflictsTakenRemote",
    );
    // 两类的渲染顺序：先"有得裁决"，后"已采用远端"
    const withStash = panel.indexOf("conflictsWithStash.length > 0 &&");
    const takenRemote = panel.indexOf("conflictsTakenRemote.length > 0 &&");
    expect(withStash).toBeGreaterThan(-1);
    expect(takenRemote).toBeGreaterThan(withStash);
  });

  it("③ 批量裁决只作用在**调用方给的那批 id** 上（旧形状是拿全部 conflicts 去试）", () => {
    expect(panel, "`resolveAll` 又变回「自己从 conflicts 里取全部 id」了").toContain(
      "const resolveAll = async (ids: string[], choice:",
    );
    expect(panel).not.toContain('resolveAll("keep_local")');
    expect(panel).not.toContain('resolveAll("take_remote")');
  });

  it("④ 第二类必须**说清去哪找回** —— 本机那一版在版本历史里，不是「没了」", () => {
    expect(panel).toContain("已经按判序采用了远端");
    expect(panel).toContain("已存进版本历史");
    expect(panel, "要给出可操作的去处：编辑器工具栏的「版本历史」").toContain("版本历史");
  });
});
