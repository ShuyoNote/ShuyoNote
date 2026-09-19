// 「平台装配」这一跳的判据：`platform.derivedStores()` 在**桌面**上必须真的接到命令面。
//
// 为什么值得单独一条：这条链是 `indexPage`（编排）→ store（适配器）→ **平台装配** → 命令面。
// 前三段各有判据（`indexPage.test.ts`、`derivedStores.test.ts`、`derived_transport.rs`），
// 唯独"平台装配"是**接线活**——接错了（比如装配成 Web 的 store、或者漏了 `derivedStores`）
// 在类型上完全看不出来，症状是"点了开始索引什么都不发生"。

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoked: { cmd: string; args?: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    invoked.push(args === undefined ? { cmd } : { cmd, args });
    return [];
  },
  Channel: class {},
  Resource: class {},
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null, save: async () => null }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: async () => {},
  openUrl: async () => {},
  revealItemInDir: async () => {},
}));

import { tauriPlatform } from "./tauri";

describe("platform.derivedStores（桌面装配）", () => {
  beforeEach(() => {
    invoked.length = 0;
  });

  it("桌面平台**提供** derivedStores（没提供 ⇒ 界面上「开始索引」必须当成不可用）", () => {
    expect(typeof tauriPlatform.derivedStores).toBe("function");
  });

  it("★ 它装配出来的 store 真的走 `derived_apply`/`derived_query`（不是 Web 那套 sql.js）", async () => {
    const stores = await tauriPlatform.derivedStores!();

    await stores.text.replace("att-1", "pdf.text@1", "h1", [{ kind: "text", text: "第一段", loc: "" }], 1);
    expect(invoked[0].cmd).toBe("derived_apply");
    expect((invoked[0].args?.ops as { op: string }[])[0].op).toBe("replaceAttachmentText");

    await stores.chunks.stats();
    expect(invoked[1].cmd).toBe("derived_query");
    expect((invoked[1].args?.query as { op: string }).op).toBe("chunkStats");
  });
});
