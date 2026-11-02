// ⭐ **R176-A（owner 2026-10-28 拍 A）** 的**面板接线级**判据 —— 源码级（逐字读 `SyncPanel.tsx`）。
//
// ## 这一组钉的是哪几条（台账 `REQUESTS.md` R176 行的 J9–J13）
//   · **J12**：端口预置 ⇒ 首次同步**零手输端口**（默认流程里一个端口输入都没有；端口**只在「高级」**）；
//   · **J13**：密码自动 ⇒ 默认流程里**没有任何密码输入**（用户不用知道密码）＋「能读的状态」**真的挂上**；
//   · **J9**：两端发现参数不一致 ⇒ 界面**必须解释原因** —— 面板必须把 `lanStatus` 的读数交给
//     `SyncReadout`（诊断句由纯函数算，见 `src/lib/personalSyncReadout.test.ts`）；
//   · **J10**：「不再信任」后**本地数据零变化** —— 那条路**只许**发 `device_unpair` 这一条数据面命令；
//     Rust 侧 `device_unpair_at` **只动信任表／卡表**，⛔ 不删页面与附件；
//   · **J11**：「不再信任」后**对方不得再拉到本机数据** —— Rust 那半边必须把**在跑的门**上的卡摘掉
//     （hash 与公钥两档都要，`forget_paired` ＋ `forget_paired_device`）。
//
// ## ⚠️ 为什么不写成 DOM 级
// 这一屏的**值全部来自轮询读数**（`lanStatus` / `mesh`），而组件测的夹具里那些读数是**空的** ⇒
// DOM 级只能测到"未读到"那一档，测不到"三格真值"（那由 `SyncReadout.test.tsx` 真渲染 ＋
// `personalSyncReadout.test.ts` 纯函数两层合起来钉 ✓）。本组按本仓既有口径**明标源码级** ✓。
//
// ## ⚠️ 剥注释的纪律（本仓踩过）
// 判据里要断言「某个**字面**不许再出现」时，必须先把注释剥掉 —— 否则会被**解释这件事的注释**喂饱
// （`SyncPanel.tsx` 里到处是历史注释 ✓）。本文件对 `not.toContain` 类判据一律用剥过注释的 `code` ✓。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "SyncPanel.tsx"), "utf8");
const RUST_SYNC = readFileSync(resolve(__dirname, "..", "..", "src-tauri", "src", "sync.rs"), "utf8");

/** 剥掉 `//` 与 `/* … *\/`（只用于"这段字面不许出现"那类判据）✓。 */
const stripComments = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 按**整行等于**找挂载点/闭合点（⛔ 不用 `indexOf("<SyncAdvancedFold>")` ✗ ——
 * 面板里有注释也写着这个字面，`indexOf` 会被注释喂饱 ✓，与 `syncPanelMesh.wiring.test.ts` 那条同形）。
 */
const lines = SRC.split("\n");
const foldOpenLine = lines.findIndex((l) => l.trim() === "<SyncAdvancedFold>");
const foldCloseLine = lines.findIndex((l) => l.trim() === "</SyncAdvancedFold>");
/** ⭐ **默认流程** ＝ 「高级」**外面**的全部（用户不展开高级时看得见的那一屏）；**高级里**另算 ✓。 */
const defaultFlow = [...lines.slice(0, foldOpenLine), ...lines.slice(foldCloseLine + 1)].join("\n");
const advancedFlow = lines.slice(foldOpenLine + 1, foldCloseLine).join("\n");

/** 取一段源码：起点 `from` 到下一个 `to`（找不到 ⇒ 当场抛，⛔ 不许"没找到当通过" ✗）。 */
function between(text: string, from: string, to: string): string {
  const i = text.indexOf(from);
  expect(i, `找不到起始标记（夹具前提）：${from}`).toBeGreaterThanOrEqual(0);
  const j = text.indexOf(to, i + from.length);
  expect(j, `找不到结束标记（夹具前提）：${to}`).toBeGreaterThan(i);
  return text.slice(i, j);
}

