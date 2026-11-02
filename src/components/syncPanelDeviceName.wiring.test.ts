// 2026-10-29（owner 选 B）：设备名从「设置 → 账户」搬进「同步面板 → 局域网同步」。
//
// 为什么值得钉：团队 UI 在 2026-10-29 删掉之后，「账户」页只剩「设备名」一格 ⇒ 整页撤掉，
// 设备名搬到它真正影响的地方（同网段的设备在「附近的设备」里看到你叫什么）。这类"搬一处、删一页"
// 最容易出的错是**删了一半**：设置里还剩一个空标签页、或同步面板里出现了第二个读写入口。
// 所以这里钉四件：面板里有那一块（读写走同一条命令）、保存口径不变、设置里整页不再有、类型里没有。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

const SYNC = read("./SyncPanel.tsx");
const SETTINGS = read("./SettingsDialog.tsx");
const EDITOR = read("../store/editor.ts");

describe("设备名搬进同步面板（owner 2026-10-29 选 B）", () => {
  it("① 局域网同步那一块里有「设备名」（输入 ＋ 保存），读写走同一条命令", () => {
    expect(SYNC).toContain('data-testid="sync-device-name"');
    expect(SYNC).toContain("api.getDeviceName()");
    expect(SYNC).toContain("api.setDeviceName(");
    expect(SYNC).toContain('data-testid="sync-device-name-save"');
  });

  it("② 保存口径不变：与当前生效名一致 ⇒ 存空串（继续跟随系统名），⛔ 不把系统名固化", () => {
    expect(SYNC).toContain('=== deviceNameBaseline.trim() ? "" : typed');
  });

  it("③ 设置里「账户」整页撤掉：没有 AccountPane、没有 account 标签、没有 PersonIcon", () => {
    expect(SETTINGS).not.toContain("AccountPane");
    expect(SETTINGS).not.toContain('id: "account"');
    expect(SETTINGS).not.toContain('tab === "account"');
    expect(SETTINGS).not.toContain('labelKey: "settings.account"');
    expect(SETTINGS).not.toContain("PersonIcon");
  });

  it("④ SettingsTab 类型里不再有 \"account\"（否则还能 `openSettings(\"account\")` 到空白页）", () => {
    const typeLine = /export type SettingsTab = ([^;]+);/.exec(EDITOR)?.[1] ?? "";
    expect(typeLine, "应当能切出 SettingsTab 的联合类型").not.toBe("");
    expect(typeLine).not.toContain('"account"');
  });

  it("⑤ 读设备名与 lan_status 同一档门槛（面板开着或内容区那一份才读）", () => {
    expect(SYNC).toMatch(/if \(\(!open && !contentOnly\) \|\| !isDesktopPlatform\(\)\) return;/);
  });
});
