// M24 — OCR 兜底 (scanned PDFs without a text layer). Runs tesseract.js on a
// page image and returns recognized text. Gracefully degrades (returns null) when
// tesseract.js can't load / no lang data / offline. Kept out of the smoke bundle
// (dynamic import; OCR needs real machine + lang data).
export async function ocrRecognize(image: string, langs = "chi_sim+eng"): Promise<string | null> {
  if (!image) return null;
  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker(langs);
    try {
      const { data } = await worker.recognize(image);
      const text = String(data?.text ?? "").trim();
      return text || null;
    } finally {
      await worker.terminate();
    }
  } catch {
    return null;
  }
}
