// Slice B 的**路径级**判据（施工单 `docs/plans/2026-09-23-crdt-slice-b-workorder.md` §3 的落地版）。
//
// 为什么单独一个文件：这里要的是"**落库字节**"层面的证据，与 `crdt/plane.test.ts` 那种薄壳判据不同
// —— 前者证明"开关本身是恒等的"，这里证明"**整条读写路径**在关掉时一个字都没变"。
// 用一个极小的内存假库（只认本层真正会发的几种 SQL），不依赖测试夹具，读起来一眼能对上是哪条。
//
// 判据地图（① ② ③ 是 2026-09-23 上午落的；④ ⑤ ⑥ 是同日补的，补的正是施工单 §0.6 前提 1 里
// "还没写"的那两条 ＋ 一条实测撞出来的**存量风险**）：
//   ① 关着逐字节等价　② 开着往返不丢东西　③ 切换开关不改已落盘内容（收敛）
//   ④ 引用完整性：`topLevelBlockIds` 集合与顺序不变（这是本产品与普通编辑器差在哪）
//   ⑤ 派生口径：正文列/FTS **不静默落后** —— 落后时**有痕**（`text_stale`）且补算器能收口
//   ⑥ 存量风险：还没补种块身份的页面 ⇒ **开着读会如实抛错**（不是静默返回、也不是静默丢块）
import { describe, expect, it, beforeEach } from "vitest";
import {
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from "lexical";
import { $createHeadingNode } from "@lexical/rich-text";
import { $createCodeNode } from "@lexical/code";
import { $createListItemNode, $createListNode } from "@lexical/list";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc, topLevelBlockIds } from "../blockIdentity";
import {
  applyRemoteContent,
  readAllContents,
  readContent,
  refreshPageTextIfStale,
  staleTextQueue,
  textStale,
  writeContent,
  type ContentSql,
  type DocContent,
} from "../docContent";
import { setCrdtPlaneEnabled, setCrdtPlaneImpl } from "./plane";
import { roundTripContentJson } from "./yDocBridge";

// 实现由界面侧注册（生产 `src/main.tsx`）；判据里注册真的那一份（开着时走的就是它）。
setCrdtPlaneImpl(roundTripContentJson);

/** 假库里的一行（够本层这几条 SQL 用；`kind` / `text_stale` / `updated_at` 是 ④⑤ 才要的列）。 */
interface FakeRow {
  id: string;
  title: string;
  content_json: string;
  content_text: string;
  kind: string;
  text_stale: number;
  updated_at: number;
}

/**
 * 极简内存库：够 `readContent` / `readAllContents` / `writeContent` ＋ ④⑤⑥ 要碰的
 * `applyRemoteContent` / `markTextStale` / `staleTextQueue` 用（别扩成通用 mock）。
 *
 * ⚠️ 只认本层**真正会发**的那几种 SQL 形状；不认识的形状**当场抛** —— 这样"层里多了一条新 SQL"
 * 会在这里显形，而不是被一个宽容的 mock 静默吃掉。
 */
