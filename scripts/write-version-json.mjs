// Write the Web deployment's version.json (used by the "check for updates" on the
// Web build, which reads the same-origin version.json).
//
// Two targets, on purpose:
//   - public/version.json  → served by the Vite dev server AND copied into the
//     build output, so `pnpm dev:web` doesn't report a false "未部署".
//   - dist-web/version.json → written after a build too, so re-writing the marker
//     never requires a full rebuild (both stay in sync with package.json).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const body = JSON.stringify({ version: pkg.version }, null, 2) + "\n";

const pub = resolve(root, "public", "version.json");
mkdirSync(dirname(pub), { recursive: true });
writeFileSync(pub, body);

// Only touch dist-web when a build output already exists (post-build step).
const dist = resolve(root, "dist-web");
if (existsSync(dist)) writeFileSync(resolve(dist, "version.json"), body);

console.log(`[version] public/version.json${existsSync(dist) ? " + dist-web/version.json" : ""} → ${pkg.version}`);
