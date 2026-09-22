// 判据：workflow YAML 窄规则 ＋ 「单一口味＝国密」四件套
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkText, gmPipelineRequirements } from "./check-workflow-yaml.mjs";

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

describe("check-workflow-yaml：单一口味＝国密（发版链四件套）", () => {
  it("齐全 ⇒ 通过", () => {
    expect(gmPipelineRequirements(GOOD)).toEqual([]);
  });

  it("★ 少任何一件 ⇒ 各自报出来（四件都能独立抓住，不是「只看一件」）", () => {
    const drops = [
      [/ --features sm-library/, /--features sm-library/],
      [/node scripts\/sm-library-build\.mjs --prepare/, /sm-library-build\.mjs --prepare/],
      [/SHUYONOTE_EXPECT_SM_PATCH=applied/, /SHUYONOTE_EXPECT_SM_PATCH=applied/],
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
