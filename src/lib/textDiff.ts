// 版本历史 P2：**逐行 diff**（版本正文 → 当前正文）。
//
// 为什么放在纯函数层：恢复前对照是「先看再恢复」的延伸（历史面板原本只给 40 字摘要）；
// 把 diff 算法与 UI 分开，判据可以独立钉「插入/删除/上下文」而不需要挂 React。
//
// 口径：按行比较（`\r?\n`），`del` = 只存在于版本（旧）、`add` = 只存在于当前（新）、
// `same` = 两边都有（保留上下文）。⛔ 不做词级 diff、不做行内高亮（P2 只到行级）。
export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** 超过这个规模就退回"整段替换"提示，避免 UI 卡死（历史正文通常远小于它）。 */
const MAX_DIFF_CELLS = 2_000_000;

/**
 * 逐行 LCS diff。
 *
 * @param before 旧文本（历史版本）
 * @param after  新文本（当前页）
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  // 规模保护：极端大文本不做 O(n*m) 表格，直接"全删 + 全加"仍然给出可读对照。
  if (n * m > MAX_DIFF_CELLS) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度。
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

function splitLines(text: string): string[] {
  // 统一换行；空文本算 0 行（不是 1 行空串），这样"空 → 有内容"只显示新增。
  const normalized = text.replace(/\r\n?/g, "\n");
  return normalized === "" ? [] : normalized.split("\n");
}

/** 「是否有差异」的便宜判据（UI 决定显示不显示对照区）。 */
export function hasDiff(lines: readonly DiffLine[]): boolean {
  return lines.some((l) => l.kind !== "same");
}
