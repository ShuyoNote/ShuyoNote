// android-app-name 的判据：**改得到、幂等、核对会红、缺文件/缺字符串时报「没验/没形状」**。
// 用临时目录造一份"gen 工程里的 strings.xml"，不碰真实仓库（本机没 init 过 gen/android 也能跑）。
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { APP_NAME, NAME_KEYS, STRINGS_REL, setNameInStrings, stageAppName } from "./android-app-name.mjs";

/** `tauri android init` 写出来的形状（4 空格缩进 + **值带一对字面引号** + 另一个无关字符串）。 */
const TAURI_XML = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">"ShuyoNote"</string>
    <string name="main_activity_title">"ShuyoNote"</string>
    <string name="other_key">"别动我"</string>
</resources>
`;

/** 造一个假仓库：只建 strings.xml（可选）。 */
function fakeRepo({ xml = TAURI_XML, withFile = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "app-name-"));
  if (withFile) {
    const p = join(repo, STRINGS_REL);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, xml, "utf8");
  }
  return repo;
}

const quiet = { log: () => {}, err: () => {} };
const read = (repo) => readFileSync(join(repo, STRINGS_REL), "utf8");

describe("android-app-name", () => {
  it("把显示名写进 strings.xml（两条都改，别的字符串不动，仍带字面引号）", () => {
    const repo = fakeRepo();
    try {
      expect(stageAppName({ root: repo, ...quiet })).toBe(0);
      const xml = read(repo);
      expect(xml).toContain(`<string name="app_name">"${APP_NAME}"</string>`);
      expect(xml).toContain(`<string name="main_activity_title">"${APP_NAME}"</string>`);
      // 无关字符串一个字节都没动（别顺手重写别人的节点）
      expect(xml).toContain('<string name="other_key">"别动我"</string>');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("幂等：再跑一次不改字节，且 --check 通过（0）", () => {
    const repo = fakeRepo();
    try {
      expect(stageAppName({ root: repo, ...quiet })).toBe(0);
      const before = read(repo);
      expect(stageAppName({ root: repo, ...quiet })).toBe(0);
      expect(read(repo)).toBe(before);
      expect(stageAppName({ root: repo, check: true, ...quiet })).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("--check：还是 `tauri init` 写的 productName ⇒ 红（这正是「名字没跟上」的样子）", () => {
    const repo = fakeRepo();
    try {
      expect(stageAppName({ root: repo, check: true, ...quiet })).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("★ --check：**只改了一半**（app_name 对、main_activity_title 还是旧值）⇒ 红", () => {
    // 这条防的是"看起来改了"：手工在 gen/ 里只改一处，或脚本只替换第一次匹配，
    // 结果图标下的名字对了、任务标题还是英文 —— 外部看不出来，门禁必须抓住。
    const half = TAURI_XML.replace(
      '<string name="app_name">"ShuyoNote"</string>',
      `<string name="app_name">"${APP_NAME}"</string>`,
    );
    const repo = fakeRepo({ xml: half });
    try {
      expect(stageAppName({ root: repo, check: true, ...quiet })).toBe(1);
      expect(stageAppName({ root: repo, ...quiet })).toBe(0); // 跑一次就补齐
      expect(stageAppName({ root: repo, check: true, ...quiet })).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("缺 strings.xml ⇒ 2（没验，不是通过），并提示先跑 `tauri android init`", () => {
    const repo = fakeRepo({ withFile: false });
    const lines = [];
    try {
      expect(stageAppName({ root: repo, log: () => {}, err: (m) => lines.push(String(m)) })).toBe(2);
      expect(lines.join("\n")).toContain("tauri android init");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("strings.xml 里缺 app_name / main_activity_title ⇒ 1（报缺了哪个，不静默过）", () => {
    const repo = fakeRepo({ xml: '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n' });
    const lines = [];
    try {
      expect(stageAppName({ root: repo, log: () => {}, err: (m) => lines.push(String(m)) })).toBe(1);
      const msg = lines.join("\n");
      for (const k of NAME_KEYS) expect(msg).toContain(k);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("纯函数：值里的 `$`/`&` 不被替换语义吃掉（用切片拼，不用 replace 的 $ 语义）", () => {
    const tricky = "A$&B\\C";
    const { xml, changed, missing } = setNameInStrings(TAURI_XML, tricky);
    expect(missing).toEqual([]);
    expect(changed).toBe(true);
    expect(xml).toContain(`<string name="app_name">"${tricky}"</string>`);
    expect(xml).toContain(`<string name="main_activity_title">"${tricky}"</string>`);
  });

  it("钉住口径：APP_NAME 就是软著全称（改它就是改备案/商店名，必须是有意的）", () => {
    expect(APP_NAME).toBe("ShuyoNote 数友笔记");
  });

  it("真实仓库上跑 --check 不该因为「形状缺失」而红（只有缺 gen/android 时才允许 2）", () => {
    const hasGen = existsSync(join(process.cwd(), "src-tauri", "gen", "android"));
    const r = stageAppName({ check: true, log: () => {}, err: () => {} });
    expect([0, 1, 2]).toContain(r);
    if (hasGen) expect(r).not.toBe(2);
  });
});
