// 「血统拒绝合并」在**两条路**上的**接线判据**（文本级）。
//
// ⚠️ 与 `useSyncStream.wiring.test.ts` / `webClaimScope.wiring.test.ts` 同一手法、同一已知弱点
// （**文本级，会被骗**）。它抓的不是"措辞对不对"（那由 `lineageNotice.test.ts` 的纯函数判据负责），
// 而是"**这个出口有没有被接上 / 会不会又退回静默**" ——
// 第 43 轮就是接线上漏的：`bindPageToEditorViaPort` 把 `pendingSkipped` **算出来了**，
// 而调用方（`Editor.tsx`）**一个字都没读** ⇒ 用户永远不知道"这一页有对端改动没合进来"。
//
// 为什么值得为它写一条会骗人的判据：这条接线**没有别的判据**——要它真跑起来，得同时具备
// "本机有状态 ＋ 收下了对端的待并状态 ＋ 两条血统无关"，且要看**用户可见**的 toast（测试里没有 UI）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 去掉注释后再断言 —— 与 `check-capabilities.mjs` 同一手法（注释里为了讲语义会引用旧写法）。 */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));
const editor = read("src/editor/Editor.tsx");
const main = read("src/main.tsx");
const binding = read("src/lib/crdt/pageBinding.ts");
const notice = read("src/lib/crdt/lineageNotice.ts");
const banner = read("src/components/LineageConflictBanner.tsx");
const app = read("src/App.tsx");

describe("血统拒绝合并 · 两条路的出口（文本级，防退回静默）", () => {
  it("★ 打开页面那条路真的**读了** `pendingSkipped`（不是算出来就丢）", () => {
    expect(editor, "调用方必须读 pendingSkipped —— 这一条就是第 43 轮缺的那半").toContain("pendingSkipped");
    expect(editor, "读了它就必须接到可见出口上").toContain("lineageRefusalNotice(");
    // 精确到位：`pendingSkipped` 必须**作为值**传进 notice（注释已被剥掉 ⇒ 出现即代码）
    expect(editor, "`pendingSkipped` 要直接进 notice 的参数，不是算完丢掉").toContain("skipped: b.pendingSkipped");
  });

  it("★ 两条路**共用同一个措辞来源**（不许各自长一句话）", () => {
    expect(main, "pull 那条路也要走同一个 helper").toContain("lineageRefusalNotice(");
    // 措辞的**字面量**只许出现在 `lineageNotice.ts`：main/Editor 里再抄一遍就是"第二个来源"
    const phrase = "两条互不相关的编辑历史";
    expect(notice, "措辞必须定义在唯一来源里").toContain(phrase);
    expect(main, "`main.tsx` 里又抄了一遍措辞 ⇒ 两条路会漂移").not.toContain(phrase);
    expect(editor, "`Editor.tsx` 里又抄了一遍措辞 ⇒ 两条路会漂移").not.toContain(phrase);
  });

  it("两条路都**先留痕再打扰用户**（console.error ＋ toast，缺一不可）", () => {
    // 有痕：日志（`refusal.log`）（`main.tsx` 的 `console.error` 与 `Editor.tsx` 的各一处）
    expect(main).toContain("console.error(refusal.log)");
    expect(editor).toContain("console.error(refusal.log)");
    // 用户可见：toast（两条路都要）
    expect(main).toContain("toast(refusal.message");
    expect(editor).toContain("toast(refusal.message");
  });

  it("护栏里那条**当场留痕**不许消失（立刻有痕，不依赖调用方）", () => {
    // `mergeRemotePageState` / 端口版绑定各自 `console.warn` 一次：万一哪天调用方又漏了，
    // 至少日志里还有。删掉它＝把"静默"的门槛降回第 43 轮。
    expect(binding, "端口版绑定里那条「拒绝合并」的当场留痕不见了").toContain("拒绝合并");
    expect(binding).toContain("console.warn");
  });

  it("★ 页级「可裁决」的出口也接着（第 49 轮）：挂载了横幅 ＋ 两处记录点都在", () => {
    // ① 横幅真的挂上了（不然表里记了也没人看得见 —— 又回到"算出来没人读"）
    expect(app, "App 里没有挂 LineageConflictBanner ⇒ 页级冲突用户看不见").toContain(
      "<LineageConflictBanner",
    );
    // ② 两处记录点：web 当场合并那条（直接落库）＋ 桌面端口那条（走平台命令）
    expect(binding, "web 当场合并那条少了页级留痕").toContain("recordLineageConflict(");
    expect(binding, "桌面端口那条少了页级留痕").toContain("port.recordLineageConflict?.(");
    // ③ 去重键必须是**同一份指纹口径**（两处各算一次 ⇒ 口径漂了去重就失效）
    expect(binding).toContain("lineageFingerprint(");
    // ④ 横幅的两个动作都接到命令上（断一个就变成"看得见、按不动"）
    expect(banner).toContain('resolveLineageConflict(row.id, "saved-as-new")');
    expect(banner).toContain('resolveLineageConflict(row.id, "local")');
  });
});
