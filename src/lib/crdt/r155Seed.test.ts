import { describe, expect, it } from "vitest";
import { contentJsonToYDoc, yDocToContentJson } from "./yDocBridge";

// ⭐ **R155 判据（第一半，今天就必须绿 ✓）**：外部写落库后，要用**这份工具**把新正文播种成
//   一份 CRDT 状态并落盘 ✓ —— 所以先钉住"这份工具真的能承载那段文字" ✓。
//
// 现场（owner 2026-10-08，读数 ✓）：外部写（MCP 免确认那条路）落库后
//   · 正文 **77 字、含探针** ✓
//   · 该页 `page_crdt` 那份 **440 字节**的状态里**搜不到那段文字** ✗（逐字 `状态里含探针文字 = False` ✓）
//   ⇒ 重启时按状态重建/合并 ⇒ **旧内容赢** ✗（`changes` 里记成一次普通 upsert，发生在启动后约 12 秒 ✓）
//   ⇒ ⇒ 免确认档的写入**不能算落定** ✗（重启一次可能就没了 ✓）。
//
// ⚠️ 第二半（接线：`applyDraftAndRefresh` 落库后真的去 `api.savePageState` ✓）**按约定暂缓** ✗ ——
//    那个动作会改"那一页已有的 CRDT 状态" ⇒ 碰血统/合并那条线 ⇒ 已发信给 windows 商量（a/b/c ✓，
//    沉默 24h 默认 a ✓）。本文件只钉**工具那一半** ✓，实现一到就能直接接上 ✓。
describe("R155：把正文播种成 CRDT 状态这条工具链", () => {
  const json = JSON.stringify({
    root: {
      type: "root",
      version: 1,
      direction: "ltr",
      format: "",
      indent: 0,
      children: [
        {
          blockId: "b1",
          type: "paragraph",
          version: 1,
          direction: "ltr",
          format: "",
          indent: 0,
          style: "",
          children: [
            { type: "text", text: "R155 状态探针 XYZ", format: "", style: "", mode: "normal", detail: 0, version: 1 },
          ],
        },
      ],
    },
  });

  it("★ 从正文播种出的状态，回环重建后**仍含那段文字** ✓（否则修法就是空中楼阁 ✗）", () => {
    const { update } = contentJsonToYDoc(json);
    expect(update.length, "状态字节不能是空的 ✗").toBeGreaterThan(0);
    const back = yDocToContentJson(update);
    expect(back, "回环后必须还原出那段文字 ✓").toContain("R155 状态探针 XYZ");
  });

  it("★ 状态字节里**能直接搜到**那段文字 ✓（这就是现场那条读数的反面 ✓）", () => {
    const { update } = contentJsonToYDoc(json);
    const hay = new TextDecoder().decode(update);
    expect(hay, "状态字节里应当能搜到 ✓ —— 现场 `page_crdt` 里搜不到 ✗ 就是这个缺陷的形状 ✓").toContain(
      "R155 状态探针 XYZ",
    );
  });

  it("空文档也要给得出合法的状态（⛔ 不能抛 ✗）", () => {
    const empty = JSON.stringify({ root: { type: "root", version: 1, direction: "ltr", format: "", indent: 0, children: [] } });
    const { update } = contentJsonToYDoc(empty);
    expect(update.length).toBeGreaterThan(0);
    expect(() => yDocToContentJson(update)).not.toThrow();
  });
});

// ⭐ **R155 判据（接线那一半 ✓）**：落库后要用的那个入口，必须给出**含那段文字**的状态 ✓
//   （它是 `contentJsonToYDoc` 的**落地形态** ✓，放在豁免层里 ✓ ⇒ 调用方不必点字段名 ✓）。
import { stateForExternalWrite } from "./yDocBridge";

describe("R155：落库后播种状态用的那个入口", () => {
  // ⚠️ 这一块**自带**一份正文（上面那块里的 `json` 出了作用域就没了 ✗ —— 我第一版就是那么写的 ✓）。
  const json2 = JSON.stringify({
    root: {
      type: "root", version: 1, direction: "ltr", format: "", indent: 0,
      children: [
        {
          blockId: "b1", type: "paragraph", version: 1, direction: "ltr", format: "", indent: 0, style: "",
          children: [{ type: "text", text: "R155 状态探针 XYZ", format: "", style: "", mode: "normal", detail: 0, version: 1 }],
        },
      ],
    },
  });

  it("★ 传整个 page 对象 ⇒ 状态里**含那段文字** ✓（现场那条读数的反面 ✓）", () => {
    const state = stateForExternalWrite({ id: "p1", content_json: json2 });
    expect(state.length, "状态字节不能为空 ✗").toBeGreaterThan(0);
    expect(new TextDecoder().decode(state), "状态里必须能搜到那段文字 ✓").toContain("R155 状态探针 XYZ");
  });

  // ⚠️ 口径（我先写反过一次 ✓）：缺正文/解析不了时**必须抛** ✓ ——
  //   若"宽容"地返回一份**空文档**的状态 ✗，那等于**把这一页的状态清成空** ✗✗ ⇒ 比重启丢内容更坏 ✓
  //   （正确答案是：不碰状态 ✓，让调用方留痕 ✓ —— `applyDraftAndRefresh` 里就是这么接的 ✓）。
  it("★ 缺正文**必须抛** ✓（⛔ 不许拿一份空文档去覆盖状态 ✗）", () => {
    let thrown: unknown = null;
    try {
      stateForExternalWrite({ id: "p2" });
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown), "解析不了就必须抛给调用方 ✓（静默清状态是最坏的选项 ✗）").toContain("contentJsonToYDoc");
  });

  it("★ 合法但空的文档 ⇒ 给得出状态 ✓（这条才是「空」的正确处置 ✓）", () => {
    const empty = JSON.stringify({ root: { type: "root", version: 1, direction: "ltr", format: "", indent: 0, children: [] } });
    const st = stateForExternalWrite({ id: "p3", content_json: empty });
    expect(st.length).toBeGreaterThan(0);
  });
});
