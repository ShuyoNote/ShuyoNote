// Human-readable preview of a confirmable AI draft, shown in the panel before the
// user hits "应用". Pure so it is unit-testable.

export function draftPreview(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, any>;
  if (p.kind === "create_page") {
    const title = String(p.args?.title ?? "");
    const text = String(p.args?.content_text ?? "").trim();
    return title ? `标题：${title}${text ? `\n${text.slice(0, 120)}${text.length > 120 ? "…" : ""}` : ""}` : "";
  }
  if (p.kind === "append_block") {
    const text = String(p.text ?? "").trim();
    return text ? `将追加：\n${text.slice(0, 160)}${text.length > 160 ? "…" : ""}` : "";
  }
  return "";
}
