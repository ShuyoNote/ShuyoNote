// M26 公式 —— 识别图片/手写公式 → LaTeX. Reuses the existing vision model path
// (ocrWithVision) with a formula-specific prompt, so no new backend command.
import { ocrWithVision } from "./ocrVision";
import type { ProviderConfig } from "./llm";

const FORMULA_PROMPT =
  "识别图片中的数学公式，输出等价的 LaTeX 代码。只输出 LaTeX，用 \\[ ... \\] 包裹块级公式（若清晰是行内则用 \\( ... \\)）。不要任何解释、代码块标记(如```latex)或多余文字。\n例：图片是 E=mc² → \\[ E = mc^2 \\]";

/** Clean up a VLM reply into a usable LaTeX string (strip fences/tags). */
function cleanLatex(reply: string): string {
  let s = String(reply ?? "").trim();
  // Strip ```latex ... ``` fences.
  const fence = s.match(/```(?:latex)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Strip a leading/first line if it's a "Here is ..." preamble.
  s = s.replace(/^(?:Here|The|As|Sure|This)[^]*?\n/i, "").trim();
  // Remove \begin/\end or [ ] wrappers if the model wrapped whole output.
  s = s.replace(/^\\?\[/, "").replace(/\\?\]$/, "").trim();
  return s;
}

export type FormulaRecognizeResult = {
  latex: string | null;
  error: "none" | "timeout" | "error";
  message?: string;
};

/** Recognize a formula from an image data URL using the configured vision model. */
export async function recognizeFormulaImage(
  config: ProviderConfig,
  imageDataUrl: string,
  timeoutMs = 90000,
): Promise<FormulaRecognizeResult> {
  if (!imageDataUrl) return { latex: null, error: "error", message: "图片为空" };
  const res = await ocrWithVision(config, imageDataUrl, FORMULA_PROMPT, timeoutMs);
  if (!res.text) {
    return {
      latex: null,
      error: res.error,
      message: res.error === "timeout"
        ? "识别超时，请重试或改用本地模型"
        : "识别失败：请确认 AI 设置已配置支持图像的模型（如 qwen2.5-vl / llava / gpt-4o）",
    };
  }
  return { latex: cleanLatex(res.text), error: "none" };
}

/** Read a File into a data URL (for the formula image picker). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("读取图片失败"));
    r.readAsDataURL(file);
  });
}
