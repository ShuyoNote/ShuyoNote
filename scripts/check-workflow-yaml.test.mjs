// 判据：workflow YAML 窄规则 ＋ 「单一口味＝国密」必备项（构建四件＋产物断言两件）
//      ＋ 私有 CARGO_HOME 的**按 job** 交接（2026-09-25 CI 实测教出来的）
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkText, gmPipelineRequirements, gmCargoHomeHandoffProblems, splitJobs } from "./check-workflow-yaml.mjs";

const GOOD = `
      - name: ★ 库级国密（单一口味）
        run: |
          echo "OPENSSL_DIR=/usr" >> "$GITHUB_ENV"
          node scripts/sm-library-build.mjs --prepare
      - name: Build bundles
        run: pnpm tauri build --bundles deb --features sm-library
      - name: ★ 产物断言
        run: |
          SHUYONOTE_EXPECT_SM_PATCH=applied \\
          SHUYONOTE_EXPECT_PAGE_CIPHER=sm4 \\
          SHUYONOTE_EXPECT_SM_CRYPTO=on \\
          SHUYONOTE_EXPECT_OPENSSL_DIR="$OPENSSL_DIR" \\
            node scripts/check-crypto-backend.mjs
`;

describe("check-workflow-yaml：窄规则（非法 YAML 那一类）", () => {
  it("裸标量以冒号结尾 ⇒ 报出来（这是整个 workflow 编译不过的形态）", () => {
    const bad = checkText("        run: cargo test --lib plugins::");
    expect(bad.length).toBeGreaterThan(0);
  });
  it("值加了引号 ⇒ 不报", () => {
    expect(checkText('        run: "cargo test --lib plugins::"')).toEqual([]);
  });
});

describe("check-workflow-yaml：单一口味＝国密（发版链必备项）", () => {
  it("齐全 ⇒ 通过", () => {
    expect(gmPipelineRequirements(GOOD)).toEqual([]);
  });

  it("★ 少任何一件 ⇒ 各自报出来（每一件都能独立抓住，不是「只看一件」）", () => {
    const drops = [
      [/ --features sm-library/, /--features sm-library/],
      [/node scripts\/sm-library-build\.mjs --prepare/, /sm-library-build\.mjs --prepare/],
      [/SHUYONOTE_EXPECT_SM_PATCH=applied/, /SHUYONOTE_EXPECT_SM_PATCH=applied/],
      [/SHUYONOTE_EXPECT_SM_CRYPTO=on/, /SHUYONOTE_EXPECT_SM_CRYPTO=on/],
      [/SHUYONOTE_EXPECT_OPENSSL_DIR=/, /SHUYONOTE_EXPECT_OPENSSL_DIR=/],
      [/SHUYONOTE_EXPECT_PAGE_CIPHER=sm4/, /SHUYONOTE_EXPECT_PAGE_CIPHER=sm4/],
      [/echo "OPENSSL_DIR=\/usr"/, /OPENSSL_DIR/],
    ];
    for (const [from, to] of drops) {
      const text = GOOD.replace(from, "");
      expect(text).not.toBe(GOOD); // 确认真的删掉了
      expect(gmPipelineRequirements(text).length).toBeGreaterThan(0);
      void to;
    }
  });
});

// ---- 第三条规则：私有 CARGO_HOME 的**按 job** 交接（2026-09-25） ----------------------------
//
// 现场：`android.yml` 的补丁步把补丁打进 `.gm-build/` 私有副本，但**没有**把私有 `CARGO_HOME`
// 交给下一步 ⇒ `build.rs` 按 registry 那份判 ⇒ 如实 panic（run 36092999092 第 23 步），
// 现场看起来像"补丁没打"。判据必须**按 job**：`$GITHUB_ENV` 是 job 级的，
// 而 `release.yml` 恰好是"桌面 job 导了、android job 没导"——按文件找会假绿。

const HANDOFF = `jobs:
  build-android:
    steps:
      - name: 打补丁
        run: |
          node scripts/sm-library-build.mjs --openssl-dir "$OPENSSL_DIR" --prepare --require-static
          node scripts/sm-library-build.mjs --openssl-dir "$OPENSSL_DIR" --print-env >> "$GITHUB_ENV"
      - name: Build APK
        run: pnpm tauri android build --features sm-library
`;

describe("check-workflow-yaml：私有 CARGO_HOME 必须由**同一个 job**交接", () => {
  it("splitJobs：只认 `jobs:` 下缩进 2 的键（顶层 name/on 不是 job）", () => {
    const jobs = splitJobs(`name: X
on:
  push:
jobs:
  alpha:
    steps: []
  beta:
    steps: []
`);
    expect(jobs.map((j) => j.job)).toEqual(["alpha", "beta"]);
    expect(splitJobs("name: no-jobs-here\n")).toEqual([]);
  });

  it("同一 job 里交接了 ⇒ 通过", () => {
    expect(gmCargoHomeHandoffProblems(HANDOFF, { file: "android.yml" })).toEqual([]);
  });

  it("★ 变异：把交接那一行删掉 ⇒ 当场红（这条红就是 run 36092999092 第 23 步）", () => {
    const text = HANDOFF.replace(/^.*--print-env.*\n/m, "");
    expect(text).not.toBe(HANDOFF);
    const p = gmCargoHomeHandoffProblems(text, { file: "android.yml" });
    expect(p.length).toBe(1);
    expect(p[0]).toContain("build-android");
  });

  it("★ 交接只放在**别的 job** 里 ⇒ 仍然红（`$GITHUB_ENV` 是 job 级，不是文件级）", () => {
    const text = `jobs:
  desktop:
    steps:
      - name: 桌面国密准备
        run: |
          node scripts/sm-library-build.mjs --prepare
          node scripts/sm-library-build.mjs --print-env >> "$GITHUB_ENV"
  android:
    steps:
      - name: 打补丁
        run: node scripts/sm-library-build.mjs --prepare --require-static
      - name: Build APK
        run: pnpm tauri android build --features sm-library
`;
    const p = gmCargoHomeHandoffProblems(text, { file: "release.yml" });
    expect(p.length).toBe(1);
    expect(p[0]).toContain("`android`");
    expect(p[0]).not.toContain("`desktop`"); // 桌面那格是真的交接了，不许被牵连
  });

  it("★ 变异：只有**注释**写着要交接 ⇒ 不算（注释不能替命令背书）", () => {
    const text = `jobs:
  a:
    steps:
      - name: 打补丁
        # 记得 node scripts/sm-library-build.mjs --print-env >> "$GITHUB_ENV"
        run: node scripts/sm-library-build.mjs --prepare
`;
    expect(gmCargoHomeHandoffProblems(text, { file: "x.yml" }).length).toBe(1);
  });

  it("显式写 `CARGO_HOME: …/.gm-build/…` 也算（另一种正确写法，别误报）", () => {
    const text = `jobs:
  a:
    env:
      CARGO_HOME: \${{ github.workspace }}/.gm-build/cargo-home
    steps:
      - name: 打补丁
        run: node scripts/sm-library-build.mjs --prepare
`;
    expect(gmCargoHomeHandoffProblems(text, { file: "x.yml" })).toEqual([]);
  });

  it("跑了 `--prepare` 的 job 一律要交接（判据不替人挑「这一步没必要」）", () => {
    const text = `jobs:
  a:
    steps:
      - run: node scripts/sm-library-build.mjs --prepare
`;
    expect(gmCargoHomeHandoffProblems(text, { file: "x.yml" }).length).toBe(1);
  });
});
