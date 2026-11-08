// ⭐ P3-1b（task-63）：App 只读查询 daemon IPC `/status` —— 契约/api/web 接线判据。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("sync_core_ipc_status · 只读降级接线", () => {
  it("① 契约：命令存在，返回值是 reachable/reason/status（不抛口径）", () => {
    const commands = read("src/lib/platform/commands.ts");
    expect(commands).toContain("sync_core_ipc_status: { args: undefined; result: SyncCoreIpcStatus }");
    expect(commands).toContain("export interface SyncCoreIpcStatus");
    expect(commands).toContain("reachable: boolean");
    expect(commands).toContain("reason: string | null");
    expect(commands).toContain("status: SyncCoreStatus | null");
  });

  it("② api 走 invoke（只读；没有第二套解析）", () => {
    const api = read("src/lib/api.ts");
    expect(api).toContain('syncCoreIpcStatus: () => invoke("sync_core_ipc_status")');
    expect(api).toContain("SyncCoreIpcStatus");
  });

  it("③ Web 没有 daemon ⇒ 恒降级（reachable=false＋reason，不假装）", () => {
    const web = read("src/lib/platform/web.ts");
    const at = web.indexOf('if (cmd === "sync_core_ipc_status")');
    expect(at).toBeGreaterThan(-1);
    const block = web.slice(at, at + 400);
    expect(block).toContain("reachable: false");
    expect(block).toContain("reason:");
    expect(block).toContain("status: null");
  });
});
