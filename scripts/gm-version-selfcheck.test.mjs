// scripts/gm-version-selfcheck.mjs 的单测。
//
// 只测那条**纯函数**（跑什么、带什么环境变量）—— 三条腿本身各由自己的判据守着
// （`check-crypto-backend.test.mjs` / `check-gm-conformance.mjs`）。这里守的是
// "**三段都在计划里**"与"**期望值确实被传到对应那一段**"：漏掉一段 = "只跑了一条就宣布国密版好了"，
// 而那正是本脚本存在的理由。

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { legPlan } from "./gm-version-selfcheck.mjs";

const base = { opensslDir: "/opt/tongsuo", tauriDir: "/repo/src-tauri", withTests: false, withBuild: false };

const ids = (plan) => plan.map((l) => l.id);
const byId = (plan, id) => plan.find((l) => l.id === id);

describe("gm-version-selfcheck：三段自证的计划", () => {
  it("最小形态就是两段（后端＋补丁合在一次调用里，跨对拍一段）", () => {
    expect(ids(legPlan({ ...base, expectPatch: "absent" }))).toEqual(["backend-and-patch", "cross-impl"]);
  });

  it("★ 后端与补丁的期望被传进同一次门禁调用（分两次跑会让'两次之间产物变了'成为可能）", () => {
    const leg = byId(legPlan({ ...base, expectPatch: "applied" }), "backend-and-patch");
    expect(leg.env.SHUYONOTE_EXPECT_CRYPTO_BACKEND).toBe("openssl");
    expect(leg.env.SHUYONOTE_EXPECT_SM_PATCH).toBe("applied");
  });

  it("不声明补丁期望 ⇒ 不把 SHUYONOTE_EXPECT_SM_PATCH 强塞进去（交给门禁的默认：只报告）", () => {
    const leg = byId(legPlan({ ...base, expectPatch: "" }), "backend-and-patch");
    expect(leg.env.SHUYONOTE_EXPECT_SM_PATCH).toBeUndefined();
  });

  it("★ 跨对拍那段必须**点名** Tongsuo（指错地方会退化成「跳过」，而跳过会被读成「对拍过了」）", () => {
    const leg = byId(legPlan({ ...base, expectPatch: "" }), "cross-impl");
    // ⚠️ **不要写死 POSIX 字面量**（2026-09-20 AMD 在 Windows 上跑到这条时红的）：
    //    实现走 `join()` ⇒ Windows 上给的是 `\opt\tongsuo\bin\openssl`。
    //    断言的**意图**是"路径是 <opensslDir>/bin/openssl"，分隔符形态不该参与 ⇒ 用同一个 `join()` 算期望。
    expect(leg.env.SHUYONOTE_TONGSUO_OPENSSL).toBe(join("/opt/tongsuo", "bin", "openssl"));
  });

  it("--with-build 时构建排在最前面（先清再编那条纪律在 sm-library-build 里）", () => {
    const plan = legPlan({ ...base, expectPatch: "applied", withBuild: true });
    expect(ids(plan)[0]).toBe("build");
    expect(byId(plan, "build").args).toContain("--openssl-dir");
  });

  it("--with-tests 时追加应用层国密单测，且带 --features sm-crypto", () => {
    const plan = legPlan({ ...base, expectPatch: "", withTests: true });
    expect(ids(plan)).toContain("sm-tests");
    const leg = byId(plan, "sm-tests");
    expect(leg.args).toContain("sm-crypto");
    expect(leg.args).toContain("--manifest-path");
  });

  // ★ ④ 运行期那一格（2026-09-20 补）：产物里有补丁标记 ≠ 标签真的被 C 层接受。
  //   这条判据钉住两点：这一格**存在**，且**不在**默认形态里（它要一个打过补丁的构建，
  //   放进默认形态只会在没那个构建的机器上自报跳过 —— "跳过"看多了就被读成"过了"）。
  it("--with-tests 时也跑运行期那一格（gm_provider::），且排在应用层单测之前", () => {
    const plan = legPlan({ ...base, expectPatch: "applied", withTests: true });
    expect(ids(plan)).toContain("gm-provider");
    const leg = byId(plan, "gm-provider");
    expect(leg.args).toContain("gm_provider::");
    expect(leg.args).toContain("--manifest-path");
    expect(ids(plan).indexOf("gm-provider")).toBeLessThan(ids(plan).indexOf("sm-tests"));
  });

  it("★ 不给 --with-tests ⇒ 运行期那一格**不出现**（它需要打过补丁的构建，不进默认形态）", () => {
    const plan = legPlan({ ...base, expectPatch: "applied" });
    expect(ids(plan)).not.toContain("gm-provider");
    expect(ids(plan)).toEqual(["backend-and-patch", "cross-impl"]);
  });
});
