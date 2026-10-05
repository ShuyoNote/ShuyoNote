// `isLoopbackBase` 的判据（纯函数：正例 + 负例，负例是「必须判成不是本机」的危险方向）
// ＋ 一条接线判据：三处 transport 创建之前都必须先过 assertProviderAllowed。
//
// ⚠️ 接线判据读的是**源码文本**（相对 cwd），与仓里同族测试（`syncPanelMesh.wiring.test.ts`）同一写法 ——
// 不用 `__dirname`（vitest 的 ESM 环境里它不一定有，我第一版就是这么挂的）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isLoopbackBase } from "./llm";

describe("isLoopbackBase —— 本机回环判定（加密空间那道门的底座）", () => {
  it("认本机：localhost / 127.0.0.0-8 段 / ::1（方括号写法，含端口）", () => {
    for (const s of [
      "http://localhost:11434",
      "http://127.0.0.1:8080/v1",
      "http://127.9.9.9",
      "localhost:8080",
      "http://[::1]:8080/v1",
      "  http://localhost  ",
    ]) {
      expect(isLoopbackBase(s), s + " 应当判成本机").toBe(true);
    }
  });

  it("⚠️ IPv6 回环必须写方括号：光秃秃的 http://::1 是无效 URL ⇒ 判成**不是**本机（宁严不宽）", () => {
    // 用户真填这个的话，连接本来就会失败 ⇒ 我们不放行是对的。
    expect(isLoopbackBase("http://::1")).toBe(false);
  });

  it("⚠️ 负例：云端一律**不是**本机（判成 true 就等于把内容发出去）", () => {
    for (const s of [
      "https://api.deepseek.com",
      "https://api.openai.com/v1",
      "https://open.bigmodel.cn/api/paas/v4",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "http://192.168.1.5:8788/v1",
      "http://10.0.0.2:8080",
    ]) {
      expect(isLoopbackBase(s), s + " 应当判成不是本机").toBe(false);
    }
  });

  it("⚠️ 解析不出来 ⇒ 当成**不是**本机（默认取危险方向：认不出来就不放行）", () => {
    for (const s of ["", "   ", "not a url", "http://", "://x"]) {
      expect(isLoopbackBase(s), JSON.stringify(s) + " 应当判成不是本机").toBe(false);
    }
  });

  it("⚠️ 不能把含 localhost 的域名当成本机（localhost.evil.com 这类伪装）", () => {
    expect(isLoopbackBase("http://localhost.evil.com/v1")).toBe(false);
    expect(isLoopbackBase("http://127.0.0.1.evil.com/v1")).toBe(false);
    expect(isLoopbackBase("http://xlocalhost/v1")).toBe(false);
  });
});

describe("接线：三处 transport 创建之前都要过那道门", () => {
  const src = readFileSync("src/store/ai.ts", "utf8");
  const guard = readFileSync("src/lib/ai/cloudGuard.ts", "utf8");
  const embed = readFileSync("src/lib/semanticEmbed.ts", "utf8");
  const CALL = "assertProviderAllowed(config as ProviderConfig)";

  it("每个 `const transport = IS_WEB` 前面都紧跟着 assertProviderAllowed", () => {
    const hits = src.split("const transport = IS_WEB").length - 1;
    // ⚠️ 数的是**调用形状**，不是函数名 —— 定义处也叫这个名字，数名字会把定义算进去（我第一版就这么错）。
    const guards = src.split(CALL).length - 1;
    expect(hits, "transport 创建处数").toBe(3);
    expect(guards, "门调用数（每个创建处一个）").toBe(3);
    let from = 0;
    for (let i = 0; i < hits; i++) {
      const created = src.indexOf("const transport = IS_WEB", from);
      const g = src.lastIndexOf(CALL, created);
      expect(g, "第 " + (i + 1) + " 处：门必须在创建之前").toBeGreaterThan(-1);
      expect(created - g, "第 " + (i + 1) + " 处：门与创建之间不该隔太远").toBeLessThan(400);
      from = created + 1;
    }
  });

  it("判定**只有一处**：口径在 cloudGuard，store 与嵌入通道都调它（不许各写一份）", () => {
    expect(guard).toContain("if (isLoopbackBase(baseUrl)) return true;");
    expect(guard).toContain("encrypted_on_disk === true");
    expect(src).toContain("cloudAllowedSync(config.baseUrl)");
    // ⚠️ store 里**不该**再有第二份口径（这一步就是把两份收成一份）
    expect(src).not.toContain("isLoopbackBase(");
    expect(src).not.toContain("encrypted_on_disk");
  });

  it("嵌入通道也过门（它是全仓唯一的嵌入网络调用点 —— 曾经漏了）", () => {
    expect(embed).toContain("cloudAllowedSync(cfg.baseUrl)");
    // 在真正的 fetch 之前
    const gate = embed.indexOf("cloudAllowedSync(cfg.baseUrl)");
    const fetchAt = embed.indexOf("coreFetch(url");
    expect(gate, "门必须在 fetch 之前").toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(gate);
  });

  it("门本身：加密读数按 `encrypted_on_disk === true` 收；**同步**判（不 await）", () => {
    expect(src).not.toContain("await assertProviderAllowed(");
  });
});