function fakeDb() {
  const rows = new Map<string, FakeRow>();
  const put = (id: string, patch: Partial<FakeRow>) => {
    const cur = rows.get(id) ?? {
      id,
      title: "",
      content_json: "{}",
      content_text: "",
      kind: "page",
      text_stale: 0,
      updated_at: 0,
    };
    rows.set(id, { ...cur, ...patch });
  };
  const db = {
    run(sql: string, params: unknown[]) {
      if (/UPDATE pages SET title = \?/.test(sql)) {
        const [title, json, text, now, id] = params as [string, string, string, number, string];
        put(id, { title, content_json: json, content_text: text, updated_at: now });
        return;
      }
      if (/UPDATE pages SET text_stale = 1/.test(sql)) {
        put(String(params[0]), { text_stale: 1 });
        return;
      }
      if (/UPDATE pages SET text_stale = 0/.test(sql)) {
        put(String(params[0]), { text_stale: 0 });
        return;
      }
      if (/UPDATE pages SET content_text = \?/.test(sql)) {
        const [text, id] = params as [string, string];
        put(id, { content_text: text });
        return;
      }
      if (/INSERT INTO pages \(/.test(sql)) {
        const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
        const id = String(params[0]);
        const rec: Record<string, unknown> = { id };
        cols.forEach((c, i) => {
          rec[c] = params[i]; // 末列 `dirty` 是字面量 0，不在 params 里 ⇒ 正好只填到 `sync_seq`
        });
        put(id, {
          title: String(rec.title ?? ""),
          content_json: String(rec.content_json ?? "{}"),
          content_text: String(rec.content_text ?? ""),
          kind: String(rec.kind ?? "page"),
          updated_at: Number(rec.updated_at ?? 0),
        });
        return;
      }
      throw new Error(`fakeDb 不认这条 run：${sql.slice(0, 48)}`);
    },
    query(sql: string, params?: unknown[]) {
      if (/COALESCE\(text_stale, 0\)/.test(sql)) {
        const r = rows.get(String((params ?? [])[0]));
        return r ? [{ text_stale: r.text_stale }] : [];
      }
      if (/COUNT\(\*\)/.test(sql)) {
        return [{ n: [...rows.values()].filter((r) => r.text_stale === 1 && r.kind !== "database").length }];
      }
      if (/content_json AS doc_json/.test(sql)) {
        return [...rows.values()]
          .filter((r) => r.text_stale === 1 && r.kind !== "database")
          .map((r) => ({ id: r.id, title: r.title, doc_json: r.content_json }));
      }
      if (/WHERE id = \?/.test(sql)) {
        const r = rows.get(String((params ?? [])[0]));
        return r ? [r] : [];
      }
      return [...rows.values()];
    },
  };
  return { db: db as unknown as ContentSql, rows };
}

const SAMPLE: DocContent = {
  title: "页",
  json: '{"root":{"type":"root","version":1,"children":[{"type":"paragraph","blockId":"b1","children":[]}]}}',
  text: "正文",
};

/** 用真编辑器搭一份**合法**的 Lexical JSON（模型形态）。与 `yDocBridge.test.ts` 同一手法（那边有长注释）。 */
function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "crdt-plane-path-fixture" });
  editor.update(
    () => {
      $getRoot().clear();
      build(editor);
    },
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

/** 落盘形态 ＋ 给每个顶层块一个确定性 id（生产里由保存路径 `serializeWithBlockIds` 做；本层不造身份）。 */
function withIds(json: string): string {
  const d = JSON.parse(toLegacyDoc(json)) as { root: { children: Array<Record<string, unknown>> } };
  d.root.children = d.root.children.map((c, i) =>
    typeof c.blockId === "string" && c.blockId ? c : { ...c, blockId: `b${i + 1}` },
  );
  return JSON.stringify(d);
}

/** ④ 的样本：四种**不同**顶层块（段落 / 标题 / 列表 / 代码）—— 引用完整性要的是"块一多就露馅"。 */
function richJson(): string {
  return withIds(
    buildJson(() => {
      const p = $createBlockParagraphNode("blk-p");
      p.append($createTextNode("第一段"));
      const h = $createHeadingNode("h2");
      h.append($createTextNode("小标题"));
      const list = $createListNode("bullet");
      const li = $createListItemNode();
      li.append($createTextNode("第一项"));
      list.append(li);
      const code = $createCodeNode();
      code.append($createTextNode("const x = 1;"));
      $getRoot().append(p, h, list, code);
    }),
  );
}

describe("Slice B：开关接进读写路径之后", () => {
  beforeEach(() => setCrdtPlaneEnabled(false));

  it("① ★ 关着（默认）⇒ 落库的 `content_json` 与传入**逐字节相同**，读回来也原样", () => {
    const { db, rows } = fakeDb();
    writeContent(db, "p1", SAMPLE, 1);
    expect(rows.get("p1")!.content_json).toBe(SAMPLE.json); // 同一内容，逐字节
    const back = readContent(db, "p1");
    expect(back!.json).toBe(SAMPLE.json);
    expect(readAllContents(db)[0].json).toBe(SAMPLE.json);
  });

  it("② 开着 ⇒ 落库的是**往返后**的字节（允许不同），读回来仍是同一条内容", () => {
    const { db, rows } = fakeDb();
    setCrdtPlaneEnabled(true);
    writeContent(db, "p1", SAMPLE, 1);
    expect(rows.get("p1")!.content_json).toBe(roundTripContentJson(SAMPLE.json));
    // 内容层面：块身份没丢（这是"允许不同"的边界——只准形态不同，不准丢东西）
    expect(readContent(db, "p1")!.json).toContain('"blockId":"b1"');
    setCrdtPlaneEnabled(false);
  });

  it("③ ★ 切换开关**不改变已落盘内容**：关着写一版 → 开着读一遍再写回 → 落库字节不变", () => {
    const { db, rows } = fakeDb();
    writeContent(db, "p1", SAMPLE, 1);
    const before = rows.get("p1")!.content_json;

    setCrdtPlaneEnabled(true);
    const read = readContent(db, "p1")!;
    writeContent(db, "p1", read, 2);
    const afterPlane = rows.get("p1")!.content_json;

    setCrdtPlaneEnabled(false);
    const read2 = readContent(db, "p1")!;
    writeContent(db, "p1", read2, 3);

    // 允许"过一遍平面"把形态改写一次，但**关着再读再写**不允许再变（收敛）
    expect(rows.get("p1")!.content_json).toBe(afterPlane);
    expect(afterPlane).toBe(roundTripContentJson(before));
  });

  // ---------------------------------------------------------------------------------------
  // ④ 引用完整性 —— 施工单 §0.6 的"打开之后**不允许**"第 2 条：`topLevelBlockIds` 集合不许变。
  //
  // 为什么用 `topLevelBlockIds` 而不是再数一遍 JSON：它是**产品自己读块身份的那个函数**
  // （`Editor.tsx:238` 起 annotation 的锚点、反链/`resolve_block` 那条路都从它出发）。
  // 判据要是自己写一套"看看 blockId 还在不在"，那证明的是"我的检查器",不是"产品读得到"。
  // ---------------------------------------------------------------------------------------
  it("④ ★ 引用完整性：开着/关着两条路写出来的页面，`topLevelBlockIds` **集合与顺序完全相同**", () => {
    const json = richJson();
    const want = topLevelBlockIds(json);
    expect(want).toEqual(["blk-p", "b2", "b3", "b4"]); // 4 块、顺序即正文顺序（标题/列表/代码是保存路径补的 id）

    const off = fakeDb();
    writeContent(off.db, "p1", { title: "页", json, text: "正文" }, 1);
    const on = fakeDb();
    setCrdtPlaneEnabled(true);
    writeContent(on.db, "p1", { title: "页", json, text: "正文" }, 1);
    // ★ **开着读**（这是平面的读侧，别把它跳过）：落库字节过了平面，读回来仍要给同一张块表
    expect(topLevelBlockIds(readContent(on.db, "p1")!.json)).toEqual(want);
    setCrdtPlaneEnabled(false);

    // 两条路都读得回同一张块表（关着读 = 今天的行为，零感知）
    expect(topLevelBlockIds(readContent(off.db, "p1")!.json)).toEqual(want);
    expect(topLevelBlockIds(readContent(on.db, "p1")!.json)).toEqual(want);
    // ★ 而且"开着"这一支**字节确实变了** —— 否则这一条判据是恒真的（证明不了任何事）
    expect(on.rows.get("p1")!.content_json).not.toBe(off.rows.get("p1")!.content_json);
  });

  it("④' 批量读出口不丢块：`readAllContents` 与 `readContent` 给出的块表一致（开着也一样）", () => {
    const json = richJson();
    const { db } = fakeDb();
    writeContent(db, "p1", { title: "页", json, text: "正文" }, 1);
    setCrdtPlaneEnabled(true);
    const one = topLevelBlockIds(readContent(db, "p1")!.json);
    const all = topLevelBlockIds(readAllContents(db)[0].json);
    setCrdtPlaneEnabled(false);
    expect(all).toEqual(one);
    expect(all).toEqual(["blk-p", "b2", "b3", "b4"]);
  });

  // ---------------------------------------------------------------------------------------
  // ⑤ 派生口径 —— 施工单 §1 第 3 条（派生索引在平面下何时重建）。
  //
  // 这一条**不许**写成"开着时正文列也对"那种假话：合并产物是"拼出来的"，产出点（磁盘写入 /
  // 远端应用）与派生产出点（编辑器语义算一遍）**本来就不是同一处**。本片只要求两件事：
  //   ① 平面**只碰内容形态**，不碰派生列 —— 两条模式下正文列逐字节相同；
  //   ② 正文列**真的落后**时**有痕**（`text_stale` 打上、进补算队列），而且补算器能把它收口。
  //      "有痕 ＋ 能收口"就是"不静默落后"的可验证形态（裁定 (iii) 同一精神：不许静默）。
  // ---------------------------------------------------------------------------------------
  it("⑤ ★ 派生口径：平面只碰内容形态 ⇒ 两条模式下 `content_text` **逐字节相同**", () => {
    const json = richJson();
    const off = fakeDb();
    writeContent(off.db, "p1", { title: "页", json, text: "派生正文" }, 1);
    const on = fakeDb();
    setCrdtPlaneEnabled(true);
    writeContent(on.db, "p1", { title: "页", json, text: "派生正文" }, 1);
    setCrdtPlaneEnabled(false);

    expect(off.rows.get("p1")!.content_text).toBe("派生正文");
    expect(on.rows.get("p1")!.content_text).toBe("派生正文");
    expect(on.rows.get("p1")!.content_text).toBe(off.rows.get("p1")!.content_text);
    // 正文列没被"过平面"这件事碰过：它一次都没变（开着也不变）
    expect(on.rows.get("p1")!.text_stale).toBe(0);
  });

  it("⑤' ★ 合并产物那条路：正文列**确实落后**，但两种模式下都**有痕**（`text_stale` ＋ 进补算队列）", () => {
    const json = richJson();
    // 远端那一版：**少了**本地最后一块（`shuyo-code`，id `b4`）⇒ 合并会留下本地块 ⇒ keptLocal ⇒ 要打标记
    const children = (JSON.parse(json) as { root: { children: unknown[] } }).root.children;
    const remoteJson = JSON.stringify({
      root: { ...(JSON.parse(json) as { root: Record<string, unknown> }).root, children: children.slice(0, 3) },
    });

    for (const enabled of [false, true]) {
      const fresh = fakeDb();
      writeContent(fresh.db, "p1", { title: "页", json, text: "本地正文" }, 1);
      setCrdtPlaneEnabled(enabled);
      const res = applyRemoteContent(
        fresh.db,
        "p1",
        { id: "p1", title: "页", content_json: remoteJson, content_text: "远端正文" },
        9,
      );
      setCrdtPlaneEnabled(false);

      expect(res.merged).toBe(true); // 走了逐块合并那一支
      expect(fresh.rows.get("p1")!.content_text).toBe("远端正文"); // 如实：正文列还是页级胜方那一份
      expect(textStale(fresh.db, "p1")).toBe(true); // ★ 不静默落后 ⇒ 有痕
      expect(staleTextQueue(fresh.db, 10).pages.map((p) => p.pageId)).toEqual(["p1"]);
      // 合并产物里本地那一块还在（引用完整性在合并路径上也成立）
      expect(topLevelBlockIds(String(fresh.rows.get("p1")!.content_json))).toEqual(["blk-p", "b2", "b3", "b4"]);
    }
  });

  it("⑤'' ★ 补算器收口：算出来的正文写回去 ⇒ 落后被消掉，标记清掉（两种模式下都收敛）", () => {
    for (const enabled of [false, true]) {
      const { db, rows } = fakeDb();
      writeContent(db, "p1", { title: "页", json: richJson(), text: "旧正文" }, 1);
      setCrdtPlaneEnabled(enabled);
      const repaired = refreshPageTextIfStale(db, "p1", "算出来的新正文");
      setCrdtPlaneEnabled(false);

      expect(repaired).toBe(true); // 确实写回了一次（不同才写）
      expect(rows.get("p1")!.content_text).toBe("算出来的新正文"); // 正文列跟上了 ⇒ 不再落后
      expect(textStale(db, "p1")).toBe(false); // 标记清掉 ⇒ 不再算"落后"
      // 再跑一次：正文已一致 ⇒ 一次写库都不做（幂等）
      setCrdtPlaneEnabled(enabled);
      expect(refreshPageTextIfStale(db, "p1", "算出来的新正文")).toBe(false);
      setCrdtPlaneEnabled(false);
    }
  });

  // ---------------------------------------------------------------------------------------
  // ⑥ 存量风险（**补写这条时实测出来的**，不是预想的）：平面开着时，任何**还没补种块身份**的页面
  //    都会在**读**路径上抛错 —— 因为 `yDocBridge` 按纪律"缺 id 就当场报错，不铸身份"。
  //
  //    为什么这条必须写下来：`readAllContents` 是**全库扫描**（反链 / `resolve_block` 走它）⇒
  //    库里只要**一页**没补种身份，"开着"就炸在扫描上。所以"开关成为设置项"之前，
  //    **全库补种块身份**是第 4 条前提（前三条见施工单 §0.6）。
  // ---------------------------------------------------------------------------------------
  it("⑥ ★ 存量页面（顶层块没有 `blockId`）：关着**零感知**原样返回；开着**如实抛错**（不静默、不丢块）", () => {
    const legacy = '{"root":{"type":"root","version":1,"children":[{"type":"paragraph","children":[]}]}}';
    const { db } = fakeDb();
    writeContent(db, "p1", { title: "页", json: legacy, text: "老的" }, 1);

    // 关着：与今天逐字相同（未开启的用户零感知）
    expect(readContent(db, "p1")!.json).toBe(legacy);

    setCrdtPlaneEnabled(true);
    expect(() => readContent(db, "p1")).toThrow(/不造身份/);
    // ★ 批量出口同样炸在扫描上 ⇒ 这是"开关成为设置项"的前置条件，不是边角情况
    expect(() => readAllContents(db)).toThrow(/不造身份/);
    setCrdtPlaneEnabled(false);
  });
});
