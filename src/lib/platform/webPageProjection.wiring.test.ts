// §13.3 第 1 条（投影写回）在**两平面**上的**接线判据**（文本级）。
//
// ⚠️ 与 `webClaimScope.wiring.test.ts` 同一手法、同一已知弱点（**文本级，会被骗**）。
// 它抓的不是"语义对不对"（那由 `docContent.test.ts` 的 4 条 ＋ Rust 3 条负责），而是
// "**接线有没有断 / 有没有在平台层再写一份判定**"：
//   · 语义只许有一处实现（`writePageProjectionIfChanged` / `doc_content::write_page_projection`）——
//     平台层自己再抄一份"内容变了没 / 是不是数据库页"的判定，就会两平面漂移；
//   · 调用点断掉（端口不接、或 `pageBinding` 那一步被删）= 这个功能静默失效（退回"要等下一次保存"）。
// 为什么值得为它写一条会骗人的判据：这条接线**没有别的判据** —— 端到端只有浏览器门禁碰得到，
// 而浏览器门禁走的是"本机新建页面"那条路（没有待并状态 ⇒ 这条分支根本不会被触发）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));
const web = read("src/lib/platform/web.ts");
const api = read("src/lib/api.ts");
const editor = read("src/editor/Editor.tsx");
const binding = read("src/lib/crdt/pageBinding.ts");
const contract = read("src/lib/platform/commands.ts");

/** 取 `write_page_projection` 在 web.ts 里那个命令分支的源文本（到下一个 `if (cmd === ` 为止）。 */
function webBranch(): string {
  const start = web.indexOf('if (cmd === "write_page_projection")');
  expect(start, "web.ts 里找不到 write_page_projection 分支").toBeGreaterThan(-1);
  const next = web.indexOf("if (cmd === ", start + 10);
  return web.slice(start, next < 0 ? undefined : next);
}

describe("§13.3 · 投影写回的接线（文本级，防退回静默/防两平面漂移）", () => {
  it("① 平台层**只调**那一层的实现，不自己写第二份判定", () => {
    const branch = webBranch();
    expect(branch, "web 分支必须走文档内容层那个带判据的入口").toContain("writePageProjectionIfChanged(");
    // 平台层不许自己判"内容变了没 / 是不是数据库页" —— 那两件事只许有一处实现。
    // （`args.content_json` 是**命令的入参名**，读它是对的；这里禁的是**碰存储**的那些形状。）
    expect(branch, "平台层又自己写了存储").not.toContain("UPDATE pages");
    expect(branch, "平台层又自己读了存储列 ⇒ 两平面会漂移").not.toContain("SELECT content_json");
    expect(branch, "平台层又自己判了「待重建」那件事").not.toContain("text_stale");
    expect(branch, "平台层又自己判了数据库页").not.toContain("database");
  });

  it("② 端口 → `api` → 命令 三层都接上了（断一层就静默失效）", () => {
    // 端口版绑定里真的调了它（且只在有待并状态时 —— "没变就不写"那一层判据在端口测试里）
    expect(binding).toContain("port.writeProjection?.(");
    expect(binding, "调用点必须带「没变就不写」的判据形状").toContain("mergedJson !== baseJson");
    // Editor 的端口把它接到 api 上
    expect(editor).toContain("writeProjection: (id, json) => api.writePageProjection(id, json)");
    // api 包的是新命令，且名字与契约一致
    expect(api).toContain('invoke("write_page_projection"');
    expect(contract).toContain("write_page_projection:");
  });
});
