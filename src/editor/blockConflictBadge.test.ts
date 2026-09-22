// 阶段 1 · **冲突块角标**的判据（happy-dom）：只验"按 id 打/摘类名"这一段。
//
// 编辑器那一侧（`Editor.tsx` 的 effect）只是"调它 + 每次 update 后再调一次"；真正的判据是这里：
//   · 有冲突的块加类名、其余块**摘掉**（不是只加不摘 —— 那会让角标永远留着）；
//   · 传空表 = 全清（裁决完 / 离开这一页）；
//   · **只认已打过 `data-block-id` 标记的块**（没标记的这次漏掉，下一次 update 会补）。

import { beforeEach, describe, expect, it } from "vitest";

import { applyConflictBadges } from "./blockConflictBadge";

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
