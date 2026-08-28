// Copy pdf.js runtime assets (cmaps for CJK fonts, standard fonts, image decoders)
// from node_modules/pdfjs-dist into public/pdfjs so Vite serves them (dev + build).
// Run before `vite` (dev/build). public/pdfjs is gitignored (generated).
import { cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "node_modules", "pdfjs-dist");
const out = join(root, "public", "pdfjs");

const subs = ["cmaps", "standard_fonts", "wasm"];
for (const sub of subs) {
  const s = join(src, sub);
  const d = join(out, sub);
  if (!existsSync(s)) continue;
  rmSync(d, { recursive: true, force: true });
  cpSync(s, d, { recursive: true });
}
console.log("[copy-pdfjs-assets] copied cmaps/standard_fonts/wasm -> public/pdfjs");
