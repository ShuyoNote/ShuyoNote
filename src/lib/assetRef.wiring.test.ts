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
  //   三个洞一起补 —— ① 导出按**正文里的引用**兜附件（page_id 是 null 那批看不见）；
  //   ② 桌面导入把 `asst:<hash>` 落成真实路径（否则编辑器拿它当路径用 ⇒ 碎图）；
  //   ③ **修复前**的老图正文里只有一次性 `blob:`（没有 hash）⇒ 只能按**文件名**反查。
  it("④ 导出按正文引用兜附件 ＋ 导入按 hash 或文件名落成本机路径", () => {
    const web = read("src/lib/platform/web.ts");
    // ⭐ 2026-10-24：列名**收口进内容层**了 —— 导出不再直写 `SELECT content_json …`，
    //   改成 `pageDocJsonInSpace(store, ws.id)`（`src/lib/docContent.ts` 那一层）。
    //   判据跟着改到这里（否则这条会一直红：它守的是"扫正文用的是那一层、且没写错列名"）：
    expect(web, "导出扫正文必须经内容层（pageDocJsonInSpace），别在这层直写列名").toMatch(
      /pageDocJsonInSpace\(store, ws\.id\)/,
    );
    expect(web, "导出没按正文里的 asst: 引用兜附件").toMatch(/matchAll\(\/asst:\(\[0-9a-f\]\{8,128\}\)\/g\)/);
    expect(web, "导出没按文件名兜老图（blob: 那批）").toMatch(/byName\.get\(alt\)/);
    expect(web, "扫失败不许静默").toMatch(/\[export\] 正文里的附件引用没扫成功/);
    const rs = read("src-tauri/src/workspace_io.rs");
    expect(rs, "桌面导入没调用改写").toMatch(/rewrite_asset_refs_in_space_db\(&target_db/);
    // ⭐ 2026-10-24：直写列名已收口进内容层（`doc_content::list_pages_with_images` / `write_page_doc_json`），
    //   判据跟着改成"必须经那一层"（否则这条会一直红，而它守的东西没丢）。
    expect(rs, "导入改写必须经内容层读正文（list_pages_with_images）").toMatch(
      /doc_content::list_pages_with_images\(&conn\)/,
    );
    expect(rs, "导入改写必须经内容层写回（write_page_doc_json）").toMatch(
      /doc_content::write_page_doc_json\(&conn/,
    );
    expect(rs, "导入没按文件名兜老图").toMatch(/rewrite_image_srcs/);
    expect(rs, "按名字反查要真去查附件表").toMatch(/SELECT name, hash FROM attachments/);
  });
});
