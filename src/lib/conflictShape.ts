// U4 片 2（2026-11-13，owner 拍 D1=B / D4=A）：**把块级冲突行变成裁决形状/建议** —— 纯函数，唯一实现。
//
// 输入是 `page_conflicts` 的一行（`local_json` / `remote_json` 是该块两版的 JSON）。
// 纪律（契约 C1/C2/C5）：
//   · 摘要在 `conflictAdvice.conflictSummary` 里做；本模块只负责算"形状"（块类型/量级/追加/覆盖）；
//   · ⛔ **不猜"哪边没改"**：这张表只在「同 rev 不同内容 / 任一侧缺 rev」时才会落行（`ConflictReason`），
//     所以两侧**都算改过**；真两难就 ask（C5），⛔ 不替人猜；
//   · 唯一可推荐的安全情形：**一侧是另一侧的前缀（纯追加，含全部内容）** ⇒ 推荐"内容更全"那一侧
//     （选它不会丢另一侧已表达的内容）；其余一律 ask。
import { clipSnippet, type ConflictBlockType, type ConflictShape } from "./conflictAdvice";
import type { ConflictChoice } from "./conflictAdvice";

/** 冲突行的最小形状（`list_page_conflicts` 的返回行）。 */
export interface ConflictRowLike {
  block_id: string;
  reason?: string;
  local_json: string;
  remote_json: string;
}

export interface ConflictRowAdvice {
  choice: ConflictChoice;
  reason: string;
  /** 一侧是另一侧前缀时：哪一侧"更全"（用于把推荐按钮标成主按钮）。 */
  fuller: "local" | "remote" | null;
}

/** 从块 JSON 里取**纯文本**（递归 `text`；读不出来给空串 —— 调用方按"读不出来"显示）。 */
export function blockTextFromJson(json: string): string {
  try {
    const walk = (node: unknown): string => {
      if (!node || typeof node !== "object") return "";
      const n = node as { text?: unknown; children?: unknown; content?: unknown };
      const own = typeof n.text === "string" ? n.text : "";
      const kids = Array.isArray(n.children) ? n.children : Array.isArray(n.content) ? n.content : [];
      return own + kids.map(walk).join("");
    };
    return walk(JSON.parse(json)).trim();
  } catch {
    return "";
  }
}

/** 块类型（取顶层 `type`；认不出的归 `other`）。 */
export function blockTypeFromJson(json: string): ConflictBlockType {
  try {
    const t = (JSON.parse(json) as { type?: unknown })?.type;
    if (typeof t !== "string") return "other";
    const k = t.trim().toLowerCase();
    if (k === "paragraph") return "paragraph";
    if (k === "heading") return "heading";
    if (k === "bulletlist" || k === "orderedlist" || k === "listitem" || k === "tasklist") return "list";
    if (k === "codelock" || k === "code" || k === "codeblock") return "code";
    return "other";
  } catch {
    return "other";
  }
}

/** 把一行冲突变成 `ConflictShape`（chips/lines/snippets 都在这里算，⛔ 不把正文交给界面层再用）。 */
export function conflictShapeFromRow(row: ConflictRowLike): ConflictShape {
  const localText = blockTextFromJson(row.local_json);
  const remoteText = blockTextFromJson(row.remote_json);
  const localIsPrefix = localText.length > 0 && remoteText.startsWith(localText);
  const remoteIsPrefix = remoteText.length > 0 && localText.startsWith(remoteText);
  const oneIsSuperset = (localIsPrefix || remoteIsPrefix) && localText !== remoteText;
  return {
    blockType: blockTypeFromJson(row.local_json),
    // ⚠️ 表只在「同 rev 不同内容 / 缺 rev」时落行 ⇒ 两侧都算改过（⛔ 不猜"一边没改"）
    local: {
      changed: true,
      chars: localText.length,
      lines: localText ? localText.split(/\r?\n/).length : 0,
    },
    remote: {
      changed: true,
      chars: remoteText.length,
      lines: remoteText ? remoteText.split(/\r?\n/).length : 0,
    },
    appendOnly: oneIsSuperset,
    overlap: !oneIsSuperset,
    // ⚠️ 片段是**给界面认块**用的（≤40 字）；读不出来/空块要**如实标**（⛔ 不编内容）
    localSnippet: localText
      ? clipSnippet(localText)
      : row.local_json.trim()
        ? "（读不出来）"
        : "（空块）",
    remoteSnippet: remoteText
      ? clipSnippet(remoteText)
      : row.remote_json.trim()
        ? "（读不出来）"
        : "（空块）",
  };
}

/** 这一行的推荐：前缀安全情形给"更全"那一侧；其余 ask（C5 真两难）。 */
export function conflictRowAdvice(row: ConflictRowLike): ConflictRowAdvice {
  const localText = blockTextFromJson(row.local_json);
  const remoteText = blockTextFromJson(row.remote_json);
  // 两侧文字完全相同（可能只差格式）⇒ 保留本地即可（不会丢信息）
  if (localText === remoteText) {
    return { choice: "local", fuller: "local", reason: "两版文字相同（差别可能只在格式）⇒ 保留本地这一版" };
  }
  // 一侧是另一侧的前缀（纯追加、且包含了另一侧全部内容）⇒ 用"更全"那一侧不会丢内容
  if (localText.length > 0 && remoteText.startsWith(localText)) {
    return {
      choice: "remote",
      fuller: "remote",
      reason: "远端是在本地基础上的纯追加（包含本地全部内容）⇒ 用远端不会丢内容",
    };
  }
  if (remoteText.length > 0 && localText.startsWith(remoteText)) {
    return {
      choice: "local",
      fuller: "local",
      reason: "本地是在远端基础上的纯追加（包含远端全部内容）⇒ 用本地不会丢内容",
    };
  }
  // 两边互相改动、无法安全合并 ⇒ 真两难（C5）
  return {
    choice: "ask",
    fuller: null,
    reason: "两边都改了同一块且互相覆盖（rev 相同、内容不同）⇒ 这是真两难，请你选",
  };
}
