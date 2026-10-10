// 「加密空间要有特殊标识」· 判据 —— owner 2026-10-10 发空间切换器截图 ＋ 逐字要求：
// 「**加密空间要做个特殊标识**」。
//
// 现状（owner 截图逐字）：6 个空间**全部**写着「仅本机」—— 那是**同步状态**那一格，
// 与"加不加密"是**两件事** ⇒ 界面上完全看不出哪个是加密的 ✗ ⇒ 本笔补那个标识 ✓。
//
// ⚠️ 三条口径（缺一条都不算交付）：
//   ① **不许只靠颜色** ✗（色弱用户看不到）⇒ 标识里必须有**文字** ✓；
//   ② 语义要说准：`encrypted_on_disk` ＝ **"这个空间的库在磁盘上是密文"** ——
//      ⛔ 不许写成"安全"／"别人看不到" ✗，也 ⛔ 不许把 `in_keyring`／`key_available` 揉进来 ✗；
//   ③ **读数拿不到 ⇒ 如实不显示** ✓（⛔ 不许当成"明文" ✗）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { spaceCryptoBadge } from "./spaceSecurity";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("加密标识 · 映射（唯一一处）", () => {
  it("a) 加密空间 ⇒ 显示，且标识里是**文字**（⛔ 不许只靠颜色）", () => {
    const b = spaceCryptoBadge(true);
    expect(b.show, "加密空间没有标识 ⇒ owner 那条要求没落地").toBe(true);
    expect(b.state).toBe("encrypted");
    expect(b.label, "标识必须有文字（⛔ 只靠颜色对色弱用户等于没有）").toMatch(/\S/);
    expect(b.label).toBe("已加密");
    expect(b.title, "悬停/读屏那句话也要在").toMatch(/\S/);
  });

  it("b) **反向**：明文空间 ⇒ **不显示**（⛔ 不许「所有空间都带标识」—— 那等于没标识）", () => {
    const b = spaceCryptoBadge(false);
    expect(b.show, "明文空间也带标识 ⇒ 标识就没信息量了").toBe(false);
    expect(b.state).toBe("plaintext");
    expect(b.label).toBe("");
  });

  it("c) **反向**：读数拿不到 ⇒ 不显示，且**不许**当成「明文」", () => {
    for (const missing of [undefined, null]) {
      const b = spaceCryptoBadge(missing);
      expect(b.show, "读不到却显示了标识").toBe(false);
      // ⭐ 这条是本判据的重点：`unknown` 与 `plaintext` **必须分得开** ✗
      expect(b.state, "读不到被当成了「确认是明文」").toBe("unknown");
      expect(b.state).not.toBe("plaintext");
    }
  });

  it("形状坏了（字符串／数字）也按 `unknown` 走（fail-closed：宁可不显示）", () => {
    for (const junk of ["true", 1, {}, [] as unknown]) {
      const b = spaceCryptoBadge(junk as unknown as boolean);
      expect(b.show).toBe(false);
      expect(b.state).toBe("unknown");
    }
  });

  it("② 语义要说准：⛔ 不许把「磁盘上是密文」写成「安全」／「别人看不到」，也不许揉进钥匙那两格", () => {
    const b = spaceCryptoBadge(true);
    const words = `${b.label} ${b.title}`;
    for (const bad of ["安全", "别人", "看不到", "看不到", "钥匙", "keyring", "key_available", "已解锁", "已锁定"]) {
      expect(words, `标识里出现了不该有的话：「${bad}」`).not.toContain(bad);
    }
    // 而**该说**的那件事要在（可核的那一件事 ✓）
    expect(b.title).toContain("磁盘");
  });
});

describe("加密标识 · 接线（侧栏空间切换器那一行）", () => {
  const pageTree = read("src/components/PageTree.tsx");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const pageTreeCode = code(pageTree);

  it("d) 切换器那一行真的渲染它（⛔ 不是只写了个没人用的纯函数 ✗）", () => {
    expect(pageTreeCode, "没 import 那处映射").toContain('from "../lib/spaceSecurity"');
    expect(pageTreeCode, "没有真的调它").toContain("spaceCryptoBadge(");
    // ⚠️ 文案只有一处：页面里⛔ 不许写死那个 label ✗（写死了就等于把映射抄了第二份）
    expect(pageTreeCode, "页面里写死了标识文字（映射应当只有一处）").not.toContain("已加密");
  });

  it("d) **两处一致**：侧栏切换器 ＋ 设置-空间都走**同一处**映射（⛔ 不许各自判／各自写文案 ✗）", () => {
    const settings = code(read("src/components/SettingsDialog.tsx"));
    for (const [who, src] of [
      ["PageTree", pageTreeCode],
      ["SettingsDialog", settings],
    ] as const) {
      expect(src, `${who} 没走那处映射（＝各自判一遍 ⇒ 两处迟早不一致）`).toContain("spaceCryptoBadge(");
      // ⚠️ 判据只钉"**渲染出来的字来自那处映射**" ✓ —— ⛔ 不用"页面里不许出现「已加密」"那种钝刀 ✗：
      //    设置面板里「已加密 · 已锁定」是**会话锁**那件事（另一回事 ✓），钝刀会误伤它 ✓。
      expect(src, `${who} 自己写死了标识文字（＝第二份文案 ⇒ 两处会漂）`).toMatch(/\{crypto\.label\}/);
    }
  });

  it("⛔ 不许只靠颜色 ＋ 两个落点的样式**写在同一条规则里**（分开写就会各自漂）", () => {
    // ⚠️ 标识是**文字**（`label` ✓），但**样式**也不能退化成"只有颜色" ✗（色弱用户看不到 ✓）。
    const css = read("src/App.css");
    const at = css.indexOf(".space-item-crypto");
    expect(at, "侧栏那个标识没有任何样式").toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf("}", at));
    expect(block, "设置那一个没跟它写在同一条规则里 ⇒ 两处会各自漂").toContain(".set-space-crypto");
    expect(block, "样式只有颜色 ⇒ 色弱用户看不到").toMatch(/border|background|padding|outline/);
  });

  it("④ 回归：「仅本机／已同步」那一格**一个字不许变**（owner 没要求动它）", () => {
    expect(pageTreeCode, "同步状态那一格被动了").toContain("仅本机");
    // ⭐ 与 `task-22` 那条（个人空间不显示服务器点）也不许打架：那条规则仍在岗 ✓
    expect(pageTreeCode, "task-22 那条规则被弄掉了").toContain("showsServerTag(");
  });
});

