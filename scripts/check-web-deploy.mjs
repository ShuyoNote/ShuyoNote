// Web 版**线上**自检：两个入口的版本号 + 资源是否自洽。
//
// 为什么需要它：
//   1. GitHub Pages 每次推 main 自动部署，但"部署成功"与"线上是新版本"是两件事——
//      构建失败、Pages 配额、Actions 卡住，都会让线上停在旧版本而没人发现；
//   2. 官网（shuyo.cn/app）是**手动上传**的，v1.84.5 之后就再没跟过版本（本次自检发现的：
//      线上还是 1.84.5，桌面已经 1.89.0），而没有任何东西会提醒这件事；
//   3. 手动上传踩过的坑（v1.84.4）：`index.html` 是新的、`assets/` 还是旧的 →
//      页面能打开、启动报「失败的资源 … 404」。所以这里会把**线上 index.html 引用的每个
//      资源都取一遍**，而不是只看版本号。
//
// 用法：
//   node scripts/check-web-deploy.mjs            # 两个入口都查
//   node scripts/check-web-deploy.mjs --only pages
//   node scripts/check-web-deploy.mjs --only site
// 退出码非零表示"线上不是当前版本，或资源对不上"。

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;

const TARGETS = [
  { id: "pages", name: "GitHub Pages（自动部署）", base: "https://shuyonote.github.io/ShuyoNote/" },
  { id: "site", name: "国内主站（手动上传）", base: "https://shuyo.cn/app/" },
].filter((t) => !only || t.id === only);

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failed++;
};

async function getText(url) {
  const res = await fetch(url, { redirect: "follow" });
  return { status: res.status, text: res.ok ? await res.text() : "" };
}

for (const t of TARGETS) {
  console.log(`\n${t.name}  ${t.base}`);
  let version = null;
  try {
    const r = await getText(t.base + "version.json");
    if (r.status === 200) version = JSON.parse(r.text).version;
    ok(r.status === 200, `version.json 取得到（HTTP ${r.status}）`);
    if (version) {
      ok(
        version === pkg.version,
        `线上版本 = 当前版本（线上 ${version} / 本地 ${pkg.version}）` +
          (version === pkg.version ? "" : "  ← 需要部署"),
      );
    }
  } catch (e) {
    ok(false, `version.json 读取失败：${e.message}`);
  }

  // 线上 index.html 引用的资源逐个取：这就是 v1.84.4 那个坑的检查点
  // （新 index.html + 旧 assets/ = 页面能开、功能全废）。
  try {
    const html = await getText(t.base);
    ok(html.status === 200, `index.html 取得到（HTTP ${html.status}）`);
    const refs = [...html.text.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));
    const uniq = [...new Set(refs)];
    const bad = [];
    for (const ref of uniq) {
      const url = new URL(ref.replace(/^\.\//, ""), t.base).toString();
      try {
        const res = await fetch(url, { method: "GET" });
        if (!res.ok) bad.push(`${res.status} ${ref}`);
      } catch (e) {
        bad.push(`ERR ${ref} (${e.message})`);
      }
    }
    ok(bad.length === 0, `index.html 引用的 ${uniq.length} 个资源全部可达${bad.length ? `：${bad.slice(0, 5).join("、")}` : ""}`);
  } catch (e) {
    ok(false, `index.html 读取失败：${e.message}`);
  }
}

console.log(
  failed === 0
    ? `\n[结果] 线上与本地一致（${pkg.version}）✅`
    : `\n[结果] ${failed} 项不符——Web 版需要部署（见 docs/RELEASING.md ⑦）❌`,
);
process.exit(failed === 0 ? 0 : 1);
