// 冲刺切片 **S2b** 的判据：CRDT 状态**落盘**之后，重启仍然是**同一条血统**。
//
// 为什么这条是承重的：S2a 证了"载入既有血统能合" —— 但那是**同一个进程**里传字节。
// 真正的产品路径是"存库 → 关掉 → 重开 → 载入"。若库里那份回来时**字节变了**（比如被当成
// 文本/base64 存），血统就断了 ⇒ 退化成 S1 那条红线（一块变两块）。所以这里既验 BLOB 逐字节，
// 也验"**从库里的状态**开两个会话各改一处 ⇒ 合并后两处都在"。
import { describe, expect, it } from "vitest";
import {
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc } from "../blockIdentity";
import {
  clearPageCrdtState,
  readPageCrdtState,
  writeContent,
  writePageCrdtState,
  type ContentSql,
} from "../docContent";
import { openPageSession } from "./yDocBridge";

/** 极简内存库：只认本切片真正会发的四条 SQL（不认识的形状**当场抛**）。 */
function fakeDb() {
  const rows = new Map<string, { state: Uint8Array | string }>();
  const db = {
    run(sql: string, params: unknown[]) {
      if (/UPDATE pages SET title = \?/.test(sql)) return; // writeContent 的那条（本切片不关心它写了什么）
      if (/INSERT INTO page_crdt/.test(sql)) {
        rows.set(String(params[0]), { state: params[1] as Uint8Array });
        return;
      }
      if (/DELETE FROM page_crdt/.test(sql)) {
        rows.delete(String(params[0]));
        return;
      }
      throw new Error(`fakeDb 不认这条 run：${sql.slice(0, 48)}`);
    },
    query(sql: string, params?: unknown[]) {
      if (/SELECT state FROM page_crdt/.test(sql)) {
        const r = rows.get(String((params ?? [])[0]));
        return r ? [r] : [];
      }
      return [];
    },
  };
  return { db: db as unknown as ContentSql, rows };
}

function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-page-state-fixture" });
  editor.update(
    () => {
      $getRoot().clear();
      build(editor);
    },
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

function withIds(json: string): string {
  const d = JSON.parse(toLegacyDoc(json)) as { root: { children: Array<Record<string, unknown>> } };
  d.root.children = d.root.children.map((c, i) =>
    typeof c.blockId === "string" && c.blockId ? c : { ...c, blockId: `b${i + 1}` },
  );
  return JSON.stringify(d);
}

const idsOf = (json: string) =>
  (JSON.parse(json) as { root: { children: Array<{ blockId?: string }> } }).root.children.map(
    (c) => c.blockId ?? "-",
  );

const BASE = withIds(
  buildJson(() => {
    const p1 = $createBlockParagraphNode("blk-1");
    p1.append($createTextNode("第一段"));
    const p2 = $createBlockParagraphNode("blk-2");
    p2.append($createTextNode("第二段"));
    $getRoot().append(p1, p2);
  }),
);

describe("冲刺 S2b：CRDT 状态落盘（`page_crdt`）", () => {
  it("① 没有状态 ⇒ `null`（不是空字节）；写了之后读回**逐字节相同**（BLOB 二进制安全）", () => {
    const { db } = fakeDb();
    expect(readPageCrdtState(db, "p1")).toBeNull();

    // 故意造一份**不是合法 UTF-8** 的字节：若被当文本/base64 存过一道，这里就会不相等
    const raw = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28, 0x01]);
    writePageCrdtState(db, "p1", raw, 7);
    expect(readPageCrdtState(db, "p1")).toEqual(raw);
    expect(Array.from(readPageCrdtState(db, "p1")!)).toEqual(Array.from(raw));
  });

  it("② 同一页只留**最新一份**（主键 upsert）；`clear` 之后回 `null`", () => {
    const { db, rows } = fakeDb();
    writePageCrdtState(db, "p1", new Uint8Array([1, 2, 3]), 1);
    writePageCrdtState(db, "p1", new Uint8Array([9, 9]), 2);
    expect(rows.size).toBe(1);
    expect(Array.from(readPageCrdtState(db, "p1")!)).toEqual([9, 9]);
    clearPageCrdtState(db, "p1");
    expect(readPageCrdtState(db, "p1")).toBeNull();
  });

  it("③ 兜底：驱动若按**二进制字符串**回 BLOB，也能逐字节还原（Web 构建里不许用 `Buffer`）", () => {
    const { db, rows } = fakeDb();
    const raw = new Uint8Array([0x00, 0xff, 0x41, 0x80]);
    rows.set("p1", { state: String.fromCharCode(...raw) }); // 直接塞字符串（模拟驱动的另一种回法）
    expect(Array.from(readPageCrdtState(db, "p1")!)).toEqual(Array.from(raw));
  });

  it("④ ★ 承重：状态落盘 ⇒ 重启后仍是**同一条血统**（两台各改一处 ⇒ 合并后两处都在、不翻倍）", () => {
    const { db } = fakeDb();
    // 第一次保存：页面已落盘（投影）＋ 由这份 JSON 建血统并把状态入库
    writeContent(db, "p1", { title: "页", json: BASE, text: "正文" }, 1);
    writePageCrdtState(db, "p1", openPageSession({ json: BASE }).exportState(), 2);

    // —— 从此往后**只认库里的状态**（模拟重启/另一台设备）——
    const stored = readPageCrdtState(db, "p1")!;
    const afterRestart = openPageSession({ state: stored });
    const otherDevice = openPageSession({ state: stored });

    afterRestart.edit(() => {
      const p = $createBlockParagraphNode("blk-A");
      p.append($createTextNode("重启这台加的"));
      $getRoot().append(p);
    });
    otherDevice.edit(() => {
      const p = $createBlockParagraphNode("blk-B");
      p.append($createTextNode("另一台加的"));
      $getRoot().append(p);
    });

    const mine = afterRestart.exportState();
    afterRestart.merge(otherDevice.exportState());
    otherDevice.merge(mine);

    const ids = idsOf(afterRestart.exportJson());
    console.log(`【④ 实测】跨重启合并后 = ${JSON.stringify(ids)}`);
    expect(new Set(ids).size).toBe(ids.length); // 不翻倍（S1 红线的症状）
    expect([...ids].sort()).toEqual(["blk-1", "blk-2", "blk-A", "blk-B"]);
    // 两台的投影**完全一致**（含顺序）
    expect(idsOf(otherDevice.exportJson())).toEqual(ids);

    // 把合并后的状态存回 ⇒ 再读回来还能继续用（不是"存了就废"）
    writePageCrdtState(db, "p1", afterRestart.exportState(), 3);
    const again = openPageSession({ state: readPageCrdtState(db, "p1")! });
    expect(idsOf(again.exportJson())).toEqual(ids);
  });
});
