// 判据：**出网的 function name 必须合规**（2026-10-06 owner 截图那次 400 的机械形态 ✓）。
//
// 来由逐字（DeepSeek 的报错，从面板上抄下来的 ✓）：
//   `Invalid 'tools[0].function.name': string does not match pattern.`
//   `Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`
// 我们的能力 id 是 `pages.get` 这种「命名空间.动作」形态 ✗ ⇒ **带工具的请求必然 400** ✗。
//
// ⚠️ 这条判据是"会红"的：把 `toWireToolName` 改成恒等（`return id` ✓）、或让它返回带点号的名字，
//   下面第一条就红 ✓（见提交信息里的读数 ✓）。
import { describe, expect, it } from "vitest";
import { aiTools } from "./tools";
import { WIRE_NAME_RE, buildToolNameMap, toInternalToolId, toWireToolName } from "./toolNames";

describe("AI 工具的出网名（OpenAI 兼容接口要求 ^[a-zA-Z0-9_-]+$）", () => {
  it("★ 每一个内建工具的**出网名**都合规 —— 点号会让上游直接 400", () => {
    const map = buildToolNameMap(aiTools.map((t) => t.id));
    expect(map.bad, "不合规的出网名 ⇒ 上游会回 400（逐字见文件头）").toEqual([]);
    for (const [id, wire] of map.toWire) {
      expect(WIRE_NAME_RE.test(wire), `${id} ⇒ ${wire} 不合规`).toBe(true);
    }
  });

  it("★ 双向表不撞车（两个内部 id 不许映到同一个出网名）", () => {
    const map = buildToolNameMap(aiTools.map((t) => t.id));
    expect(map.collisions).toEqual([]);
  });

  it("点号换成下划线，且能**查表换回来**", () => {
    expect(toWireToolName("pages.get")).toBe("pages_get");
    expect(toWireToolName("blocks.append")).toBe("blocks_append");
    const map = buildToolNameMap(["pages.get", "blocks.append"]);
    expect(map.toWire.get("pages.get")).toBe("pages_get");
    expect(toInternalToolId("pages_get", map)).toBe("pages.get");
    expect(toInternalToolId("blocks_append", map)).toBe("blocks.append");
  });

  it("模型直接写内部 id（文本形态）也认 —— 查不到就原样返回，交给白名单去挡", () => {
    const map = buildToolNameMap(["pages.get"]);
    expect(toInternalToolId("pages.get", map)).toBe("pages.get");
    expect(toInternalToolId("不存在的工具", map)).toBe("不存在的工具");
    expect(toInternalToolId("  pages_get  ", map)).toBe("pages.get");
  });

  it("自带下划线的 id 不会被'猜'成点号（反向只查表 ✓）", () => {
    const map = buildToolNameMap(["my_tool"]);
    // 出网名原样 ✓；反向仍是 `my_tool`（⛔ 不会变成 `my.tool` ✗）
    expect(map.toWire.get("my_tool")).toBe("my_tool");
    expect(toInternalToolId("my_tool", map)).toBe("my_tool");
  });
});
