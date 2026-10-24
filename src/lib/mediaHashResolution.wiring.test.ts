// ⭐ 2026-10-24（owner 报「图片块同步不正常」）：**接线判据**。
//
// 纯逻辑在 `mediaUrl.ts`（有自己的单测），这里钉的是"那套逻辑真的接上了"：
//   · 渲染层必须把 `hash` 交给解析器，并且桌面那条要用 `attachmentPath` ＋ `convertFileSrc`；
//   · 本地没字节时必须走 `ensureAttachmentBytes`（而且渲染期要静默，别一页多张图弹一串 toast）；
//   · Rust 那条"跟谁对暗号"必须用**解析后的房间**（个人档 `space_id` 是空串 —— 原来那一档整个被跳过）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("图片块同步：hash → 本机地址的接线", () => {
  const resolver = read("src/editor/nodes/MediaResolver.tsx");
  const rustSync = read("src-tauri/src/sync.rs");

  it("① 渲染层把 hash 交给解析器，桌面走 attachmentPath ＋ convertFileSrc", () => {
    expect(resolver, "渲染层没调解析器").toContain("resolveMediaUrl(");
    expect(resolver, "桌面档没按 hash 找本机路径 ⇒ 只能回落同步过来的绝对 src（对面必碎图）").toContain(
      "api.attachmentPath(",
    );
    expect(resolver, "没把本机路径换成可显示 URL").toContain("platform.asset.convertFileSrc(");
  });

  it("② 本地没字节时按需取回，且渲染期静默（quiet）", () => {
    expect(resolver, "没有按需取字节这一步 ⇒ 网格同步过来的图永远显示不出来").toContain(
      "ensureAttachmentBytes(",
    );
    expect(resolver, "渲染期必须 quiet（一页多张图会把 toast 刷满）").toContain("quiet: true");
  });

  it("③ Rust：对端那一档不能因为个人档 space_id 是空串就整批跳过", () => {
    expect(rustSync, "没有把空 space_id 解析成房间的纯函数").toContain("peer_lookup_space");
    expect(rustSync, "个人档必须用解析后的房间去问对端").toContain("mesh_scope_at(&c, Some(&ws_id))");
  });
});
