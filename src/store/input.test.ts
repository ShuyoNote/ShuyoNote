// ★ A1（owner 2026-09-25 拍板）：**建空间时当场问"个人 / 团队"** 的两个判据面。
//
// ① 机制面（本文件上半）：`chooseDialog` 是"一问一答"的 promise ——
//    **选了要兑现、取消也要兑现**（取消不兑现 ⇒ 调用方永远挂着，用户看到"点了没反应"）。
// ② 接线面（下半）：`PageTree` 的"新建空间"真的把**用户选的那一类**传下去，
//    而且**只有桌面端**才问（Web 没有钥匙柜，那里的"个人/团队"没有下游）。
//
// ⚠️ 为什么值得钉"传了 kind"：分类是**同步闸门唯一的输入**。漏传的表现不是报错，
//    而是新空间落成默认值/未分类 ⇒ 个人空间没加密也能绑同步（内容明文上云）——
//    能编译、其它单测全绿，只有真机看得出来。
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { chooseDialog, useInputStore } from "./input";

describe("chooseDialog（单选一问一答）", () => {
  beforeEach(() => {
    useInputStore.setState({ options: null, chooser: null, chooseResolver: null });
  });

  it("① ★ 点哪一项 ⇒ 回哪个 value，并把槽位清空", async () => {
    const p = chooseDialog({
      title: "哪一类空间？",
      choices: [
        { value: "personal", label: "个人空间" },
        { value: "team", label: "团队空间" },
      ],
    });
    // 槽位真的开了（组件据此渲染那一排按钮）
    expect(useInputStore.getState().chooser?.choices).toHaveLength(2);

    useInputStore.getState().closeChoice("team");

    await expect(p).resolves.toBe("team");
    expect(useInputStore.getState().chooser).toBeNull();
  });

  it("② ★ **取消也要兑现**（回 null）—— 否则调用方永远挂着（「点了没反应」）", async () => {
    const p = chooseDialog({ choices: [{ value: "personal", label: "个人空间" }] });
    useInputStore.getState().closeChoice(null);
    await expect(p).resolves.toBeNull();
    expect(useInputStore.getState().chooser).toBeNull();
  });

  it("③ 兑现**只发生一次**（重复关闭不会把 promise 变成两次 resolve）", async () => {
    const p = chooseDialog({ choices: [{ value: "personal", label: "个人空间" }] });
    useInputStore.getState().closeChoice("personal");
    // 再关一次：resolver 已经清空 ⇒ 是空操作（不许 panic，也不许改结果）
    useInputStore.getState().closeChoice("team");
    await expect(p).resolves.toBe("personal");
  });
});

describe("PageTree 的接线（文本级：防止有人把这一问删掉或改成只问名字）", () => {
  const src = readFileSync("src/components/PageTree.tsx", "utf8");

  it("④ ★ 新建空间时**真的问**分类，并把用户选的传给 store（不是写死 personal）", () => {
    expect(src, "PageTree 里没有 chooseDialog ⇒ 分类那一问被删了").toContain("await chooseDialog(");
    expect(src, "store.create 没带上用户选的那一类 ⇒ 分类落成默认值").toContain(
      "useSpaceStore.getState().create(name, kind)",
    );
    // 「个人」是推荐项，但不许把它写成**唯一**项（团队空间必须也选得到）
    expect(src).toContain('value: "personal"');
    expect(src).toContain('value: "team"');
  });

  it("⑤ ★ 只有桌面端才问（Web 没有钥匙柜 ⇒ 那里的分类没有下游）", () => {
    expect(src).toMatch(/if \(isDesktopPlatform\(\)\) \{[\s\S]{0,400}?await chooseDialog\(/);
  });

  it("⑥ 取消要能走通：问名字那一步**不是**只挂 onSubmit（取消也必须兑现）", () => {
    // 只订阅 onSubmit 的写法在"点背景/取消"时永远挂着
    expect(src).toContain("useInputStore.subscribe(");
  });
});
