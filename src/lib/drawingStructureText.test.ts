// `excalidrawStructureText` 的判据 —— 对着方案 P3 工作单里那几条"建议判据"写。
//
// 这一格为什么值得判：scene text（已有的那半）只给出**标签文字**，看不出**谁指向谁**；
// 而结构一旦写成噪声（把随手画的矩形、被删的元素都灌进去），正文列会被污染，且**不会报错**。
import { describe, expect, it } from "vitest";

import { excalidrawStructureText, type ExcalidrawElementLike } from "./drawingStructureText";

/** 形状（带自己的文字） */
const shape = (id: string, text: string, x = 0, y = 0): ExcalidrawElementLike => ({
  id,
  type: "rectangle",
  x,
  y,
  text,
});
/** Excalidraw 的常态：形状没有 text，文字是**独立的 text 元素**（containerId 指回形状） */
const bareShape = (id: string, x = 0, y = 0, type = "rectangle"): ExcalidrawElementLike => ({ id, type, x, y });
const textIn = (id: string, containerId: string, text: string): ExcalidrawElementLike => ({
  id,
  type: "text",
  containerId,
  text,
});
const arrow = (id: string, from: string, to: string): ExcalidrawElementLike => ({
  id,
  type: "arrow",
  startBinding: { elementId: from },
  endBinding: { elementId: to },
});

describe("excalidrawStructureText：节点与连线", () => {
  it("箭头按**端点文字**表达成 `A → B`", () => {
    const r = excalidrawStructureText([
      shape("a", "审批", 0, 0),
      shape("b", "发布", 0, 100),
      arrow("e1", "a", "b"),
    ]);
    expect(r.text).toBe("审批 → 发布");
    expect(r.edgeCount).toBe(1);
  });

  it("★ Excalidraw 常态（形状无 text、文字是独立 text 元素）也要认出节点名", () => {
    const r = excalidrawStructureText([
      bareShape("a", 0, 0),
      textIn("t1", "a", "审批"),
      bareShape("b", 0, 100),
      textIn("t2", "b", "发布"),
      arrow("e1", "a", "b"),
    ]);
    expect(r.text).toBe("审批 → 发布");
  });

  it("端点没有文字 ⇒ 退成**类型名**（矩形/椭圆/菱形），不编造文字", () => {
    const r = excalidrawStructureText([bareShape("a", 0, 0), bareShape("b", 0, 50, "ellipse"), arrow("e1", "a", "b")]);
    expect(r.text).toBe("矩形 → 椭圆");
  });

  it("有文字但**没有任何连线**的形状单独成行（它也是内容）", () => {
    const r = excalidrawStructureText([shape("a", "独立说明", 0, 0), shape("b", "审批", 0, 50), shape("c", "发布", 0, 100)]);
    expect(r.text).toBe("独立说明\n审批\n发布");
    expect(r.nodeCount).toBe(3);
    expect(r.edgeCount).toBe(0);
  });

  it("★ 同一条连线两端文字相同时也只出一行（不许因为匹配集合而重复）", () => {
    const r = excalidrawStructureText([shape("a", "同名", 0, 0), shape("b", "同名", 0, 50), arrow("e1", "a", "b")]);
    expect(r.text).toBe("同名 → 同名");
  });
});

describe("excalidrawStructureText：纯装饰不许进正文", () => {
  it("★ 无文字、又没有任何连线绑定的元素 ⇒ **空串**（随手涂鸦/背景矩形不许灌进索引）", () => {
    const r = excalidrawStructureText([
      { id: "f1", type: "freedraw", x: 0, y: 0 },
      { id: "r1", type: "rectangle", x: 10, y: 10 },
      { id: "t9", type: "text", x: 0, y: 0, text: "   " }, // 只有空白
    ]);
    expect(r.text).toBe("");
    expect(r.nodeCount).toBe(0);
  });

  it("★ 没绑定两端的箭头（装饰线）不进正文", () => {
    const r = excalidrawStructureText([shape("a", "审批", 0, 0), { id: "e1", type: "arrow" }]);
    expect(r.text).toBe("审批"); // 只剩节点行
    expect(r.edgeCount).toBe(0);
  });

  it("★ 已删除的元素不出现（`isDeleted`）", () => {
    const r = excalidrawStructureText([shape("a", "留着的", 0, 0), { ...shape("b", "删掉的", 0, 50), isDeleted: true }]);
    expect(r.text).toBe("留着的");
  });

  it("空场景 / undefined ⇒ 空串（接线侧据此**不加**这一段）", () => {
    expect(excalidrawStructureText([]).text).toBe("");
    expect(excalidrawStructureText(undefined).text).toBe("");
  });
});

describe("excalidrawStructureText：确定性与输入顺序无关", () => {
  const scene = [
    shape("b", "发布", 0, 100),
    arrow("e1", "a", "b"),
    shape("a", "审批", 0, 0),
    arrow("e2", "b", "c"),
    shape("c", "归档", 0, 200),
  ];

  it("★ 打乱输入顺序 ⇒ **逐字相同**（按 y → x → id 定序；否则同一次布局会排出两种正文）", () => {
    const a = excalidrawStructureText(scene).text;
    const b = excalidrawStructureText([...scene].reverse()).text;
    const c = excalidrawStructureText([scene[2]!, scene[0]!, scene[4]!, scene[3]!, scene[1]!]).text;
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a).toBe("审批 → 发布\n发布 → 归档");
  });

  it("同一份输入跑两次逐字相同；且不改动入参", () => {
    const snapshot = JSON.stringify(scene);
    expect(excalidrawStructureText(scene).text).toBe(excalidrawStructureText(scene).text);
    expect(JSON.stringify(scene)).toBe(snapshot);
  });
});
