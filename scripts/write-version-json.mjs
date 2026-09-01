// Write the Web deployment's version.json (used by the "check for updates" on the
// Web build, which reads the same-origin version.json) into dist-web/ at build
// time, so every Web release carries an accurate version marker.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const out = resolve(root, "dist-web", "version.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ version: pkg.version }, null, 2) + "\n");
console.log(`[version] dist-web/version.json → ${pkg.version}`);
