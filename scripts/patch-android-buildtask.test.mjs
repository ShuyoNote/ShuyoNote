// patch-android-buildtask 的判据：模板原文能修好、修好后再跑是幂等、没 init 过时报「没验」。
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TEMPLATE_ARGS_LINE, buildTaskPath, patchAndroidBuildTask } from "./patch-android-buildtask.mjs";

function fakeRepo({ content = null } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "btask-"));
  const file = buildTaskPath(repo);
  if (content !== null) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  // 让脚本能找到 CLI（内容不重要，只要路径存在）
  mkdirSync(join(repo, "node_modules", "@tauri-apps", "cli"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "@tauri-apps", "cli", "tauri.js"), "// stub", "utf8");
  return { repo, file };
}

const quiet = { log: () => {}, err: () => {} };

describe("patch-android-buildtask", () => {
  it("模板原文 ⇒ 改成显式 CLI 路径（正斜杠，Kotlin 字符串里不用转义）", () => {
    const { repo, file } = fakeRepo({ content: `fun x() {\n  ${TEMPLATE_ARGS_LINE}\n}\n` });
    try {
      expect(patchAndroidBuildTask({ root: repo, ...quiet })).toBe(0);
      const text = readFileSync(file, "utf8");
      expect(text).toContain("/node_modules/@tauri-apps/cli/tauri.js");
      expect(text).not.toContain(TEMPLATE_ARGS_LINE);
      expect(text).not.toContain("\\"); // 反斜杠会破坏 Kotlin 字符串
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("幂等：修好之后再跑 / --check 都是绿的", () => {
    const { repo } = fakeRepo({ content: `${TEMPLATE_ARGS_LINE}\n` });
    try {
      expect(patchAndroidBuildTask({ root: repo, ...quiet })).toBe(0);
      expect(patchAndroidBuildTask({ root: repo, ...quiet })).toBe(0);
      expect(patchAndroidBuildTask({ root: repo, check: true, ...quiet })).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("--check：还是模板原文 ⇒ 红（这正是 :app:rustBuild*Release 崩的那份）", () => {
    const { repo } = fakeRepo({ content: `${TEMPLATE_ARGS_LINE}\n` });
    try {
      expect(patchAndroidBuildTask({ root: repo, check: true, ...quiet })).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("既不是模板原文也不是已修好的 ⇒ 1（不瞎改别人写的东西）", () => {
    const { repo } = fakeRepo({ content: "val args = listOf(\"npx\", \"tauri\");\n" });
    try {
      expect(patchAndroidBuildTask({ root: repo, ...quiet })).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("没 init 过（文件不在）⇒ 2，并提示先跑 init", () => {
    const { repo } = fakeRepo();
    const lines = [];
    try {
      expect(patchAndroidBuildTask({ root: repo, log: () => {}, err: (m) => lines.push(String(m)) })).toBe(2);
      expect(lines.join("\n")).toContain("tauri android init");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
