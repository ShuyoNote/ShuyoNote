// 冲刺「增量 payload」· **判据先行**（P1/T2，2026-09-30，windows 侧）
//
// 背景（口径来自 macOS 侧那份深度分析 `docs/plans/2026-09-29-payload-increment-deep-dive.md` ＋ 我自己的代码读数 ✓）：
//   今天**只存整份**：`contentJsonToYDoc()` 产出的是 `Y.encodeStateAsUpdate(doc)`（全量）✓；
//   `openPageSession().exportState` 也是全量 ✓；全仓 `stateVector`／`diffUpdate` **0 命中** ✗。
//   而 yjs 的**每次编辑本身就产出一条 update**（天然增量 ✓）⇒ 要做的是"**把那条 update 留下来**"，不是"算 diff" ✓。
//
// 这个文件**只证 yjs 本身的性质**（与 `mergeability.test.ts` 同一条诚实口径 ✓）：
//   ⚠️ **不证**我们那套 Lexical 绑定也能如此 —— 那要等"真把增量留下来"接线之后（届时判据升级为端到端 ✓）。
//   ⇒ 所以本文件的价值是：**先把"增量路线依赖的四条性质"钉住** ✓，接线后回归时它**必须继续绿** ✓（绿了才说明没破坏前提 ✓）。
//
// 四条判据（每条都写清"判据／为什么它承重" ✓）：
//   ① **等价性（核心）**：同血统上"基线 → 增量"的最终内容，与"直接吃全量状态"**逐字节相同** ✓
//      —— 承重理由：不等价就等于**静默丢内容** ✗，而这正是 CRDT 最不能出的错。
//   ② **幂等**：同一条 update 应用两次 ⇒ 内容不变 ✓（网络重发／重放是常态 ✓）
//      —— 承重理由：若幂等不成立，就得在协议层引入"必须按序／必须只一次"的假设，把 CRDT 的优势浪费掉 ✗。
//   ③ **可合并**：`Y.mergeUpdates([u1, u2])` 一次应用 == 依次应用 u1、u2 ✓
//      —— 承重理由：多条小 update 要能攒成一条，否则 update 日志只增不减 ✗。
//   ④ **体积**：一次小改动的增量**严格小于**全量 ✓（并**印出实测比值** ✓）
//      —— 承重理由：不更小就没有做的意义 ✓；⚠️ 比值是**读数**不是阈值 ⇒ 别把某个具体数写死 ✗。
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/** 造一份"基线"与"改过一处"的纯 yjs 文档（**刻意不用我们的 Lexical 绑定** ✓，见文件头 ✓） */
function buildDocs() {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "第一段：基线内容。");
  const base = Y.encodeStateAsUpdate(doc); // 基线全量
  const sv = Y.encodeStateVector(doc); // 对端已有的状态
  text.insert(text.length, " 第二段：后加的一句话。");
  const increment = Y.encodeStateAsUpdate(doc, sv); // ⭐ **这一次改动**的增量
  const full = Y.encodeStateAsUpdate(doc); // 改动后的全量（对照）
  return { doc, base, sv, increment, full, expected: text.toString() };
}

describe("增量 payload · yjs 层面的四条承重判据", () => {
  it("① 等价性：基线 ＋ 增量 ⇒ 与全量**逐字节一致**（内容也一致）", () => {
    const { base, increment, full, expected } = buildDocs();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, base); // 对端先有基线
    Y.applyUpdate(peer, increment); // 只收到增量
    expect(peer.getText("content").toString()).toBe(expected); // 内容等价
    // ⭐ 逐字节等价：把两条路径的**全量状态**都取出来比
    const stateViaIncrement = Y.encodeStateAsUpdate(peer);
    const viaFull = new Y.Doc();
    Y.applyUpdate(viaFull, full);
    expect(Array.from(stateViaIncrement)).toEqual(Array.from(Y.encodeStateAsUpdate(viaFull)));
  });

  it("② 幂等：同一条 update 应用两次 ⇒ 内容不变", () => {
    const { base, increment, expected } = buildDocs();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, base);
    Y.applyUpdate(peer, increment);
    const once = Y.encodeStateAsUpdate(peer);
    Y.applyUpdate(peer, increment); // 重放
    expect(peer.getText("content").toString()).toBe(expected);
    expect(Array.from(Y.encodeStateAsUpdate(peer))).toEqual(Array.from(once)); // 状态也不变
  });

  it("③ 可合并：mergeUpdates([u1, u2]) 一次应用 == 依次应用", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "甲");
    const base = Y.encodeStateAsUpdate(doc);
    let sv = Y.encodeStateVector(doc);
    doc.getText("content").insert(doc.getText("content").length, "乙");
    const u1 = Y.encodeStateAsUpdate(doc, sv);
    sv = Y.encodeStateVector(doc);
    doc.getText("content").insert(doc.getText("content").length, "丙");
    const u2 = Y.encodeStateAsUpdate(doc, sv);

    const seq = new Y.Doc();
    Y.applyUpdate(seq, base);
    Y.applyUpdate(seq, u1);
    Y.applyUpdate(seq, u2);

    const merged = new Y.Doc();
    Y.applyUpdate(merged, base);
    Y.applyUpdate(merged, Y.mergeUpdates([u1, u2])); // ⭐ 一次应用

    expect(merged.getText("content").toString()).toBe(seq.getText("content").toString());
    expect(merged.getText("content").toString()).toBe("甲乙丙");
    expect(Array.from(Y.encodeStateAsUpdate(merged))).toEqual(Array.from(Y.encodeStateAsUpdate(seq)));
  });

  it("④ 体积：一次小改动的增量**严格小于**全量（并印出实测比值 ✓）", () => {
    const { increment, full } = buildDocs();
    const ratio = increment.length / full.length;
    // ⚠️ 只断言"严格更小"——具体比值是**读数**，别写死阈值 ✗（判据先行时先定方向 ✓，接线后再按实测收紧 ✓）
    console.log(
      `  [读数] 增量 ${increment.length} B ／ 全量 ${full.length} B ⇒ 比值 ${ratio.toFixed(3)}（本条只断言"更小" ✓）`,
    );
    expect(increment.length).toBeLessThan(full.length);
  });
});
