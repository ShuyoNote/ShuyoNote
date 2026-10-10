// `TrustDevicePanel`（图①/②/④/⑥ 的**界面那一半** ✓）的判据 —— task-17 ✓
//
// ⚠️ 这一组判据守的是**四件口径**（owner 拍的 ✓），不是"长得对不对" ✗：
//   ① 图① **默认一个都不勾** ⇒ ⭐ **不产生任何改动**（⭐ 这一条的**红**必须是"旧行为：全选" ✗）
//   ② 图② 重合数字 ⭐ **只能来自注入的后端读数** ✗ —— ⛔ 界面自己数/自己编都不行 ✓
//   ③ 图② **反向**：读数取不到 ⇒ ⭐ **如实说「读不到」** ✗⛔ **绝不许显示 0 冒充「没有重合」** ✓
//   ④ 图④ 数字码是**标识**：⛔ 不许当秘密、⛔ **不许出现任何要用户输入的框** ✓
//      ＋ 严格模式 ⭐ **默认关** ✓ ／ 图⑥ ⭐ 列表里**只有一个「工作」** ✓
//
// ⚠️ 环境：`vitest.config.ts` 是 `happy-dom` ✓；本仓**没有** @testing-library ⇒
//    沿用既有写法（`createRoot` ＋ `flushSync`，见 `aiSettingsTabs.test.tsx` ✓）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import {
  TrustDevicePanel,
  type AttachableSpace,
  type LocalSpace,
  type Reading,
  type TrustDevicePanelProps,
} from "./TrustDevicePanel";

/**
 * ⚠️ 四个词**拆开拼**是**故意的** ✓：这样**测试文件自己**不含那几个词，
 * 于是"整份源码都不许出现"这条判据才扫得动 ✓（owner 口径：那两类词彻底离开用户面 ✓）。
 */
const BANNED: string[] = ["密" + "码", "口" + "令", "扫" + "码", "二维" + "码"];

const SRC = readFileSync(resolve(__dirname, "TrustDevicePanel.tsx"), "utf8");

const OFFER: AttachableSpace[] = [
  { id: "w1", name: "工作", kind: "personal" },
  { id: "r1", name: "读书笔记", kind: "personal" },
  { id: "t1", name: "数友产品组", kind: "team" },
];

