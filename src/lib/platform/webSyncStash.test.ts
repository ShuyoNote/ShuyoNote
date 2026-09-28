// 判据：`doPull` **不许静默跳过**应用失败的变更（2026-09-23，macOS）。
//
// 背景（取证 L 的同族）：页级「保留本地」那条已经有 B 方案（存进「待取回的远端版本」），
// 而 `doPull` 的 catch 当时还是 `catch { /* skip bad change */ }` —— **抛错 ⇒ 没应用，游标照样推进，
// 层里一条痕都没有**。Rust 侧那时是 `?`（中断本轮、不推进），两侧语义**不一致**。
//
// 这里钉两件事：
//   ① 纯函数 `pageRowOfChangeForStash`：**什么能归档、什么不能**（坏 payload / 非 page / delete / 无 id）；
//   ② 源码级：`doPull` 的 catch 分支必须**要么归档、要么留 warn**（不许再出现空的 catch）。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { pageRowOfChangeForStash } from "./web";

const change = (over: Record<string, unknown> = {}) =>
  ({ seq: 7, entity: "page", op: "upsert", entity_id: "p1", payload: JSON.stringify({ id: "p1", title: "甲" , content_json: "{}" }), ...over }) as never;

describe("pageRowOfChangeForStash：谁能被归档进「待取回的远端版本」", () => {
  it("page/upsert ＋ 合法 payload（有 id）⇒ 归档", () => {
    const row = pageRowOfChangeForStash(change());
    expect(row?.id).toBe("p1");
  });

  it("★ 坏 payload（不是 JSON）⇒ `null`（不许把「归档失败」当成「归档了」）", () => {
    expect(pageRowOfChangeForStash(change({ payload: "{not json" }))).toBeNull();
  });

  it("★ 非 page 实体 / delete / 没有 id ⇒ `null`", () => {
    expect(pageRowOfChangeForStash(change({ entity: "attachment" }))).toBeNull();
    expect(pageRowOfChangeForStash(change({ op: "delete" }))).toBeNull();
    expect(pageRowOfChangeForStash(change({ payload: JSON.stringify({ title: "没有 id" }) }))).toBeNull();
    expect(pageRowOfChangeForStash(change({ payload: null }))).toBeNull();
  });
});

describe("★ 源码级：doPull 的 catch 不许是空的（静默跳过就是取证 L 的同族）", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/platform/web.ts"), "utf8");
  // ⚠️ 窗口上限是**够用即可**的近似（不是精确解析）：丙-⑤ 往这一支里加了"同一份文档 ⇒ 不记"
  //    那一段之后，900 不够了（当场红，报的是"找不到 catch 分支"）—— 改实现时同步放这里，
  //    但别把它当成"随便多长都行"：它钉的是**这一支说了什么**，不是整段代码。
  const catchBody = () => {
    const m = src.match(/for \(const c of changes\)[\s\S]{0,1500}?catch \(e\) \{([\s\S]{0,2000}?)\n    \}/);
    expect(m, "找不到 doPull 里那个 catch 分支（实现变了就更新这条判据）").toBeTruthy();
    return m![1];
  };

  it("catch 分支里必须出现归档或 warn（二者之一）", () => {
    const body = catchBody();
    expect(body).toMatch(/stashPendingRemote\(|console\.warn\(/);
    expect(body).not.toMatch(/^\s*\/\* skip bad change \*\/\s*$/m);
  });

  // ★ 丙-⑤（2026-09-26）：**"已存进待取回"那句话必须以返回值为准** —— `stashPendingRemote`
  // 回 `false`（本机那一版与它是同一份文档）时一行都没写，此时再宣布一次就是在报假账。
  // 与 Rust 侧 `apply_pulled_changes` 那三支一一对应（那边同样是 `Ok(true)` 才 push id）。
  it("★ 只有 `stashPendingRemote` 回了 true 才敢说「已存进待取回」", () => {
    const body = catchBody();
    expect(body, "没判返回值 ⇒ 与本地同一份文档时也会报一句清单里根本没有的账").toMatch(
      /if \(stashPendingRemote\(/,
    );
    expect(body, "得说清「没记」那一路去哪了（不许只留一个 if 没有 else）").toMatch(/同一份文档/);
  });
});
