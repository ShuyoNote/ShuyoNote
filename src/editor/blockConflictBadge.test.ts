// 阶段 1 · **冲突块角标**的判据（happy-dom）：只验"按 id 打/摘类名"这一段。
//
// 编辑器那一侧（`Editor.tsx` 的 effect）只是"调它 + 每次 update 后再调一次"；真正的判据是这里：
//   · 有冲突的块加类名、其余块**摘掉**（不是只加不摘 —— 那会让角标永远留着）；
//   · 传空表 = 全清（裁决完 / 离开这一页）；
//   · **只认已打过 `data-block-id` 标记的块**（没标记的这次漏掉，下一次 update 会补）；
//   · ★ **负判据**（macOS 2026-09-22 点名要的）：DOM 被重建之后，下一次 update **必须把类名打回来**
//     —— 见文件末尾那条（它测的是 `installConflictBadges`，也就是 Editor 里那段形状本身）。

import { beforeEach, describe, expect, it } from "vitest";

import { applyConflictBadges, installConflictBadges } from "./blockConflictBadge";

function tag(root: HTMLElement, id: string): HTMLElement {
  const el = document.createElement("p");
  el.setAttribute("data-block-id", id);
  root.appendChild(el);
  return el;
}

describe("applyConflictBadges", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("给列表里的块加类名；**不在列表里的摘掉**", () => {
    const a = tag(root, "b1");
    const b = tag(root, "b2");
    a.classList.add("block-conflict"); // 上一次留下的角标

    applyConflictBadges(["b2"], root);

    expect(a.classList.contains("block-conflict")).toBe(false);
    expect(b.classList.contains("block-conflict")).toBe(true);
  });

  it("空表 ⇒ 全清（裁决完 / 离开这一页）", () => {
    const a = tag(root, "b1");
    applyConflictBadges(["b1"], root);
    expect(a.classList.contains("block-conflict")).toBe(true);

    applyConflictBadges([], root);
    expect(a.classList.contains("block-conflict")).toBe(false);
  });

  it("没打过标记的块匹配不到（说明这一条的边界：角标依赖 `data-block-id`）", () => {
    const untagged = document.createElement("p");
    root.appendChild(untagged);

    applyConflictBadges(["b1"], root);

    expect(untagged.classList.contains("block-conflict")).toBe(false);
  });
});

// ★ **负判据**（macOS 2026-09-22 点名要的那条）：Lexical 结构一变会**重建 DOM** ⇒ 类名跟着没。
// 所以"打一次就完事"是错的 —— 必须每次 update 之后重打。这里用一个假编辑器把"重建 → 再打"跑出来：
//   · 头一次调用（挂载时）打到当时的元素上；
//   · 模拟 DOM 重建（元素被换成**没有类名**的新节点）；
//   · 触发一次 editor update ⇒ 类名必须回来；
//   · 解绑之后再触发 ⇒ **不许**再动 DOM（否则就是"卸载了还在改别人"）。
describe("installConflictBadges（DOM 重建之后必须重打）", () => {
  let root: HTMLElement;
  let listeners: Array<() => void>;

  /** 假编辑器：只实现"注册 update 监听 + 返回解绑"。 */
  function fakeEditor() {
    listeners = [];
    return {
      registerUpdateListener(fn: () => void) {
        listeners.push(fn);
        return () => {
          listeners = listeners.filter((l) => l !== fn);
        };
      },
    };
  }

  /** 每次"update"都重打一遍（与 `Editor.tsx` 里那段一样：先补标记、再打角标）。 */
  const apply = () => applyConflictBadges(["b1"], root);

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  it("DOM 重建后类名会没 ⇒ 下一次 update 必须把它打回来；解绑后编辑器不再回调它", () => {
    const editor = fakeEditor();
    const first = tag(root, "b1");
    const dispose = installConflictBadges(editor, apply);

    // 挂载时**立刻先打一次**（不等第一次 update）
    expect(first.classList.contains("block-conflict")).toBe(true);
    expect(listeners.length).toBe(1);

    // 结构变化 ⇒ Lexical 重建 DOM：旧节点被换掉，新节点**不带**任何类名
    root.innerHTML = "";
    const rebuilt = tag(root, "b1");
    expect(rebuilt.classList.contains("block-conflict")).toBe(false);

    // 一次 editor update（重建之后必然会有一次）⇒ 角标回来
    for (const l of [...listeners]) l();
    expect(rebuilt.classList.contains("block-conflict")).toBe(true);

    // 解绑 ⇒ 登记被摘掉（卸载之后不该再有人改这份 DOM）
    dispose();
    expect(listeners.length).toBe(0);
  });
});
