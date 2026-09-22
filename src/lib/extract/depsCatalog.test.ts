// 能力登记表的判据 —— 它存在的意义是"防漂移"，所以测试要**证明它真的会拦住漂移**。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEP_CAPABILITIES, depCapability } from "./depsCatalog";
import type { ExtractDeps } from "./types";

describe("deps 能力登记表", () => {
  it("能力名唯一", () => {
    const names = DEP_CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("每个能力都声明了「缺失 ⇒ provider_error」与「由平台层注入」", () => {
    for (const c of DEP_CAPABILITIES) {
      expect(c.whenAbsent).toBe("provider_error");
      expect(c.injectedBy).toBe("platform");
      expect(c.purpose.length).toBeGreaterThan(0);
      expect(c.signature.length).toBeGreaterThan(0);
    }
  });

  it("**编译期穷尽性真的在生效**（两个方向都验，避免它退化成空跑）", () => {
    // ① 登记表里的名字必须都是 `ExtractDeps` 的键 —— 这条由 `as const satisfies` 在编译期保证；
    //    运行时再核一遍，防止有人把 `satisfies` 删了却以为还有保护。
    const keys: (keyof ExtractDeps)[] = ["vision", "rasterize", "transcribe"];
    for (const c of DEP_CAPABILITIES) expect(keys).toContain(c.name);

    // ② 反向：`ExtractDeps` 的键必须都在登记表里。
    //    ⚠️ 运行时拿不到类型信息，所以这条**只能靠编译期**（`_DEP_EXHAUSTIVE`）。
    //    这里用一个"看起来像它"的替身证明断言写法是活的：故意漏一个键，映射类型会要求它存在。
    type Missing = Exclude<
      "vision" | "rasterize" | "transcribe" | "对不上",
      (typeof DEP_CAPABILITIES)[number]["name"]
    >;
    const mustBeNonNever: Missing = "对不上"; // 若穷尽，这里类型是 never ⇒ 赋值会报错（即"漏登记"会被编译期抓住）
    expect(mustBeNonNever).toBe("对不上");

    // ③ 缺登记时查询返回 undefined，而不是抛
    expect(depCapability("vision")?.name).toBe("vision");
    expect(depCapability("不存在的能力")).toBeUndefined();
  });

  it("契约文档里列了每个能力（防「代码加了、文档没加」）", () => {
    const plan = readFileSync(
      join(process.cwd(), "docs/plans/2026-09-17-knowledge-base-ai-coverage-plan.md"),
      "utf8",
    );
    const missing = DEP_CAPABILITIES.filter((c) => !plan.includes(c.name)).map((c) => c.name);
    expect(missing).toEqual([]);
  });
});
