// `scripts/lib/sm-library-plan.mjs` 的判据。
//
// 来历（2026-09-22，真实事故）：发版链按改动前的写法跑出来的是**非国密**包 ——
// 因为 `--prepare` 只清 dev profile，而 `tauri build` 是 release ⇒ release 的旧 SQLCipher
// 被**原样复用**（`libsqlite3-sys` 没为 `OPENSSL_DIR` 声明 rerun-if-env-changed）。
// 本机把发版链原样跑一遍时，`check-crypto-backend` 的三条断言把它抓住了。
// ⇒ 这两条判据钉住"两个 profile 都必须清"，避免下一个人再把 `--release` 去掉。
import { describe, expect, it } from "vitest";

import { cleanCommands, shouldBuild } from "./sm-library-plan.mjs";

const manifest = "/repo/src-tauri/Cargo.toml";

describe("sm-library-plan：清产物必须覆盖**两个 profile**", () => {
  it("★ 每个包都有 debug 与 release 两条（少 release ⇒ 发非国密包）", () => {
    const steps = cleanCommands({ manifest });
    for (const pkg of ["libsqlite3-sys", "shuyonote"]) {
      const forPkg = steps.filter((s) => s.args.includes(pkg));
      expect(forPkg.length).toBe(2);
      const flags = forPkg.map((s) => (s.args.includes("--release") ? "release" : "debug"));
      expect(flags.sort()).toEqual(["debug", "release"]);
    }
  });

  it("★ release 那一条的说明必须点出后果（「少了它会怎样」写给人看）", () => {
    const release = cleanCommands({ manifest }).filter((s) => s.args.includes("--release"));
    expect(release.length).toBe(2);
    for (const s of release) expect(s.label).toMatch(/非国密|原样复用/);
  });

  it("命令形状对：`cargo clean -p <pkg> [--release] --manifest-path <路径>`", () => {
    for (const s of cleanCommands({ manifest })) {
      expect(s.cmd).toBe("cargo");
      expect(s.args.slice(0, 3)).toEqual(["clean", "-p", s.args[2]]);
      expect(s.args).toContain("--manifest-path");
      expect(s.args[s.args.length - 1]).toBe(manifest);
    }
  });
});

describe("sm-library-plan：--prepare 不构建", () => {
  it("prepare ⇒ 不构建；默认 ⇒ 构建", () => {
    expect(shouldBuild({ prepare: true })).toBe(false);
    expect(shouldBuild({ prepare: false })).toBe(true);
    expect(shouldBuild({})).toBe(true);
  });
});