describe("夹具前提：两段区域真的分得开（否则下面的判据是空集）", () => {
  it("「高级」有且只有一个挂载点，且它在主视图里更靠后", () => {
    expect(foldOpenLine, "找不到 `<SyncAdvancedFold>` 的挂载点").toBeGreaterThan(0);
    expect(foldCloseLine, "找不到 `</SyncAdvancedFold>`").toBeGreaterThan(foldOpenLine);
    expect(
      lines.filter((l) => l.trim() === "<SyncAdvancedFold>").length,
      "⛔ 只许有一个「高级」折叠（多一个 ⇒ 判据区域分不开）",
    ).toBe(1);
    expect(advancedFlow.length, "高级里的内容不该是空的（夹具前提）").toBeGreaterThan(200);
    expect(defaultFlow.length, "默认流程的内容不该是空的（夹具前提）").toBeGreaterThan(1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **R176-A ④「能读的状态」**：走哪条路 ／ 服务几个空间 ／ 已信任几台
// ═══════════════════════════════════════════════════════════════════════════════
describe("R176-A ④：三格读数在主视图里，值全部来自真读数", () => {
  it("① 真的挂上了，而且在**主视图**（⛔ 不在「高级」里 ✗）", () => {
    expect(defaultFlow, "⭐ 主视图必须真的挂 `<SyncReadout`（J13：状态里必须出现走的是哪条路）").toContain(
      "<SyncReadout",
    );
    expect(advancedFlow, "⛔ 这三格不许被折进「高级」✗（那正是 owner 说的「要能读」的反面）").not.toContain(
      "<SyncReadout",
    );
  });

  it("② 三格的输入全部来自现有读数（⛔ 不写死、⛔ 不新造读数）", () => {
    const block = between(SRC, "const personalReadout = personalSyncReadout({", "\n  });");
    // 走哪条路 ← kind ＋ mesh.enabled（Rust 判的那两格）
    expect(block, "路线那一格必须读 `lanStatus.kind`（⛔ 不按地址形状自己判档 ✗）").toContain("kind: lanStatus?.kind");
    expect(block).toContain("meshEnabled: lanStatus?.mesh?.enabled");
    // 服务几个空间 ← mesh.served（Rust 排过序的那份名单）
    expect(block, "「服务几个空间」必须来自 `mesh.served`").toContain("served: lanStatus ? lanStatus.mesh?.served : null");
    // 已信任几台 ← mesh.paired（与 duList 同一格）
    expect(block, "「已信任几台」必须来自 `mesh.paired`").toContain(
      "trusted: lanStatus ? lanStatus.mesh?.paired : null",
    );
    // J9 的四个输入：发现层开没开 ＋ 附近看见几台 ＋ **精确端口比对的两半**（2026-10-29 owner 拍 B）
    expect(block).toContain("discoveryOn:");
    expect(block).toContain("nearbyCount:");
    expect(block, "⭐ J9 精确比对：本机端口要**从 `mesh.bind` 拆出来**（⛔ 不猜 8788 ✗）").toContain("localPort:");
    expect(block, "⭐ J9 精确比对：对端端口要来自 `announced_port`（⛔ 不从 addr 猜 ✗）").toContain("peerPorts:");
    // ⛔ 读不到不许当 0：上面那两处 `: null` 就是"读不到"的表达 ✓
    expect(block, "⛔ 不许拿 `?? []` 把「读不到」变成「0 台」").not.toMatch(/\?\?\s*\[\]/);
  });

  it("③ 个人版专属（团队档那条路是服务器，规模口径不同 ⇒ 不许混显）", () => {
    expect(defaultFlow).toContain("isPersonalActive && isDesktopPlatform() && <SyncReadout");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **J12**：端口预置 ⇒ 首次同步**零手输端口**（端口只在「高级」里能改）
// ═══════════════════════════════════════════════════════════════════════════════
describe("J12：默认流程零手输端口（端口只在「高级」）", () => {
  it("① 默认流程里**没有**端口输入（连那一行都不出现）", () => {
    const code = stripComments(defaultFlow);
    expect(code, "⛔ 端口输入格漏到默认流程里了（J12 的红线：首次同步零手输端口）").not.toContain(
      'data-testid="mesh-port-input"',
    );
    expect(code, "⛔ 端口那一行整块都不许进默认流程").not.toContain('data-testid="mesh-port-row"');
    // ⛔ 也不许换个别名/对话框变相问端口（只看"有没有端口形的输入/占位符"）
    expect(code).not.toMatch(/placeholder="[^"]*端口/);
    expect(code).not.toMatch(/\bprompt\(/);
  });

  it("② 端口那一行**在「高级」里**（owner 逐字：只在「高级」可改）", () => {
    expect(advancedFlow).toContain('data-testid="mesh-port-row"');
    expect(advancedFlow).toContain('data-testid="mesh-port-input"');
    // 那一格的值来自读数（⛔ 界面不写死默认端口 ✗）
    const row = between(advancedFlow, 'data-testid="mesh-port-row"', "</details>");
    expect(row).toContain("bindPort");
    expect(row, "⛔ 端口号不许写死在界面上（值只许来自 `lanStatus.mesh.bind`）").not.toMatch(/\b8788\b/);
  });

  it("③ 保存走**既有**那条命令 ＋ 校验在纯函数里（⛔ 不新增后端命令 ✗）", () => {
    const fn = between(SRC, "const saveMeshPort = async", "\n  };");
    expect(fn, "校验/拼串必须走纯函数（有单测）").toContain("portTextToBind(");
    expect(fn, "不许拼一个必然被后端拒的串（不合格就 return）").toContain("if (!bind)");
    expect(fn, "改端口走既有 `meshSetConfig`（⛔ 没有新命令 ✗）").toContain("api.meshSetConfig(activeId, bind, null)");
    expect(fn, "地址取当前绑定里的那个（本笔只改端口那一半）").toContain("splitMeshBind(lanStatus?.mesh?.bind");
    expect(fn, "失败要如实说出来").toContain("catch");
  });

  it("④ 预置那一端仍在：Rust 首次备好时写默认监听 ＋ 面板首次进页调一次", () => {
    // Rust：`ensure_mobile_mesh_defaults`（桌面别名 `ensure_mesh_defaults`）里那句预置
    expect(RUST_SYNC, "⭐ 端口预置在 Rust 一侧（`0.0.0.0:8788`）").toContain("0.0.0.0:8788");
    expect(RUST_SYNC, "缺默认值预置那一句（只补不覆盖）").toContain("settings_for(c, \"\", true).bind.is_none()");
    expect(RUST_SYNC, "桌面别名仍在（`mesh_ensure_defaults` 调它）").toContain("pub fn ensure_mesh_defaults");
    // 面板：进页时自动备好（用户什么都不用填 ⇒ J12 的"预置生效"）
    expect(defaultFlow, "⭐ 首次进页要自动备好（`mesh_ensure_defaults`）").toContain("api.meshEnsureDefaults(activeId)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **J13**：密码自动 ⇒ 默认流程里没有密码输入；状态里出现走的是哪条路
// ═══════════════════════════════════════════════════════════════════════════════
describe("J13：密码自动（用户不用知道密码就能接入）＋ 状态出现路线", () => {
  it("① 默认流程里**没有**密码输入（⛔ 不要求用户知道密码 ✗）", () => {
    const code = stripComments(defaultFlow);
    expect(code, "⛔ 默认流程里出现了 `type=\"password\"`（那是「要求用户知道密码」的形状）").not.toContain(
      'type="password"',
    );
    // ⚠️ 边界（如实记）：面板**主视图**里另有一条「一次性口令接入」的向导（加密空间恢复那条路，
    //    走 `inputDialog` 问口令）—— 那是**加密空间**的口令，不是同步密码 ⇒ 本判据只钉
    //    「信任/配对那几条路**不碰**任何密码」，⛔ 不把那条既有的功能一起判红 ✗。
    // ⭐ **2026-10-29（R176-A）**：`const preparePairCode` **已整条撤掉**（屏上不再显示 20 位比对码，
    //    那条路连同 2 秒重取一起删了）⇒ 这里不再从源码里切它；判据本意（信任/配对路不碰密码）
    //    仍由 `trustDevice` 与 `duUnpair` 两条承重 ✓。
    for (const fnName of ["const trustDevice = async", "const duUnpair = async"]) {
      const fn = between(SRC, fnName, "\n  };");
      expect(fn, `⛔ ${fnName} 那条路碰了密码/口令（用户不该被要求知道密码）`).not.toMatch(/口令|密码|token/);
    }
  });

  it("② 「高级」里那一格是**只读**的（自动生成，没有手填框）", () => {
    expect(advancedFlow).toContain('data-testid="mesh-password-row"');
    const row = between(advancedFlow, 'data-testid="mesh-password-row"', "</details>");
    expect(row, "值必须来自那一个常量（自动生成 · 不用你填）").toContain("{PASSWORD_AUTO_VALUE}");
    expect(row, "解释也要在").toContain("{PASSWORD_AUTO_HINT}");
    expect(row, "⛔ 这一格不许有输入框（密码不手输）").not.toContain("<input");
  });

  it("③ 「能读的状态」里**必有**「走的是哪条路」（J13 后半句）", () => {
    // 挂载点 ＋ 路线那一格的来源在 ④-①/② 已钉；这里补一条"路线永远有输出"的纯函数级断言由
    // `personalSyncReadout.test.ts` 承重 ⇒ 本文件只钉"面板确实把那几格传进去了"。
    const mount = between(defaultFlow, "<SyncReadout", "/>");
    expect(mount, "三格读数由 `personalReadout` 一次传全（⛔ 逐格手写死值 ✗）").toContain("{...personalReadout}");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ **J10 ／ J11**：「不再信任」= 只停同步（本地数据零变化）＋ 对方再也拉不动
// ═══════════════════════════════════════════════════════════════════════════════
describe("R176-A ⑤ ＋ J10：解除只停同步，本地数据零变化", () => {
  it("① 按钮上是 owner 逐字给的「不再信任」", () => {
    expect(SRC, "按钮文案必须取自那一个常量（⛔ 别在 JSX 里另写一份 ✗）").toContain("{UNTRUST_LABEL}");
  });

  it("② 语义句**紧挨着那颗按钮**（同一张已信任的卡片上）", () => {
    // 已信任那一支：从 `const paired = duList.some(` 到「接入」那一支之前（与
    // `syncPanelDeviceUnpair.wiring.test.ts` 同一段边界 ✓）
    const branch = between(SRC, "const paired = duList.some(", ") : p.serves_current || isPersonalActive ? (");
    expect(branch, "⭐ 「只停止同步 / 一个字节都不动」那句必须在这一支里").toContain(
      'data-testid="untrust-scope-note"',
    );
    expect(branch).toContain("{UNTRUST_SCOPE_NOTE}");
    expect(branch, "那颗按钮也必须在同一支里（语义写在按钮旁 ✓）").toContain('data-testid="nearby-unpair"');
  });

  it("③ ⭐ **J10 的前端那半边**：那条路**只发一条**数据面命令（`deviceUnpair`）", () => {
    const fn = between(SRC, "const duUnpair = async", "\n  };");
    const calls = [...fn.matchAll(/api\.(\w+)\(/g)].map((m) => m[1]);
    expect(
      calls,
      `⛔ 解除那条路调了别的数据面命令（${JSON.stringify(calls)}）——「不再信任」只许停同步，⛔ 不许动数据 ✗`,
    ).toEqual(["deviceUnpair"]);
    // 也不许出现删除类 API 的字样（兜住"换个写法偷偷删"）
    expect(fn).not.toMatch(/deletePage|deletePages|deleteSpace|removeAttachment|deleteAttachment|trashPage|purge/);
  });

  it("④ ⭐ **J10 的 Rust 那半边**：`device_unpair_at` 只动信任表／卡表，⛔ 不删页面与附件", () => {
    const body = between(RUST_SYNC, "pub(crate) fn device_unpair_at(", "\n}\n");
    // 该做的四件（与函数头注一一对应 ✓）
    expect(body, "① 删掉信任表那一行").toContain("unpair_device(");
    expect(body, "③ 清掉本机出示给它的那份秘密").toContain("set_pair_secret(");
    expect(body, "④ 回一个读数（还认几台）").toContain("paired_device_count(");
    // ⛔ 一件都不许碰数据（页面／块／附件／变更）
    expect(
      body,
      "⛔ 解除信任碰了本地数据（DELETE pages/blocks/attachments/changes 或删文件）—— 「本地数据零变化」当场破 ✓",
    ).not.toMatch(
      /DELETE\s+FROM\s+(?:pages|blocks|attachments|changes|page_blocks|pages_fts|meta\.workspaces)|remove_file|remove_dir|std::fs::remove/i,
    );
  });

  it("⑤ ⭐ **J11**：对方再也拉不动 —— 在跑的门上两档卡都要摘（hash ＋ 公钥）", () => {
    const body = between(RUST_SYNC, "pub(crate) fn device_unpair_at(", "\n}\n");
    expect(body, "⭐ 从在跑的门上摘掉 hash 那一档卡（否则它还能拿旧秘密进来）").toContain("forget_paired(");
    expect(body, "⭐ 公钥那一档也要摘（⛔ 只删库那一行不够 ✗）").toContain("forget_paired_device(");
    // 用户可见的承诺：后端那句话要说得出「拉不动你」✓
    expect(body, "读数那句必须说清它现在拉不动本机").toContain("拉不动你");
    // 2026-10-28 owner 追加的那条：把「我撤销了你」签名送到对面（⛔ 只本地删 ✗）
    expect(body, "待发撤回要记一条（2026-10-28 owner：「另一侧也自动取消」）").toContain("enqueue_pending_revoke(");
  });

  it("⑥ 二次确认那句仍说清「不删数据」＋「重新配对」（⛔ 纯文本、不许 Markdown 星号 ✗）", () => {
    const fn = between(SRC, "const duUnpair = async", "\n  };");
    expect(fn, "解除 ≠ 永久失联：想再连要重新配对").toContain("重新配对");
    expect(fn, "⭐ 承诺：笔记和附件一个字节都不会删").toContain("一个字节都不会删");
    expect(stripComments(fn), "⛔ 确认框是纯文本（不过 `inlineMd`）⇒ 不许写 Markdown 星号").not.toMatch(
      /\*\*[^*\n]{1,40}\*\*/,
    );
  });
});
