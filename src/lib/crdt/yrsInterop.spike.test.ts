// 冲刺缺口 **§10.3-6 / §9.2-4**：**yrs 对拍尖刺**（JS `yjs` ↔ Rust `yrs`）。
//
// 它是**尖刺，不是门禁**：要一个外部二进制（`spikes/yrs-interop`，独立 crate，不进 app 依赖树）
// 才能跑 ⇒ 没有就 `describe.skipIf` **自报跳过**（与 `rust-sm-wired` 同一条纪律：
// 宁可自报跳过，也不假装绿）。本机跑法：
//
//   cd spikes/yrs-interop && cargo build
//   pnpm vitest run src/lib/crdt/yrsInterop.spike.test.ts
//
// 分工（为什么 Rust 侧不实现投影）：投影要**编辑器语义**（`@lexical/yjs` 的 V2 绑定）。
// 在 Rust 侧复刻它就是本仓最忌的"第二份派生实现"。所以：
//   · JS 造 fixtures（真 yjs ＋ 真 @lexical/yjs）＋ 投影（用**应用自己那份**实现）；
//   · Rust 只做"收下 update → 合并 → 再吐出来" ＋ 结构读数；
//   · 再由 JS 把 Rust 吐出来的状态投影出来，与 JS 自己合并的投影**逐字节比**。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Y from "yjs";
import { $createTextNode, $getRoot, createEditor, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";
import { EDITOR_NODES } from "../../editor/config";
import { $createBlockParagraphNode } from "../../editor/nodes/BlockParagraphNode";
import { toLegacyDoc } from "../blockIdentity";
import { openPageSession, projectStateToJson } from "./yDocBridge";

/** 尖刺二进制（`cargo build` 的产物）。没有 ⇒ 本文件整体自报跳过。 */
const BIN = resolve(process.cwd(), "spikes", "yrs-interop", "target", "debug", "yrs-interop.exe");
const hasBin = existsSync(BIN);

function buildJson(build: (editor: LexicalEditor) => void): string {
  const editor = createEditor({ nodes: EDITOR_NODES, namespace: "yrs-interop-fixture" });
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

/** 两段的基线页（与 `pageSession.test.ts` 同一套搭法）。 */
const BASE = withIds(
  buildJson(() => {
    const p1 = $createBlockParagraphNode("blk-1");
    p1.append($createTextNode("第一段"));
    const p2 = $createBlockParagraphNode("blk-2");
    p2.append($createTextNode("第二段"));
    $getRoot().append(p1, p2);
  }),
);

/** 跑一次尖刺二进制（读数走文件，不靠管道 —— 调用方与它的 stdout 口径不必绑死）。 */
function run(args: string[]): void {
  const r = spawnSync(BIN, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`yrs-interop ${args.join(" ")} 退出码 ${r.status}`);
}

describe.skipIf(!hasBin)("缺口 §10.3-6：yrs 对拍尖刺（JS yjs ↔ Rust yrs）", () => {
  it("★ JS 合并与 Rust 合并对同一批 fixtures ⇒ 投影**逐字节相同**、块身份是并集", () => {
    const dir = mkdtempSync(join(tmpdir(), "yrs-interop-"));
    try {
      // 同一血统（s0）→ 两端各改一处（这一批 fixtures 与 S2a 的承重判据同形）
      const a = openPageSession({ json: BASE });
      const s0 = a.exportState();
      const b = openPageSession({ state: s0 });
      a.edit(() => {
        const p = $createBlockParagraphNode("blk-A");
        p.append($createTextNode("A 加的"));
        $getRoot().append(p);
      });
      b.edit(() => {
        const p = $createBlockParagraphNode("blk-B");
        p.append($createTextNode("B 加的"));
        $getRoot().append(p);
      });
      const aState = a.exportState();
      const bState = b.exportState();

      // ① JS 侧合并（应用自己的实现在合并，投影也用它）
      a.merge(bState);
      const jsMergedState = a.exportState();
      const jsProjection = projectStateToJson(jsMergedState);

      // ② Rust 侧合并（只搬字节）
      const fBase = join(dir, "base.bin");
      const fA = join(dir, "a.bin");
      const fB = join(dir, "b.bin");
      const fMerged = join(dir, "rust-merged.bin");
      writeFileSync(fBase, s0);
      writeFileSync(fA, aState);
      writeFileSync(fB, bState);
      run(["merge", fMerged, fA, fB]);
      const rustMergedState = new Uint8Array(readFileSync(fMerged));

      // ③ ★ 承重：同一个投影实现，喂 JS 合并的状态 vs 喂 Rust 合并的状态 ⇒ 逐字节相同
      const rustProjection = projectStateToJson(rustMergedState);
      console.log(`【实测】JS 投影 = ${JSON.stringify(idsOf(jsProjection))}`);
      console.log(`【实测】Rust 投影 = ${JSON.stringify(idsOf(rustProjection))}`);
      expect(rustProjection).toBe(jsProjection);

      // ④ 两处编辑都在、无重复（S1 红线的症状不出现）
      const ids = idsOf(rustProjection);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(["blk-1", "blk-2", "blk-A", "blk-B"]);

      // ⑤ 反方向也成立：JS 合并出来的状态，Rust 收下再吐出来，JS 仍然投影得起
      const fJsMerged = join(dir, "js-merged.bin");
      const fBack = join(dir, "rust-back.bin");
      writeFileSync(fJsMerged, jsMergedState);
      run(["merge", fBack, fBase, fJsMerged]);
      const backState = new Uint8Array(readFileSync(fBack));
      expect(projectStateToJson(backState)).toBe(jsProjection);

      // ⑥ 结构读数：两侧**认得同一个根**（Rust 的 root_children 与 JS 读到的一致）
      const fInspect = join(dir, "inspect.txt");
      run(["inspect", fInspect, fBase, fA, fB]);
      const readout = readFileSync(fInspect, "utf8");
      console.log(`【实测】Rust 结构读数：\n${readout}`);
      const rustChildren = Number(/root_children=(\d+)/.exec(readout)?.[1] ?? "-1");
      const jsDoc = new Y.Doc();
      const jsRoot = jsDoc.get("root-v2", Y.XmlElement);
      Y.applyUpdate(jsDoc, aState);
      Y.applyUpdate(jsDoc, bState);
      expect(rustChildren).toBe(jsRoot.length);
      expect(rustChildren).toBe(4);
      expect(readout).not.toContain("state_vector=\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("★ yrs 的失败形态：**读事务里再要写事务 ⇒ 卡死**（不是报错）；并发共享 Doc 反而没复现失败", () => {
    const dir = mkdtempSync(join(tmpdir(), "yrs-interop-threads-"));
    try {
      const fOut = join(dir, "threads.txt");
      run(["threads", fOut]);
      const readout = readFileSync(fOut, "utf8");
      console.log(`【实测】线程/事务读数：\n${readout}`);
      // ★ 承重：读事务还活着时再调 `get_or_insert_*` ⇒ **卡住**（不是 panic、不是错误码）。
      //   "不返回"才是服务端要防的形态 —— 连接不返回、线程池会被吃光。
      //   （本文件第一版就是这么写的：`inspect` 实测挂住 ≥45s，另一次整条命令卡到 120s 超时。）
      expect(readout).toContain("读事务还活着时再调 get_or_insert（失败形态）: ★");
      expect(readout).toContain("卡住");
      // 反面读数（如实记）：并发共享一个 Doc **没有**复现失败 ⇒ 不许把"共享一定卡"当前提。
      expect(readout).toContain("共享一个 Doc ＋ 两线程各自 get_or_insert 并写");
      expect(readout).toContain("线程 A 没有 panic／线程 B 没有 panic");
      // 我们打算用的形状：每页独立、请求内短命 Doc
      expect(readout).toContain("各用一个 Doc（我们打算用的形状）: A=Ok");
      expect(readout).toContain("B=Ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
