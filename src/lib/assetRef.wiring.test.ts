// 判据：**web 端正文里的图片必须是"稳定引用"，不是一次性 blob: 地址**。
//
// 来由（owner 2026-10-23）：「为何 web 版移动端的笔记图片没有保存到本机？」
//   实物：字节确实进了 IndexedDB（blobStore，按内容指纹组织），但正文里存的是
//   `URL.createObjectURL` 造的一次性 `blob:` 地址 + 附件行 page_id=null
//   ⇒ 刷新/换设备后那条地址是废纸，字节再也对不上 ⇒ 用户看到的就是"没保存"。
//   修法：正文存 `asst:<hash>`，渲染时按 hash 现取一个对象 URL（见 `lib/assetRef.ts`）。
//
// ⚠️ 这一档是**源码级**判据（不含真实 IndexedDB）；真行为的端到端在浏览器验收里
//   （插一张图 ⇒ 存 ⇒ 刷新 ⇒ 图还在），本文件不冒充它。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assetRefHash, isAssetRef, makeAssetRef } from "./assetRef";

const repo = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(repo, p), "utf8");

describe("附件稳定引用 asst:<hash>", () => {
  it("① 拼/拆/判定是同一套口径", () => {
    expect(makeAssetRef("abc123")).toBe("asst:abc123");
    expect(makeAssetRef("   ")).toBeNull();
    expect(makeAssetRef(null)).toBeNull();
    expect(isAssetRef("asst:abc123")).toBe(true);
    expect(isAssetRef("asst:")).toBe(false);
    expect(isAssetRef("blob:http://x/1")).toBe(false);
    expect(isAssetRef("/home/u/a.png")).toBe(false);
    expect(assetRefHash("asst:abc123")).toBe("abc123");
    expect(assetRefHash("blob:http://x/1")).toBe("");
  });

  it("② web 插图的正文必须写稳定引用；桌面仍写真实路径", () => {
    const cap = read("src/components/MobileCapture.tsx");
    expect(cap, "web 上没改成稳定引用").toMatch(/makeAssetRef\(meta\.hash\)/);
    expect(cap, "桌面分支必须保留 convertFileSrc").toMatch(/platform\.asset\.convertFileSrc\(meta\.path\)/);
    expect(cap, "必须先判平台（否则桌面会拿到 asst: 这种它解析不了的引用）").toMatch(/isDesktopPlatform\(\)/);
  });

  it("③ 渲染时必须解析引用（web 现造对象 URL；桌面原样返回）", () => {
    const read_ = read("src/components/MobileRead.tsx");
    expect(read_, "阅读屏没走 resolveRef").toMatch(/platform\.asset\.resolveRef\(b\.src\)/);
    const web = read("src/lib/platform/web.ts");
    expect(web, "web 的 resolveRef 必须从 blobStore 取字节").toMatch(/resolveRef:[\s\S]{0,600}blobStore\.get\(hash\)/);
    const tauri = read("src/lib/platform/tauri.ts");
    expect(tauri, "桌面 resolveRef 必须原样返回路径").toMatch(/resolveRef:[\s\S]{0,200}src\.startsWith\("asst:"\) \? "" : src/);
  });

  // ⭐ 2026-10-23（owner 实拍：手机 web 导出 → 桌面导入 ⇒ 图片碎图）：
  //   两个洞一起补 —— ① 导出按**正文里的引用**兜附件（page_id 是 null 那批看不见）；
  //   ② 桌面导入把 `asst:<hash>` 落成真实路径（否则编辑器拿它当路径用 ⇒ 碎图）。
  it("④ 导出要按正文引用兜附件 ＋ 导入要把引用落成本机路径", () => {
    const web = read("src/lib/platform/web.ts");
    expect(web, "web 导出没扫正文里的 asst: 引用").toMatch(/matchAll\(\/asst:\(\[0-9a-f\]\{8,128\}\)\/g\)/);
    const rs = read("src-tauri/src/workspace_io.rs");
    expect(rs, "桌面导入没调用改写").toMatch(/rewrite_asset_refs_in_space_db\(&target_db/);
    expect(rs, "找不到字节的引用必须原样保留").toMatch(/rewrite_asst_refs/);
  });
});
