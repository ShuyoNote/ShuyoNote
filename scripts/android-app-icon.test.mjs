// android-app-icon 的判据：**铺得到、幂等、核对会红、缺源/缺工程时报「没验」**。
// 用临时目录造一份"源图标 + gen 工程"，不碰真实仓库（本机没有 gen/android 时也能跑）。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { ICONS_SRC_REL, RES_DEST_REL, listIconFiles, stageAppIcon } from "./android-app-icon.mjs";

const ICON_RELS = [
  join("mipmap-anydpi-v26", "ic_launcher.xml"),
  join("mipmap-xxxhdpi", "ic_launcher.png"),
  join("mipmap-xxxhdpi", "ic_launcher_round.png"),
  join("mipmap-xxxhdpi", "ic_launcher_foreground.png"),
  join("values", "ic_launcher_background.xml"),
];

/** 造一个假仓库：源图标各写一段字节，gen 工程目录（可选）建出来。 */
function fakeRepo({ withDest = true, withSrc = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "app-icon-"));
  if (withSrc) {
    for (const [i, rel] of ICON_RELS.entries()) {
      const p = join(repo, ICONS_SRC_REL, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `icon-${i}-bytes`);
    }
  }
  if (withDest) mkdirSync(join(repo, RES_DEST_REL), { recursive: true });
  return repo;
}

const quiet = { log: () => {}, err: () => {} };

describe("android-app-icon", () => {
  it("把品牌图标铺进 gen 工程（每个文件逐字节相同）", () => {
    const repo = fakeRepo();
    try {
      expect(stageAppIcon({ root: repo, ...quiet })).toBe(0);
      for (const rel of ICON_RELS) {
        const src = readFileSync(join(repo, ICONS_SRC_REL, rel));
        const dest = readFileSync(join(repo, RES_DEST_REL, rel));
        expect(dest.equals(src)).toBe(true);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("幂等：再铺一次不改字节、也不报错", () => {
    const repo = fakeRepo();
    try {
      expect(stageAppIcon({ root: repo, ...quiet })).toBe(0);
      const before = readFileSync(join(repo, RES_DEST_REL, ICON_RELS[1]));
      expect(stageAppIcon({ root: repo, ...quiet })).toBe(0);
      expect(readFileSync(join(repo, RES_DEST_REL, ICON_RELS[1])).equals(before)).toBe(true);
      expect(stageAppIcon({ root: repo, check: true, ...quiet })).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("--check：目标缺文件 ⇒ 红（这正是「还顶着 Tauri 默认图标」的样子）", () => {
    const repo = fakeRepo();
    try {
      expect(stageAppIcon({ root: repo, ...quiet })).toBe(0);
      rmSync(join(repo, RES_DEST_REL, ICON_RELS[1]));
      expect(stageAppIcon({ root: repo, check: true, ...quiet })).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("--check：目标被改成默认图标（字节不同）⇒ 红", () => {
    const repo = fakeRepo();
    try {
      expect(stageAppIcon({ root: repo, ...quiet })).toBe(0);
      writeFileSync(join(repo, RES_DEST_REL, ICON_RELS[1]), "tauri-default-icon");
      expect(stageAppIcon({ root: repo, check: true, ...quiet })).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("源图标目录不存在 ⇒ 2（没验，不是通过）", () => {
    const repo = fakeRepo({ withSrc: false });
    try {
      expect(stageAppIcon({ root: repo, ...quiet })).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("Android 工程不存在 ⇒ 2，并提示先跑 android init", () => {
    const repo = fakeRepo({ withDest: false });
    const lines = [];
    try {
      expect(stageAppIcon({ root: repo, log: () => {}, err: (m) => lines.push(String(m)) })).toBe(2);
      expect(lines.join("\n")).toContain("tauri android init");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("listIconFiles 递归列出源图标（相对路径、稳定排序）", () => {
    const repo = fakeRepo();
    try {
      const files = listIconFiles(join(repo, ICONS_SRC_REL));
      expect(files).toHaveLength(ICON_RELS.length);
      expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)));
      expect(files.some((f) => f.includes("mipmap-anydpi-v26"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("真实仓库上跑 --check 不该是「没验」（2）—— 源图标确实入库了", () => {
    // 只看源那一半：本机没 init 过 gen/android 时允许 2（"先跑 init"），但**不许**因为源缺失而 2。
    const r = stageAppIcon({ check: true, log: () => {}, err: () => {} });
    expect([0, 1, 2]).toContain(r);
    expect(existsSync(join(process.cwd(), ICONS_SRC_REL))).toBe(true);
  });
});