describe("加密标识 · 数据流（这一格读数真的是从内核来的吗）", () => {
  const models = read("src-tauri/src/models.rs");
  const workspaces = read("src-tauri/src/workspaces.rs");
  const io = read("src-tauri/src/workspace_io.rs");
  const security = read("src-tauri/src/security.rs");

  it("① Rust 侧：字段是**三态**（`Option<bool>` ⇒ 读得到 / 确认明文 / 读不到 分得开）", () => {
    expect(models, "Rust `WorkspaceMeta` 没有 encrypted_on_disk").toMatch(
      /pub encrypted_on_disk: Option<bool>/,
    );
    expect(models, "缺 `#[serde(default)]` ⇒ 老形状会反序列化失败").toMatch(
      /#\[serde\(default\)\]\s*pub encrypted_on_disk: Option<bool>/,
    );
  });

  it("② 判定规则**只有一处**：`space_db_is_encrypted`（列清单里不许出现它 ✗）", () => {
    expect(security, "那条判定不在 security.rs 了？").toContain("pub fn space_db_is_encrypted(");
    // ⚠️ 它**不是** `meta.workspaces` 的列（是文件系统上的事实）⇒ ⛔ 不许进 WS_COLS ✗
    const cols = /const WS_COLS: &str = "([^"]+)"/.exec(workspaces)?.[1] ?? "";
    expect(cols.split(","), "`encrypted_on_disk` 不是列，不许塞进 WS_COLS").not.toContain("encrypted_on_disk");
    // 两处**调用**（list_workspaces 那条路 ＋ overview 那条路）同一判定 ✓
    const calls = (workspaces.match(/space_db_is_encrypted\(/g) ?? []).length;
    expect(calls, "`row_to_meta` 里没有算这一格").toBeGreaterThanOrEqual(1);
    expect(io, "导入空间那条路没有算这一格（那边刚把库标成加密 ⇒ 必须真嗅）").toContain(
      "space_db_is_encrypted(",
    );
  });

  it("⭐ 回归：**走 `row_to_meta` 的每一条 SELECT 都必须带 `kind`**（钉住那条 7 列的漏网之鱼）", () => {
    // 2026-10-10 实测：加 `kind` 那一笔漏了 `create_workspace` 里那条（只有 7 列）✗ ⇒
    // 它走 `row_to_meta`、那一头读第 8 列 ⇒ **运行期** `Invalid column index` ⇒「新建空间」直接报错 ✗
    // —— 而 `cargo check` **看不见列清单**（只看得见"构造点缺字段"）⇒ 编译器与全部测试都不红 ✓。
    // ⇒ 这条判据把"列清单要与映射同步"钉在**文本**上 ✓。
    const selects = [...workspaces.matchAll(/SELECT ([^"]+?) FROM meta\.workspaces/g)].map((m) => m[1]);
    // ⚠️ 逐字列清单那几条（含 `sort_order` 的）；`list_workspaces` 那条写的是 `{WS_COLS}` ⇒ 单独核 ✓
    const rowToMetaFeeds = selects.filter((s) => s.includes("sort_order"));
    expect(rowToMetaFeeds.length, "没找到喂给 row_to_meta 的那几条逐字 SELECT（结构变了？）").toBeGreaterThanOrEqual(1);
    for (const s of rowToMetaFeeds) {
      expect(
        s.split(",").map((x) => x.trim()),
        `这条逐字 SELECT 缺 kind ⇒ 运行期 Invalid column index：${s}`,
      ).toContain("kind");
    }
    // 而 `list_workspaces` 那条走 `{WS_COLS}` ⇒ 核 `WS_COLS` 自己 ✓
    const wcols = /const WS_COLS: &str = "([^"]+)"/.exec(workspaces)?.[1] ?? "";
    expect(wcols.split(","), "`WS_COLS` 缺 kind").toContain("kind");
  });
});
