// scripts/check-linux-bundle.mjs 的单测。
//
// 这里最关键的一条是**位置**判据（`isResourceDirLibPath`）：Linux 的库不在 exe 同目录，
// 而 `library_dir()` 只探"资源目录根"。库被映射到深一层（例如 `…/<id>/resources/libpdfium.so`）
// 时，deb 里**确实有** `libpdfium.so`、`dpkg-deb -c` 也看得到 —— 只有位置判据能抓住它，
// 而它的失败面是"用户装完开 PDF 报找不到库"。所以正反两向都钉住。

import { describe, expect, it } from "vitest";
import { checkLinuxBundle, isResourceDirLibPath, parseDpkgDebList, PDFIUM_LIB } from "./check-linux-bundle.mjs";

const OK = {
  debNames: ["ShuyoNote_1.91.5_amd64.deb"],
  libPathsInDeb: ["./usr/lib/ShuyoNote/libpdfium.so"],
  pdfiumDebSha: "a".repeat(64),
  pdfiumVendorSha: "a".repeat(64),
  pdfiumVendorExists: true,
};

describe("isResourceDirLibPath（资源目录**根**那一层）", () => {
  it("接受 usr/lib/<一段>/libpdfium.so", () => {
    expect(isResourceDirLibPath("./usr/lib/ShuyoNote/libpdfium.so")).toBe(true);
    expect(isResourceDirLibPath("usr/lib/cn.shuyo.shuyonote/libpdfium.so")).toBe(true);
  });

  it("接受 AppImage 展开目录里的同一条路径（squashfs 根名不算一层）", () => {
    // 2026-09-19 的 CI 假红就是这条：`--appimage-extract` 展开后第一段是 `squashfs-root`，
    // 库其实在正确位置，却被判成"位置不对"。
    expect(isResourceDirLibPath("./squashfs-root/usr/lib/ShuyoNote/libpdfium.so")).toBe(true);
    expect(isResourceDirLibPath("squashfs-root/usr/lib/cn.shuyo.shuyonote/libpdfium.so")).toBe(true);
    // 但深一层仍然要拒（摘掉 squashfs 根之后剩 5 段）
    expect(isResourceDirLibPath("./squashfs-root/usr/lib/ShuyoNote/resources/libpdfium.so")).toBe(false);
  });

  it("拒绝深一层（这正是会漏掉的那种错）", () => {
    expect(isResourceDirLibPath("./usr/lib/ShuyoNote/resources/libpdfium.so")).toBe(false);
    expect(isResourceDirLibPath("./usr/lib/ShuyoNote/bin/libpdfium.so")).toBe(false);
  });

  it("拒绝不在 /usr/lib/<一段>/ 下的库", () => {
    expect(isResourceDirLibPath("./usr/lib/libpdfium.so")).toBe(false);
    expect(isResourceDirLibPath("./usr/share/ShuyoNote/libpdfium.so")).toBe(false);
    expect(isResourceDirLibPath("./opt/ShuyoNote/libpdfium.so")).toBe(false);
    expect(isResourceDirLibPath("./usr/lib/ShuyoNote/libpdfium.so.1")).toBe(false);
  });
});