const OK_OFFER: Reading<AttachableSpace[]> = { kind: "ok", value: OFFER };

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** ⚠️ 每次都先卸干净 —— 否则同一个用例里 render 两次会**留下两块面板** ⇒ 断言挑到旧那块（假绿 ✓）。 */
function teardown() {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(teardown);

function render(over: Partial<TrustDevicePanelProps> = {}) {
  teardown();
  const props: TrustDevicePanelProps = {
    attachOffer: OK_OFFER,
    localSpaces: { kind: "ok", value: [{ id: "w1", name: "工作" } as LocalSpace] },
    mergeOverlap: { kind: "ok", value: { mergedCount: 3, unmergedOverlapCount: 3 } },
    deviceCode: { kind: "ok", value: { code: "4821 7390 1562 8473 0291", verified: true } },
    ...over,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<TrustDevicePanel {...props} />));
  return host;
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const text = () => document.body.textContent ?? "";
const boxes = () => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const click = (el: Element | null) => {
  expect(el, "要点的元素不在 DOM 里").not.toBeNull();
  flushSync(() => (el as HTMLElement).click());
};

describe("TrustDevicePanel · 图① 接入（不勾就不会动）", () => {
  it("① ⭐ 默认一个都不勾，且不产生任何改动（旧行为「全选」在这里必红）", () => {
    const done = vi.fn();
    render({ onAttach: done });

    // 空间都在（⛔ 不是"没渲染所以没勾"那种假绿 ✓）
    expect(boxes().length, "三个空间应该都在列表里").toBe(3);
    // ⭐ 默认**一个都不勾**
    expect(boxes().every((b) => !b.checked), "默认必须一个都不勾").toBe(true);
    // ⭐ 明说"不勾就不会动"
    expect($('[data-testid="attach-note"]')?.textContent ?? "").toContain("不勾就不会动");
    // ⭐ 提交前能看出"这次会动几个" ⇒ 0
    expect($('[data-testid="would-change"]')?.textContent ?? "").toContain("0");
    // ⭐ 按钮关着；⭐ 而且就算点下去，回调也**不许**被调用（两层都挡 ✓）
    expect(($('[data-testid="attach"]') as HTMLButtonElement).disabled).toBe(true);
    click($('[data-testid="attach"]'));
    expect(done, "默认一个都不勾 ⇒ ⛔ 不许产生任何改动").not.toHaveBeenCalled();
  });

  it("② 勾了才动：能看出「这次会动几个」，且只回传勾选的那些", () => {
    const done = vi.fn();
    render({ onAttach: done });

    click($('[data-testid="offer-w1"] input'));
    click($('[data-testid="offer-t1"] input'));

    expect($('[data-testid="would-change"]')?.textContent ?? "").toContain("2");
    expect(($('[data-testid="attach"]') as HTMLButtonElement).disabled).toBe(false);
    click($('[data-testid="attach"]'));
    expect(done).toHaveBeenCalledTimes(1);
    // ⛔ 不许把**没勾**的那个也带上 ✗
    expect(done.mock.calls[0][0]).toEqual(["w1", "t1"]);
  });

  it("③ 读数取不到 ⇒ 如实说读不到，⛔ 不许装成「没有空间」", () => {
    render({ attachOffer: { kind: "unavailable", reason: "后端的空间表还没回来" } });
    expect($('[data-testid="offer-unavailable"]')?.textContent ?? "").toContain("读不到");
    // ⛔ 读不到时**不许**给出一颗「接入」按钮让用户点（点了也动不了 ✓）
    expect($('[data-testid="attach"]')).toBeNull();
    // ⛔ 也不许留着"由它自己挑选：0 个…"那一行（那又是把"没读到"说成"没有"✗）
    expect($('[data-testid="offer-auto-pick"]')).toBeNull();
  });

  it("④ ⭐ 「由它自己挑选」的 N／M **跟着注入读数变**（⛔ 不写死 2／1 ✗）", () => {
    const line = () => $('[data-testid="offer-auto-pick"]')?.textContent ?? "";

    // 注入 2 个人 ＋ 1 团队
    render();
    expect(line()).toContain("2 个个人空间");
    expect(line()).toContain("1 个团队空间");

    // 换一组形状 ⇒ 两个数都跟着换（写死的话这里必红 ✓）
    render({
      attachOffer: {
        kind: "ok",
        value: [
          { id: "a", name: "甲", kind: "personal" },
          { id: "b", name: "乙", kind: "team" },
          { id: "c", name: "丙", kind: "team" },
          { id: "d", name: "丁", kind: "" },
        ],
      },
    });
    expect(line()).toContain("1 个个人空间");
    expect(line()).toContain("2 个团队空间");
    // `''`（未分类）**如实算一类** ✓，⛔ 不并进"个人"里充数 ✗
    expect(line()).toContain("1 个未分类");
  });

  it("⑤ 三句文案是**给用户看的人话**（不是图上那三句残留 ✗）", () => {
    render();
    const t = text();
    expect(t).toContain("由它自己挑选：");
    expect(t).toContain("两台设备之间已重新建立信任");
    expect(t).toContain("由你决定，我不再询问");
    // ⛔ 那三句**不许**再出现在界面上（它们的落点已经换了 ✓）
    for (const bad of ["要它自己挑选的", "再聚首", "你选你不问我"]) {
      expect(t, `界面上不该再出现「${bad}」`).not.toContain(bad);
    }
  });
});

describe("TrustDevicePanel · 图② 重合结果（数字必须来自读数）", () => {
  it("① 数字跟着注入的读数变（⛔ 不是写死的、⛔ 不是界面自己数的）", () => {
    render({ mergeOverlap: { kind: "ok", value: { mergedCount: 3, unmergedOverlapCount: 3 } } });
    expect($('[data-testid="merged-count"]')?.textContent ?? "").toContain("3");
    expect($('[data-testid="unmerged-overlap"]')?.textContent ?? "").toContain("3");
    expect($('[data-testid="unmerged-overlap"]')?.textContent ?? "").toContain("重合");

    // 换一组读数 ⇒ 两个数都跟着换（写死的话这里必红 ✓）
    render({ mergeOverlap: { kind: "ok", value: { mergedCount: 11, unmergedOverlapCount: 0 } } });
    expect($('[data-testid="merged-count"]')?.textContent ?? "").toContain("11");
    expect($('[data-testid="unmerged-overlap"]'), "0 条时不该摆一条 ⚠️ 出来").toBeNull();
  });

  it("② ⭐⭐ 反向：读数取不到 ⇒ 如实说读不到 ⇒ ⛔ 绝不许显示 0", () => {
    render({ mergeOverlap: { kind: "unavailable", reason: "融合表还没有这一列" } });

    const t = $('[data-testid="overlap-unavailable"]')?.textContent ?? "";
    expect(t).toContain("读不到");
    // ⛔ 这一条是命门：把"没读到"说成"没有重合"＝**编** ✓
    expect(t).not.toContain("已融合 0 条");
    expect(t).not.toContain("未融合 0 条");
    expect($('[data-testid="merged-count"]'), "取不到时⛔ 不许有「已融合 N 条」那一格").toBeNull();
    expect(text()).not.toContain("已融合 0 条");
  });
});

describe("TrustDevicePanel · 图④ 数字码与严格模式", () => {
  it("① 显示已验证的数字码，且 ⛔ 一个要用户输入的框都没有", () => {
    render();
    expect($('[data-testid="device-code-value"]')?.textContent).toBe("4821 7390 1562 8473 0291");
    expect(text()).toContain("已验证");
    // ⭐ owner 口径：界面**不要求用户输入任何东西** ⇒ 那一格周围不许有输入框 ✓
    const block = $('[data-testid="device-code"]');
    expect(block).not.toBeNull();
    expect(block!.querySelectorAll("input, textarea").length, "数字码不是让人输入的 ⛔").toBe(0);
  });

  it("② ⛔ 没验过的码不许写成「已验证」（如实）", () => {
    render({
      deviceCode: { kind: "ok", value: { code: "0000 0000 0000 0000 0000", verified: false } },
    });
    expect(text()).toContain("还没验证过");
    expect(text()).not.toContain("已验证");
  });

  it("③ 严格模式默认关，且旁边说清「开了会怎样」", () => {
    const on = vi.fn();
    render({ onStrictModeChange: on });

    const sw = $('[data-testid="strict-toggle"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect($('[data-testid="strict-value"]')?.textContent ?? "").toContain("关");
    expect(text()).toContain("逐位对一遍"); // 开了会怎样 ✓

    click(sw);
    expect(on).toHaveBeenCalledWith(true);
    expect($('[data-testid="strict-toggle"]')!.getAttribute("aria-checked")).toBe("true");
  });

  it("④ 读数取不到 ⇒ 数字码那格如实说读不到（⛔ 不编一串出来）", () => {
    render({ deviceCode: { kind: "unavailable", reason: "两台还没对上" } });
    expect($('[data-testid="code-unavailable"]')?.textContent ?? "").toContain("读不到");
    expect($('[data-testid="device-code-value"]')).toBeNull();
  });
});

describe("TrustDevicePanel · 图⑥ 笔记本有哪些空间（同名只出现一行）", () => {
  it("① 「工作」只有一个：读数里 1 条 ⇒ 一行「工作 × 1」", () => {
    render({
      localSpaces: {
        kind: "ok",
        value: [{ id: "w1", name: "工作" }, { id: "r1", name: "读书笔记" }],
      },
    });
    const rows = [...document.querySelectorAll('[data-testid^="local-"]')];
    expect(rows.length, "两个不同的名字 ⇒ 两行").toBe(2);
    expect($('[data-testid="local-工作"]')?.textContent ?? "").toContain("工作 × 1");
    // ⛔ 不许出现第二行「工作」✗
    expect(rows.filter((r) => (r.textContent ?? "").includes("工作")).length).toBe(1);
  });

  it("② ⭐⭐ 读数里真出现重名 ⇒ 仍只一行，但必须如实告警（⛔ 不静默并掉、⛔ 也不摆两行）", () => {
    render({
      localSpaces: {
        kind: "ok",
        value: [{ id: "w1", name: "工作" }, { id: "w2", name: "工作" }],
      },
    });
    // 同名 ⇒ 仍然只有**一行**
    const rows = [...document.querySelectorAll('[data-testid^="local-"]')];
    expect(rows.filter((r) => (r.textContent ?? "").includes("工作")).length).toBe(1);
    expect($('[data-testid="local-工作"]')?.textContent ?? "").toContain("× 2");
    // ⭐ 但"没融合干净"这件事**必须说出来** ✓（⛔ 不替后端掩盖 ✗）
    expect($('[data-testid="duplicate-name-warning"]')?.textContent ?? "").toContain("融合还没生效");
  });

  it("③ 读数取不到 ⇒ 如实说读不到", () => {
    render({ localSpaces: { kind: "unavailable", reason: "库还没打开" } });
    expect($('[data-testid="local-unavailable"]')?.textContent ?? "").toContain("读不到");
    expect($('[data-testid="space-list"]')).toBeNull();
  });
});

describe("TrustDevicePanel · 文案红线（与 owner 口径同一把尺）", () => {
  it("① ⛔ 界面上一个字都不许出现（那四个词见文件头：拆开拼的 ✓）", () => {
    render();
    for (const w of BANNED) {
      expect(text(), `界面上不该出现那个词：${w}`).not.toContain(w);
    }
  });

  it("② ⛔ 源码里也不许出现（连注释都不留 ⇒ 下一个人不会顺手写回去）", () => {
    for (const w of BANNED) {
      expect(SRC, `TrustDevicePanel.tsx 里不该出现那个词：${w}`).not.toContain(w);
    }
  });

  it("③ ⛔ 不许出现「把对方那段…粘到这里」这类要用户搬东西的说法", () => {
    render();
    for (const bad of ["粘贴", "粘到这里", "手动输入", "请输入"]) {
      expect(text(), `界面上不该出现「${bad}」`).not.toContain(bad);
    }
  });
});
