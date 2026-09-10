// 统一的 esbuild 加载。
//
// 为什么不能直接 `import "esbuild"`：**esbuild 是 vite 的传递依赖**，pnpm 不会把它
// 软链到 node_modules 顶层，`require.resolve("esbuild")` 会直接失败。所以
// smoke-web / verify-two-device-sync 此前都把
// `node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild` 写死——只要依赖升级
// （哪怕只是 vite 顺手升了 esbuild），这条路径就失效，而报错会是「模块找不到」，
// 看上去像脚本坏了。
//
// CI 里尤其致命：那边用 `pnpm install --no-frozen-lockfile`，解析到的版本未必与
// 本地一致。所以这里动态扫描 `.pnpm` 下的 `esbuild@*`。
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

function resolveEsbuild() {
  const pnpmDir = join(root, "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    const hit = readdirSync(pnpmDir)
      .filter((d) => d.startsWith("esbuild@"))
      .sort()
      .pop();
    if (hit) {
      const dir = join(pnpmDir, hit, "node_modules", "esbuild");
      if (existsSync(dir)) return dir;
    }
  }
  // 非 pnpm 布局（顶层直接装了）时退回标准解析；找不到会抛出明确错误。
  return require.resolve("esbuild");
}

export const esbuild = require(resolveEsbuild());
