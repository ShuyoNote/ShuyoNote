// 冲刺后续 **#3 · 状态体积读数**（喂 S5 阶段 2 的"值不值得做"）。
//
// 为什么要有它：yrs 对拍只证了"**能不能**合并"（格式层可行），没给"**状态有多重**"。而 S5 阶段 2
// 要把状态搬上服务端（每页一份、随编辑增长）⇒ 体积是那个决策的必要输入之一。这条不是性能判据
// （不做时限断言），而是**读数**：把"块数 → 状态字节"画出来，并钉住两条**可判**的性质：
//   ① 体积随块数**单调增**（不是常数、也不是乱跳）；
//   ② 单块的平均增量在一个**量级**内（< 4KB/块）——超了说明实现里混进了不该有的东西（该调查）。
//
// ⚠️ 数字**与机器无关**（这是编码后的字节数，不是时间）⇒ 这条读数可以稳定复现，不会像计时判据那样假红。
import { describe, expect, it } from "vitest";
import { $createTextNode, $getRoot, createEditor } from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc } from "../blockIdentity";
import { openPageSession } from "./yDocBridge";

function pageJson(blocks: number): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "state-size-reading" });
  editor.update(
    () => {
      $getRoot().clear();
      for (let i = 0; i < blocks; i += 1) {
        const p = $createBlockParagraphNode(`blk-${i}`);
        p.append($createTextNode(`第 ${i} 段：一段用来占体积的中文正文，长度大致与真实笔记相当。`));
        $getRoot().append(p);
      }
    },
    { discrete: true },
  );
  const d = JSON.parse(toLegacyDoc(JSON.stringify(editor.getEditorState().toJSON()))) as {
    root: { children: Array<Record<string, unknown>> };
  };
  return JSON.stringify(d);
}

describe("#3 状态体积读数（块数 → CRDT 状态字节）", () => {
  it("① 单调增 ＋ 每块平均增量在量级内：把「块数 → 字节」这张表打印出来", () => {
    const rows: Array<{ blocks: number; jsonBytes: number; stateBytes: number; perBlock: number }> = [];
    for (const blocks of [1, 10, 50, 200]) {
      const json = pageJson(blocks);
      const s = openPageSession({ json });
      const state = s.exportState();
      s.dispose();
      rows.push({
        blocks,
        jsonBytes: json.length,
        stateBytes: state.length,
        perBlock: Math.round((state.length / blocks) * 10) / 10,
      });
    }
    console.log("【实测】块数 → 状态字节（JSON 是落盘那两列的对照）");
    for (const r of rows) {
      console.log(`  ${String(r.blocks).padStart(4)} 块：状态 ${String(r.stateBytes).padStart(7)} B ／ JSON ${String(r.jsonBytes).padStart(7)} B ／ 平均 ${r.perBlock} B/块`);
    }

    // ① 单调增（严格：多一块一定更大 —— 每块是独立结构，不是共享一份）
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].stateBytes).toBeGreaterThan(rows[i - 1].stateBytes);
    }
    // ② 量级：平均每块 < 4KB（正文里那段中文约 100 字节 ⇒ 超出这个量级说明编码里混了别的东西）
    for (const r of rows) {
      expect(r.perBlock, `${r.blocks} 块时平均 ${r.perBlock} B/块 —— 超出量级，该调查`).toBeLessThan(4096);
    }
    // ③ 与落盘 JSON 同量级（不是数量级差距：状态不是"多存一份全文"）
    expect(rows[rows.length - 1].stateBytes).toBeLessThan(rows[rows.length - 1].jsonBytes * 3);
  });

  it("② 增量式编辑：一次追加一块，状态只按「那一块」增长（不是每次重写全量）", () => {
    const s = openPageSession({ json: pageJson(50) });
    const before = s.exportState().length;
    s.edit(() => {
      const p = $createBlockParagraphNode("blk-new");
      p.append($createTextNode("新加的一段"));
      $getRoot().append(p);
    });
    const after = s.exportState().length;
    s.dispose();
    console.log(`【实测】50 块时追加一块：${before} B → ${after} B（+${after - before} B）`);
    expect(after).toBeGreaterThan(before);
    // 增量应当**远小于**整份状态（否则"每次编辑都要重传全量"这句担心就是真的）
    expect(after - before).toBeLessThan(Math.max(2048, Math.round(before * 0.2)));
  });
});