describe("checkLinuxBundle", () => {
  it("正常产物没有意见", () => {
    expect(checkLinuxBundle(OK)).toEqual([]);
  });

  it("没有 deb ⇒ 报出来（Linux 档的发布产物没了）", () => {
    const p = checkLinuxBundle({ ...OK, debNames: [] });
    expect(p.join("\n")).toMatch(/没有找到 deb 产物/);
  });

  it("deb 里没有库 ⇒ 报出来（用户开 PDF 会报找不到动态库）", () => {
    const p = checkLinuxBundle({ ...OK, libPathsInDeb: [] });
    expect(p.join("\n")).toMatch(/不在 deb 里/);
  });

  it("★ 库在子目录里 ⇒ **必须红**（有库但探不到）", () => {
    const p = checkLinuxBundle({ ...OK, libPathsInDeb: ["./usr/lib/ShuyoNote/resources/libpdfium.so"] });
    expect(p.join("\n")).toMatch(/位置不对/);
  });

  it("包里那份与 vendor 源 sha256 不一致 ⇒ 报出来", () => {
    const p = checkLinuxBundle({ ...OK, pdfiumDebSha: "b".repeat(64) });
    expect(p.join("\n")).toMatch(/sha256 不一致/);
  });

  it("vendor 里没有库 ⇒ 说是**前置缺失**，不要误报成产物问题", () => {
    const p = checkLinuxBundle({ ...OK, pdfiumVendorExists: false });
    expect(p.join("\n")).toMatch(/前置缺失/);
  });

  it("AppImage 在但读不到 ⇒ 要求如实报「没验过」，不许当通过", () => {
    const p = checkLinuxBundle({ ...OK, appImageNames: ["ShuyoNote_1.91.5_amd64.AppImage"], libPathsInAppImage: null });
    expect(p.join("\n")).toMatch(/没验过/);
  });

  it("AppImage 里库缺失或位置不对 ⇒ 同样红", () => {
    const img = ["ShuyoNote_1.91.5_amd64.AppImage"];
    expect(checkLinuxBundle({ ...OK, appImageNames: img, libPathsInAppImage: [] }).join("\n")).toMatch(/不在 AppImage 里/);
    expect(
      checkLinuxBundle({ ...OK, appImageNames: img, libPathsInAppImage: ["./usr/lib/ShuyoNote/x/libpdfium.so"] }).join("\n"),
    ).toMatch(/位置不对/);
  });
});

describe("parseDpkgDebList", () => {
  it("★ dpkg 1.22 的输出**不带 `./` 前缀**也要认（2026-09-19 CI 假红的根因）", () => {
    // 真实输出（dpkg-deb 1.22.6，2026-09-19 在本机 WSL 实测）：
    const out = [
      "-rwxr-xr-x 0/0         7645184 2026-09-19 13:20 usr/lib/ShuyoNote/libpdfium.so",
      "-rwxr-xr-x 0/0        63857120 2026-09-19 13:20 usr/bin/shuyonote",
    ].join("\n");
    expect(parseDpkgDebList(out)).toEqual(["usr/lib/ShuyoNote/libpdfium.so", "usr/bin/shuyonote"]);
    expect(isResourceDirLibPath("usr/lib/ShuyoNote/libpdfium.so")).toBe(true);
    // 整条断言要因此**变绿** —— 而不是把"解析不出路径"报成"包里没有库"
    expect(checkLinuxBundle({ ...OK, libPathsInDeb: ["usr/lib/ShuyoNote/libpdfium.so"] })).toEqual([]);
  });

  it("从 dpkg-deb -c 的真实输出里取出路径", () => {
    const out = [
      "drwxr-xr-x root/root         0 2026-09-19 11:00 ./",
      "drwxr-xr-x root/root         0 2026-09-19 11:00 ./usr/",
      "drwxr-xr-x root/root         0 2026-09-19 11:00 ./usr/lib/",
      "drwxr-xr-x root/root         0 2026-09-19 11:00 ./usr/lib/ShuyoNote/",
      "-rw-r--r-- root/root   7645184 2026-09-19 11:00 ./usr/lib/ShuyoNote/libpdfium.so",
      "-rwxr-xr-x root/root  12345678 2026-09-19 11:00 ./usr/bin/shuyonote",
    ].join("\n");
    expect(parseDpkgDebList(out)).toEqual([
      "./",
      "./usr/",
      "./usr/lib/",
      "./usr/lib/ShuyoNote/",
      `./usr/lib/ShuyoNote/${PDFIUM_LIB}`,
      "./usr/bin/shuyonote",
    ]);
  });
});
