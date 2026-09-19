// scripts/check-linux-bundle.mjs 的单测。
//
// 这里最关键的是两组判据：
//   · **位置**（`isResourceDirLibPath`）：Linux 的库不在 exe 同目录，而 `library_dir()` 只探
//     "资源目录根"。库被映射到深一层（例如 `…/<id>/resources/libpdfium.so`）时，deb 里**确实有**
//     `libpdfium.so`、`dpkg-deb -c` 也看得到 —— 只有位置判据能抓住它，而它的失败面是
//     "用户装完开 PDF 报找不到库"。所以正反两向都钉住。
//   · **AppImage 的结构比对**（`comparePdfiumLibs`）：字节一致在 AppImage 里**做不到**
//     （linuxdeploy 无条件给每个 ELF 打 `RUNPATH=$ORIGIN`，见 .mjs 顶部订正），
//     于是判据改成"只差一个 runpath，其余全同"。这里把**能被接受的那一种差异**和
//     **必须咬住的几种损坏**（strip / 截断 / 换库 / 别处来的 runpath）都钉住。

import { describe, expect, it } from "vitest";
import {
  APPIMAGE_SIZE_SLACK_BYTES,
  checkLinuxBundle,
  comparePdfiumLibs,
  dynamicSectionRunpath,
  isResourceDirLibPath,
  normalizeDynamicSection,
  parseDpkgDebList,
  parseDynSyms,
  parseSectionNames,
  PDFIUM_LIB,
} from "./check-linux-bundle.mjs";

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

// ---------- AppImage：为什么字节一致做不到，以及"只差一个 runpath"怎么钉 ----------

/** vendor 那份（无 RUNPATH）。 */
const VENDOR_DYN = [
  "Dynamic section at offset 0x23f4a8 contains 31 entries:",
  "  Tag        Type                         Name/Value",
  " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
  " 0x000000000000000e (SONAME)             Library soname: [libpdfium.so]",
  " 0x000000000000000a (STRSZ)              16168 (bytes)",
  " 0x000000000000000c (INIT)               0x2f31000",
  " 0x000000000000001b (INIT_ARRAYSZ)       16 (bytes)",
].join("\n");

/** 包里那份：多一条 `RUNPATH=$ORIGIN`，`.dynstr` 因此大 8 字节（实测形状）。 */
const PACKAGED_DYN = [
  "Dynamic section at offset 0x245000 contains 32 entries:",
  "  Tag        Type                         Name/Value",
  " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
  " 0x000000000000000e (SONAME)             Library soname: [libpdfium.so]",
  " 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN]",
  " 0x000000000000000a (STRSZ)              16176 (bytes)",
  " 0x000000000000000c (INIT)               0x2f31000",
  " 0x000000000000001b (INIT_ARRAYSZ)       16 (bytes)",
].join("\n");

const syms = (names) =>
  [
    `Symbol table '.dynsym' contains ${names.length} entries:`,
    "   Num:    Value          Size Type    Bind   Vis      Ndx Name",
    ...names.map((n, i) => `     ${i}: 0000000000000000     0 FUNC    GLOBAL DEFAULT   12 ${n}`),
  ].join("\n");

const sections = (names) =>
  [
    `There are ${names.length + 1} section headers, starting at offset 0x23f4a8:`,
    "",
    "Section Headers:",
    "  [Nr] Name              Type            Address          Off    Size   ES Flg Lk Inf Al",
    "  [ 0]                   NULL            0000000000000000 000000 000000 00      0   0  0",
    ...names.map(
      (n, i) =>
        `  [${String(i + 1).padStart(2)}] ${n.padEnd(17)} PROGBITS        0000000000000000 000000 000010 00   A  0   0  1`,
    ),
  ].join("\n");

const REAL_SYMS = ["FPDF_InitLibraryWithConfig", "FPDF_LoadDocument"];
const REAL_SECTIONS = [".dynsym", ".dynstr", ".symtab", ".text"];

describe("normalizeDynamicSection / dynamicSectionRunpath", () => {
  it("抹掉地址、长度、条数，只留「条目种类 + 字符串值」", () => {
    expect(normalizeDynamicSection(VENDOR_DYN)).toEqual([
      "INIT #",
      "INIT_ARRAYSZ # (bytes)",
      "NEEDED Shared library: [libc.so.6]",
      "SONAME Library soname: [libpdfium.so]",
      "STRSZ # (bytes)",
    ]);
  });

  it("能取出 RUNPATH 的值（没有就是空串）", () => {
    expect(dynamicSectionRunpath(normalizeDynamicSection(PACKAGED_DYN))).toBe("$ORIGIN");
    expect(dynamicSectionRunpath(normalizeDynamicSection(VENDOR_DYN))).toBe("");
  });
});

describe("parseDynSyms / parseSectionNames", () => {
  it("动态符号取「名字|类型|绑定|大小」，不取地址（patchelf 会搬段）", () => {
    expect(parseDynSyms(syms(REAL_SYMS))).toEqual([
      "FPDF_InitLibraryWithConfig|FUNC|GLOBAL|0",
      "FPDF_LoadDocument|FUNC|GLOBAL|0",
    ]);
  });

  it("段名只收以 `.` 开头的（`[ 0]` 那条空名字会把 NULL 读成名字）", () => {
    expect([...parseSectionNames(sections([".dynsym", ".symtab"]))]).toEqual([".dynsym", ".symtab"]);
  });
});

