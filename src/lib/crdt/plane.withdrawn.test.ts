// **磁盘边界的 CRDT 平面开关已撤出**（2026-09-23 第 47 轮）：这一片把"撤出"这件事本身变成判据。
//
// ## 为什么有这条判据（判据替换，不是删了不写）
//
// 撤出前那两份判据（`plane.test.ts` 3 条 ＋ `plane.path.test.ts` 9 条）测的是那个开关。开关没了，
// 逐条交代它们的去向（本仓纪律：**判据不许删了不写替代**）：
//   · ①「关着逐字节等价」 ⇒ **本文件 ①**（变成**无条件**成立，而且断言更硬：直接比对**落库那一行**）；
//   · ②「开着往返不丢东西」・③「切开关不改已落盘内容」 ⇒ **随开关作废**；替代＝**本文件 ④ 的护栏**
//     （那三件一旦回来就红）；
//   · ④「引用完整性」・④'「批量读与单读一致」 ⇒ **本文件 ②/③**（无条件）；
//   · ⑤/⑤'/⑤''「派生列不静默落后 ⇒ 有痕 ＋ 补算器收口」 ⇒ 与新边界无关，**留在既有判据**
//     （`src/lib/docContent.test.ts` 的 `text_stale`/`staleTextQueue` 那组）；
//   · ⑥「存量未补种身份的页 ⇒ 开着读会如实抛」 ⇒ **随开关作废**（那正是平面造成的失败模式；
//     边界决策 §6.2 已写明它随"前提 4"一起划掉）。
//   · `plane.test.ts` 的「没注册 ⇒ 如实抛」 ⇒ **本来就有对应判据**：`remoteApply.test.ts` ①②
//     测的就是这条性质（对象是下文那个**下半段**的注入点，而不是被撤掉的开关）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { topLevelBlockIds } from "../blockIdentity";
import { readAllContents, readContent, writeContent, type ContentSql, type DocContent } from "../docContent";

interface FakeRow {
  id: string;
  title: string;
  content_json: string;
  content_text: string;
  updated_at: number;
}

/**
 * 极简内存库：只认本层这几条 SQL 形状，**不认识的形状当场抛**
 * （这样"层里多了一条新 SQL"会在这里显形，而不是被一个宽容的 mock 静默吃掉）。
 */
function fakeDb() {
  const rows = new Map<string, FakeRow>();
  const db = {
    run(sql: string, params: unknown[]) {
      if (/UPDATE pages SET title = \?/.test(sql)) {
        const [title, json, text, now, id] = params as [string, string, string, number, string];
        rows.set(id, { id, title, content_json: json, content_text: text, updated_at: now });
        return;
      }
      throw new Error(`fakeDb 不认这条 run：${sql.slice(0, 60)}`);
    },
    query(sql: string, params?: unknown[]) {
      if (/SELECT title, content_json, content_text FROM pages WHERE id = \?/.test(sql)) {
        const r = rows.get(String((params ?? [])[0]));
        return r ? [r] : [];
      }
      if (/SELECT id, title, content_json, content_text FROM pages WHERE deleted_at IS NULL/.test(sql)) {
        return [...rows.values()];
      }
      throw new Error(`fakeDb 不认这条 query：${sql.slice(0, 60)}`);
    },
  };
  return { db: db as unknown as ContentSql, rows };
}

/** 一份"会被归一化改写"的 JSON：键序打乱 ＋ 嵌层也有 `blockRev`（归一化器会剥掉它）。 */
const AWKWARD_JSON = JSON.stringify({
  root: {
    direction: "ltr",
    children: [
      {
        children: [{ blockRev: 7, text: "第一段", type: "text" }],
        type: "shuyo-paragraph",
        blockId: "blk-1",
        blockRev: 3,
        version: 1,
      },
      {
        blockId: "blk-2",
        type: "shuyo-paragraph",
        version: 1,
        children: [{ type: "text", text: "第二段" }],
      },
    ],
    format: "",
    indent: 0,
    type: "root",
    version: 1,
  },
});

const content = (json: string): DocContent => ({ title: "页", json, text: "派生文本（原样）" });

describe("第 47 轮：磁盘边界的 CRDT 平面已撤出（读写路径一个字都不改）", () => {
  it("① ★ 承重：写进去什么，落库就是什么、读回来也是什么（**逐字节**，不再有「关着＝恒等」这回事）", () => {
    const { db, rows } = fakeDb();
    writeContent(db, "p1", content(AWKWARD_JSON), 111);

    // 落库那一行：**逐字节**等于传入（任何"顺手归一化"都会在这里红）
    expect(rows.get("p1")!.content_json).toBe(AWKWARD_JSON);
    // 读回来：同样逐字节（原 ① 的"关着逐字节等价"变成**无条件**成立）
    expect(readContent(db, "p1")!.json).toBe(AWKWARD_JSON);
    expect(readContent(db, "p1")!.text).toBe("派生文本（原样）");
  });

  it("② 引用完整性：块身份（`topLevelBlockIds` 的**集合与顺序**）穿过读写不变", () => {
    const { db } = fakeDb();
    const want = topLevelBlockIds(AWKWARD_JSON);
    expect(want).toEqual(["blk-1", "blk-2"]); // 前提：这份 fixtures 确实有两个有身份的顶层块
    writeContent(db, "p1", content(AWKWARD_JSON), 1);
    expect(topLevelBlockIds(readContent(db, "p1")!.json)).toEqual(want);
  });

  it("③ 批量读出口与单读一致（`readAllContents` 与 `readContent` 给出的正文逐字节相同）", () => {
    const { db } = fakeDb();
    writeContent(db, "p1", content(AWKWARD_JSON), 1);
    const all = readAllContents(db);
    expect(all).toHaveLength(1);
    expect(all[0].json).toBe(readContent(db, "p1")!.json);
  });

  it("④ ★ 护栏（文本级）：开关三件**不许回来**，而**下半段**（远端落地注入）必须还在", () => {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const layer = strip(readFileSync(join(process.cwd(), "src/lib/docContent.ts"), "utf8"));
    const plane = strip(readFileSync(join(process.cwd(), "src/lib/crdt/plane.ts"), "utf8"));
    const web = strip(readFileSync(join(process.cwd(), "src/lib/platform/web.ts"), "utf8"));

    // ⚠️ 先剥注释：本文件与 `plane.ts` 的注释里**故意写着**这三个名字（讲它为什么被撤），
    //    文本级断言分不清代码与注释 —— 与 `webClaimScope.wiring.test.ts` 同一个坑。
    for (const sym of ["throughCrdtPlane", "VITE_CRDT_PLANE", "setCrdtPlaneImpl", "isCrdtPlaneEnabled"]) {
      expect(layer, `那一层里又出现了 ${sym}`).not.toContain(sym);
      expect(plane, `plane.ts 里又导出了 ${sym}`).not.toContain(sym);
    }
    // ★ 反向：撤出**不许**把在用的那一半一起删掉（同步路径每天在调它）
    expect(plane).toContain("applyRemoteCrdtState");
    expect(web).toContain("applyRemoteCrdtState");
    // ★ 生产入口不再为了那个开关去 import 带编辑器节点表的桥接层
    const main = strip(readFileSync(join(process.cwd(), "src/main.tsx"), "utf8"));
    expect(main).not.toContain("roundTripContentJson");
  });
});
