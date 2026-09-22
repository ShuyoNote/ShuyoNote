// 判据：`docs/README.md` 的方案索引**必须覆盖 `docs/plans/` 全部文档**（含变异证明）。
//
// 这条判据的存在理由见 `scripts/lib/docs-index.mjs` 顶部；这里只钉行为：
// ★ 两条变异（各自证明"判据真的在岗"，不是"恰好没红"）：
//   ① 删掉登记行 ⇒ 必须报；
//   ② 只在正文里提一句（不写成表行）⇒ **仍然必须报**（否则"提一句"就能代替登记）。
import { describe, expect, it } from "vitest";

import { plansIndexProblems } from "./docs-index.mjs";

const README = `
## 方案与规划（plans）

| 文档 | 内容 |
|---|---|
| [plans/2026-09-01-a.md](plans/2026-09-01-a.md) | **甲方案**：讲甲这件事 |
| [plans/2026-09-02-b.md](plans/2026-09-02-b.md) | **乙方案**：讲乙这件事 |

> 顺带一提：plans/2026-09-03-c.md 也在正文里被提到过（模板串里不能放反引号，故不加代码标记）。
`;

describe("plansIndexProblems：方案索引齐全", () => {
  it("齐全 ⇒ 通过", () => {
    const problems = plansIndexProblems({
      planFiles: ["2026-09-01-a.md", "2026-09-02-b.md"],
      readmeText: README,
    });
    expect(problems).toEqual([]);
  });

  it("★ 变异①：删掉登记行 ⇒ 报出来（并给出可抄的那一行）", () => {
    const withoutB = README.replace(/^\| \[plans\/2026-09-02-b\.md\].*$\n/m, "");
    expect(withoutB).not.toBe(README); // 确认真的删掉了
    const problems = plansIndexProblems({
      planFiles: ["2026-09-01-a.md", "2026-09-02-b.md"],
      readmeText: withoutB,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2026-09-02-b.md");
    expect(problems[0]).toContain("补一行"); // 报错要能直接照抄
  });

  it("★ 变异②：只在正文里提过、没有表行 ⇒ **仍然报**（提一句不算登记）", () => {
    const problems = plansIndexProblems({
      planFiles: ["2026-09-01-a.md", "2026-09-02-b.md", "2026-09-03-c.md"],
      readmeText: README, // 正文里确实有 `plans/2026-09-03-c.md`，但它不是表行
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("2026-09-03-c.md");
  });

  it("登记了但右列是空的 / 只有破折号 ⇒ 报（链接有、内容没有＝登记了个寂寞）", () => {
    const empty = README.replace("**乙方案**：讲乙这件事", "");
    const dash = README.replace("**乙方案**：讲乙这件事", "—");
    for (const text of [empty, dash]) {
      const problems = plansIndexProblems({
        planFiles: ["2026-09-01-a.md", "2026-09-02-b.md"],
        readmeText: text,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("右列没有内容");
    }
  });

  it("★ 边界：README 里指向**别的仓库**的 `plans/x.md` 不参与判据（反向刻意不判）", () => {
    // 真实例子：M27 那行写着「方案已移入私有仓库 shuyonote-sync-server（`docs/plans/2026-08-30-team-edition-plan.md`）」
    // —— 那个文件本来就不该在本仓，反向判据会对着一条正确的说明喊红。
    const problems = plansIndexProblems({
      planFiles: ["2026-09-01-a.md"],
      readmeText: README + "\n> 方案已移入私有仓库（`docs/plans/2026-08-30-team-edition-plan.md`）。\n",
    });
    expect(problems).toEqual([]);
  });

  it("多个缺失按文件名排序报出（报错顺序稳定，便于比对）", () => {
    const problems = plansIndexProblems({
      planFiles: ["2026-09-09-z.md", "2026-09-01-a.md"],
      readmeText: "",
    });
    expect(problems.map((p) => p.match(/([0-9-]+-[a-z]\.md)/)?.[1])).toEqual([
      "2026-09-01-a.md",
      "2026-09-09-z.md",
    ]);
  });
});