describe("comparePdfiumLibs（AppImage 那条判据的核心）", () => {
  const vendor = {
    vendorDynamic: VENDOR_DYN,
    vendorDynSyms: parseDynSyms(syms(REAL_SYMS)),
    vendorSections: parseSectionNames(sections(REAL_SECTIONS)),
    vendorSize: 7645184,
  };
  const packaged = {
    packagedDynamic: PACKAGED_DYN,
    packagedDynSyms: parseDynSyms(syms(REAL_SYMS)),
    packagedSections: parseSectionNames(sections(REAL_SECTIONS)),
    packagedSize: 7664592,
  };

  it("★ 接受「源 + 一个 $ORIGIN 的 RUNPATH」（1.91.8 的 CI 红就是这个形状，而它是**正常产物**）", () => {
    const r = comparePdfiumLibs({ ...vendor, ...packaged });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.runpath).toBe("$ORIGIN");
    expect(r.facts.join(" ")).toMatch(/动态符号 2\/2/);
  });

  it("★ 少了源那份的段（strip 搬走 .symtab）⇒ 必须红", () => {
    const r = comparePdfiumLibs({
      ...vendor,
      ...packaged,
      packagedSections: parseSectionNames(sections([".dynsym", ".dynstr", ".text"])),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/少了源那份的段/);
  });

  it("★ 比源小 ⇒ 必须红（strip/截断都会变小）", () => {
    const r = comparePdfiumLibs({ ...vendor, ...packaged, packagedSize: 6501712 }); // 实测 strip 后的大小
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/比源小/);
  });

  it("比源大太多 ⇒ 必须红（不是「只补了个 rpath」）", () => {
    const r = comparePdfiumLibs({ ...vendor, ...packaged, packagedSize: 7645184 + APPIMAGE_SIZE_SLACK_BYTES + 1 });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/比源大太多/);
  });

  it("★ 动态符号集不同 ⇒ 必须红（这已经不是同一个库的 ABI）", () => {
    const r = comparePdfiumLibs({
      ...vendor,
      ...packaged,
      packagedDynSyms: parseDynSyms(syms(["FPDF_InitLibraryWithConfig", "FPDF_LoadPage"])),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/动态符号集/);
  });

  it("动态符号条数不同 ⇒ 必须红", () => {
    const r = comparePdfiumLibs({ ...vendor, ...packaged, packagedDynSyms: parseDynSyms(syms(["FPDF_LoadDocument"])) });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/动态符号条数/);
  });

  it("多了 RUNPATH **之外**的动态表条目 ⇒ 必须红", () => {
    const r = comparePdfiumLibs({
      ...vendor,
      ...packaged,
      packagedDynamic: PACKAGED_DYN.replace(
        " 0x000000000000001b (INIT_ARRAYSZ)       16 (bytes)",
        " 0x000000000000001b (INIT_ARRAYSZ)       16 (bytes)\n 0x0000000000000001 (NEEDED)             Shared library: [libz.so.1]",
      ),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/动态表/);
  });

  it("RUNPATH 不是 $ORIGIN ⇒ 必须红（那是「库打算从别处找依赖」，不是 linuxdeploy 的那一手）", () => {
    const r = comparePdfiumLibs({
      ...vendor,
      ...packaged,
      packagedDynamic: PACKAGED_DYN.replace("[$ORIGIN]", "[/usr/lib]"),
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/RUNPATH 不是允许的形态/);
  });
});

describe("checkLinuxBundle × AppImage 的 sha256 与结构比对", () => {
  const img = ["ShuyoNote_1.91.8_amd64.AppImage"];
  const base = {
    ...OK,
    appImageNames: img,
    libPathsInAppImage: ["./squashfs-root/usr/lib/ShuyoNote/libpdfium.so"],
    pdfiumAppImageSha: "b".repeat(64),
    pdfiumVendorSha: "a".repeat(64),
  };

  it("sha 不同但结构比对通过 ⇒ 没有意见（这就是 1.91.8 之后的期望形态）", () => {
    expect(checkLinuxBundle({ ...base, appImageCompare: { ok: true, problems: [], facts: [], runpath: "$ORIGIN" } })).toEqual([]);
  });

  it("结构比对没过 ⇒ 红，并把结构问题原样带出来", () => {
    const p = checkLinuxBundle({
      ...base,
      appImageCompare: { ok: false, problems: ["段少了 .symtab"], facts: [], runpath: "" },
    });
    expect(p.join("\n")).toMatch(/结构\*\*对不上|结构.*对不上/);
    expect(p.join("\n")).toMatch(/段少了 \.symtab/);
  });

  it("sha 不同而结构比对**没做**（readelf 不可用）⇒ 要求如实说「没验过」", () => {
    const p = checkLinuxBundle({ ...base, appImageCompare: null });
    expect(p.join("\n")).toMatch(/没验过/);
    expect(p.join("\n")).toMatch(/不是\*\*strip|不是.*strip/);
  });

  it("sha 相同 ⇒ 不做结构比对也算通过", () => {
    expect(checkLinuxBundle({ ...base, pdfiumAppImageSha: "a".repeat(64), appImageCompare: null })).toEqual([]);
  });
});
