// 两条抽取通道（视觉 / 转写）的**拒绝理由合并**（2026-10-18）。
//
// 现场：设置页「全库索引」那一块把两条拒绝理由直接并排显示，而两条都以**同一句**开头
// （「按红线，抽取不得使用远程 provider（你配的是 https://api.deepseek.com）。」）
// ⇒ 界面上读起来像复读机，用户以为出了两次错。
//
// 口径：**只去掉重复的开头那一句**，两条各自的尾巴（"图片/扫描件…" / "语音转写…"）都要在 ——
// 那才是"哪一类文件没抽出来、为什么"的答案。⛔ 不在这里重写政策文案（两份真相源会漂）。

/**
 * 把若干条拒绝理由合成一句。
 * - 0 条 ⇒ `null`（调用方据此不显示那块）；
 * - 1 条 ⇒ 原样；
 * - ≥2 条 ⇒ 第一条原样，后面每条**若与第一条共用开头那句**，就把那句去掉再拼。
 */
export function joinRefusals(list: Array<string | undefined | null>): string | null {
  const parts = list.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const head = parts[0];
  // 按第一个句号切出"共用开头那句"（政策文案的第一句）；没有句号就整条当开头
  const firstSentence = head.includes("。") ? head.slice(0, head.indexOf("。") + 1) : head;
  const tails = parts.slice(1).map((p) => (p.startsWith(firstSentence) ? p.slice(firstSentence.length).trim() : p));
  return [head, ...tails].filter(Boolean).join(" ");
}
