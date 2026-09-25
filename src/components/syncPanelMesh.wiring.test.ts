// ★ 丙-③-b-2b-2：**网格（对等交换）在面板上真的要有一个可点的入口**。
//
// 为什么用**文本级**判据：这一片的价值全在"用户点得到"上，而"点得到"在 Node 里跑不出来
// （要真 Chromium ＋ 真命令面）。所以这里钉**结构**，与 `lanMulticast.wiring.test.ts` 同一手法：
// 命令面、门槛、清除语义、读数的来源，四处必须同时在岗 —— 少任何一处，这一档都用不了。
//
// ⚠️ 这几条**不是**在验业务逻辑（那在 Rust 侧与 `src/lib/platform` 的判据里），
// 它们只回答一个问题：**界面接上了没有**。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("网格（丙-③-b）· 面板接线", () => {
  const panel = read("src/components/SyncPanel.tsx");
  const webTs = read("src/lib/platform/web.ts");
  const commandsTs = read("src/lib/platform/commands.ts");

  it("① 面板真的调了命令面那两个命令（少一个就有一半功能点不到）", () => {
    expect(panel, "面板没接 `mesh_set_config` ⇒ 用户没法开网格").toContain("api.meshSetConfig(");
    expect(panel, "面板没接 `mesh_sync_now` ⇒ 开了也换不动").toContain("api.meshSyncNow(");
  });

  it("② 门槛是 `space_id`，**不是** `lanRowBound`（网格不需要服务端地址）", () => {
    // 网格那一块：只要求这个空间有 space_id —— "只开网格、不绑服务端"正是这一档要支持的配置。
    expect(panel).toContain("isDesktopPlatform() && lanStatus && !!activeRow?.space_id.trim() && (");
    // 甲那一行的门槛**照旧**要求服务端地址。两条门槛必须在，而且必须**不一样**：
    // 若网格那一条也写成 `lanRowBound`，没有服务端地址的空间就永远看不到这个入口。
    expect(panel).toContain("isDesktopPlatform() && lanStatus && lanRowBound && (");
  });

  it("③ 「关掉网格」走**清除**（`\"\"`），不是 `null`（`null` ＝ 不动 ⇒ 关不掉）", () => {
    expect(panel).toContain('api.meshSetConfig(activeId, "", null)');
  });

  it("④ 「别人拉不拉得到」那句人话**来自 Rust**（界面不自己按地址形状判档）", () => {
    expect(panel).toContain("{lanStatus.mesh.note}");
    // 面板里不许出现"自己判回环/公网"的痕迹：档位只许由 Rust 出（与 `lan_status` 那条同一纪律）。
    expect(panel).not.toContain("127.0.0.1");
  });

  it("⑤ 契约与 Web 两侧都带 `mesh`（否则面板在 Web 上读到 undefined）", () => {
    expect(commandsTs, "`LanStatus` 少了 mesh").toContain("mesh: MeshConfigState;");
    expect(commandsTs, "缺 `mesh_set_config` 的契约条目").toContain("mesh_set_config:");
    expect(commandsTs, "缺 `mesh_sync_now` 的契约条目").toContain("mesh_sync_now:");
    // Web 的 `lan_status` 必须回同一形状：**如实说"这一档不可用"**，而不是少一个字段。
    expect(webTs).toContain("Web 版开不了本机端口 ⇒ 网格这一档只在桌面版可用");
  });
});
