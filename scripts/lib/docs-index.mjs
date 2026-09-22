// `docs/README.md` 的「方案与规划（plans）」表**必须登记全部方案文档** —— 纯函数部分。
//
// ## 为什么要有这条判据（2026-09-22 实况）
// `docs/plans/` 已经 71 篇，而这一层**没有任何判据**：写完一篇方案、忘了在 `docs/README.md` 登记，
// 死链判据（`check-doc-links.mjs`）**抓不到** —— 因为它只查"链接指向的文件在不在"，
// 不查"文件有没有被索引进入口"。漂移的真实后果是：新会话按文档入口找不到那一篇，
// 于是同一件事被第二次立项（本仓已经有过"两份口径"的教训）。
//
// ## 判据（两条，都只认**表行**）
// 1. 每个 `docs/plans/*.md` 必须在 `docs/README.md` 里有一行
//    `| [plans/xxx.md](plans/xxx.md) | 一句话内容 |`；
// 2. 那一行的**右列不能为空**（链接有、内容没有＝登记了个寂寞，读者仍不知道要不要点）。
//
// ⚠️ **只认表行，不认"正文里提过"**：第一版想用 `plans/(.+)\.md` 全文件匹配，那样
//   "在某段正文里提一句 `plans/x.md`"就能让判据变绿 —— 这正是本仓反复防的
//   "**看起来更全的判据互相背书**"（同族的坑见 `scripts/check-workflow-yaml.mjs`）。
//
// ## 刻意**不做**的一条（边界，写下来免得后人"顺手补上"）
// **不判反向**（README 里提到的 `plans/x.md` 必须存在）：`docs/README.md` 里有一处**有意**的
// 私有仓路径 —— M27 那行写着「方案已移入私有仓库 `shuyonote-sync-server`（`docs/plans/2026-08-30-team-edition-plan.md`）」，
// 那个文件**本来就不该**在本仓。反向判据会对着一条正确的说明喊红。

/** 表行：`| [任意文字](plans/x.md) | 描述 |`（第一列必须是指向 plans/ 的链接）。 */
const PLAN_ROW = /^\|\s*\[[^\]]*\]\(plans\/([^)\s]+\.md)\)\s*\|\s*(.*?)\s*\|\s*$/gm;

/**
 * 纯函数：找出「未登记 / 登记了但没内容」的方案文档。
 *
 * @param {{ planFiles: readonly string[], readmeText: string, readmePath?: string }} input
 * @returns {string[]} problems（空数组＝通过）
 */
export function plansIndexProblems({ planFiles, readmeText, readmePath = "docs/README.md" }) {
  const problems = [];
  const rows = new Map();
  for (const m of String(readmeText ?? "").matchAll(PLAN_ROW)) rows.set(m[1], m[2]);

  for (const file of [...planFiles].sort()) {
    if (!rows.has(file)) {
      problems.push(
        `${readmePath}：「方案与规划（plans）」表里没有登记 docs/plans/${file}` +
          `（补一行 \`| [plans/${file}](plans/${file}) | 一句话内容 |\`）`,
      );
      continue;
    }
    const desc = rows.get(file).trim();
    if (desc.length === 0 || /^[-—–]+$/.test(desc)) {
      problems.push(`${readmePath}：docs/plans/${file} 登记了，但右列没有内容（读者不知道要不要点）`);
    }
  }
  return problems;
}
