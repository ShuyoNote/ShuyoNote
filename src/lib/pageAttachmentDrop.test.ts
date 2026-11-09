// 判据：拖拽落点（2026-11-09，owner 选 A+）。
//   ① 正文区命中 ⇒ editor；附件区命中 ⇒ attachments；都命不中 ⇒ 默认正文；
//   ② Tauri 坐标是**物理像素** ⇒ 必须除以 dpr 才喂 elementFromPoint；
//   ③ 两个区提示文案必须不同（用户要知道“插不插正文”）。
import { describe, expect, it } from "vitest";
import { dropHintText, resolveDropZone, toCssPoint } from "./pageAttachmentDrop";

/** 造一个最小“元素链”：带 data-drop-zone 的祖先 + 子节点。 */
function fakeEl(zone: string | null, parent: Element | null = null): Element {
  const el = {
    getAttribute: (name: string) => (name === "data-drop-zone" ? zone : null),
    parentElement: parent,
  };
  return el as unknown as Element;
}

describe("resolveDropZone：鼠标下面是哪个落点区", () => {
  it("命中正文区（含子孙元素）⇒ editor", () => {
    const stage = fakeEl("page-editor");
    const inner = fakeEl(null, stage);
    expect(resolveDropZone(inner)).toBe("editor");
  });

  it("命中附件区 ⇒ attachments", () => {
    const panel = fakeEl("attachments");
    const inner = fakeEl(null, panel);
    expect(resolveDropZone(inner)).toBe("attachments");
  });

  it("都没命中（侧栏/空白）⇒ 默认正文", () => {
    expect(resolveDropZone(fakeEl(null))).toBe("editor");
  });

  it("传 null（elementFromPoint 到窗口外）⇒ 默认正文，不炸", () => {
    expect(resolveDropZone(null)).toBe("editor");
  });

  it("可以显式指定兜底区（附件面板自己的兜底用得到）", () => {
    expect(resolveDropZone(null, "attachments")).toBe("attachments");
  });
});

describe("toCssPoint：物理像素 → CSS 像素", () => {
  it("dpr=1 原样", () => {
    expect(toCssPoint({ x: 100, y: 50 }, 1)).toEqual({ x: 100, y: 50 });
  });

  it("dpr=2 减半（150% 屏/高 DPI 屏都是这一档）", () => {
    expect(toCssPoint({ x: 300, y: 200 }, 2)).toEqual({ x: 150, y: 100 });
  });

  it("dpr 非法（0 / NaN）⇒ 按 1 处理，不产出 Infinity", () => {
    expect(toCssPoint({ x: 10, y: 10 }, 0)).toEqual({ x: 10, y: 10 });
    expect(toCssPoint({ x: 10, y: 10 }, Number.NaN)).toEqual({ x: 10, y: 10 });
  });

  it("没有坐标（leave 事件）⇒ null", () => {
    expect(toCssPoint(undefined, 2)).toBeNull();
    expect(toCssPoint(null, 2)).toBeNull();
  });
});

describe("dropHintText：两个区必须说清“插不插正文”", () => {
  it("正文区说“并在正文插入附件卡片”", () => {
    expect(dropHintText("editor")).toContain("正文插入");
  });

  it("附件区说“正文不动”", () => {
    expect(dropHintText("attachments")).toContain("正文不动");
  });

  it("两个区文案不相同（防止复制粘贴后用户被误导）", () => {
    expect(dropHintText("editor")).not.toBe(dropHintText("attachments"));
  });
});

