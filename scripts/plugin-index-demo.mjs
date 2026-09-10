// 本地索引演示服务器（M11.11a 的人工验收工具）。
//
// 作用：把 `examples/plugins/` 里的一个插件打成 zip，就地起一个**只监听 127.0.0.1** 的
// 静态服务器，按 `plugin-index.json` 规范生成一份索引。于是「从索引安装（给 URL）」这条
// 新路径可以在真机上走完一遍，而不必先有个能托管文件的服务器。
//
// 用法：
//   node scripts/plugin-index-demo.mjs                 # 默认 weekly-review，端口 8787
//   node scripts/plugin-index-demo.mjs page-to-md 9000
//   node scripts/plugin-index-demo.mjs weekly-review 8787 --pubkey <minisign 公钥>
//
// `--pubkey` 给定时会顺手找 `--sig <签名文件>`（默认 `<索引>.minisig`）并把签名也发出去，
// 用来验"填了公钥就必须验签通过"这条路。没给公钥时索引不带签名，应用会如实显示"没有校验"。
//
// 为什么允许 http：应用只接受 https，**唯一的例外是本机回环地址**——这条正是给自托调试用的。
// 真发布时必须换 https，否则中间人能同时改包和索引里的哈希。

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const pluginId = positional[0] ?? "weekly-review";
const port = Number(positional[1] ?? 8787);
const pubkey = flag("--pubkey");
const sigPath = flag("--sig");

const pluginDir = join(root, "examples", "plugins", pluginId);
if (!existsSync(join(pluginDir, "manifest.json"))) {
  console.error(`找不到插件：${pluginDir}`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
for (const field of ["id", "version", "apiVersion"]) {
  if (typeof manifest[field] !== "string" || !manifest[field]) {
    console.error(`manifest.json 缺少 ${field}——索引里这几项是必填的`);
    process.exit(2);
  }
}

// 打成 zip：包内是**一层以插件 id 命名的目录**（`zip -r` 的常见形态），
// 应用侧会自动下钻一层——这里正好顺带把那条规则跑通。
const tmp = mkdtempSync(join(tmpdir(), "shuyonote-index-demo-"));
const zipPath = join(tmp, `${manifest.id}-${manifest.version}.zip`);
try {
  execFileSync("zip", ["-qr", zipPath, manifest.id], {
    cwd: join(root, "examples", "plugins"),
    stdio: ["ignore", "ignore", "pipe"],
  });
} catch (e) {
  console.error("打包失败：需要系统里有 zip 命令（macOS / Linux 自带；Windows 可用 Git Bash 或 WSL）");
  console.error(String(e.stderr ?? e.message));
  process.exit(2);
}
const pkg = readFileSync(zipPath);
const sha256 = createHash("sha256").update(pkg).digest("hex");

const index = {
  indexVersion: 1,
  owner: { id: "local-demo", name: "本机演示索引", url: `http://127.0.0.1:${port}/` },
  generatedAt: new Date().toISOString(),
  plugins: [
    {
      id: manifest.id,
      name: manifest.name ?? manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      minAppVersion: "1.87.0",
      runtime: manifest.runtime === "declarative" ? "declarative" : "logic",
      description: manifest.description ?? "",
      publisher: "local-demo",
      license: "MIT",
      homepage: "",
      discussionUrl: "",
      changelogUrl: "",
      permissions: (Array.isArray(manifest.permissions) ? manifest.permissions : []).map((p) => ({
        id: p?.id ?? "",
        reason: p?.reason ?? "",
      })),
      downloadUrl: `http://127.0.0.1:${port}/${manifest.id}-${manifest.version}.zip`,
      size: statSync(zipPath).size,
      sha256,
      signature: "",
    },
  ],
};
const indexBytes = Buffer.from(JSON.stringify(index, null, 2), "utf8");
const signature = sigPath && existsSync(sigPath) ? readFileSync(sigPath, "utf8") : null;

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const send = (type, body) => {
    res.writeHead(200, { "content-type": type, "content-length": body.length });
    res.end(body);
  };
  if (path === "/plugin-index.json") return send("application/json", indexBytes);
  if (path === "/plugin-index.json.minisig") {
    if (!signature) return res.writeHead(404).end();
    return send("text/plain", Buffer.from(signature, "utf8"));
  }
  if (path === `/${manifest.id}-${manifest.version}.zip`) return send("application/zip", pkg);
  res.writeHead(404).end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`索引地址（填进「插件管理 → 从索引安装（给 URL）」）：\n  http://127.0.0.1:${port}/plugin-index.json`);
  console.log(`公钥：${pubkey ? pubkey : "（没给 --pubkey，应用会显示「没有校验」——这是诚实的状态，不是错误）"}`);
  console.log(`签名：${signature ? "已随索引发出（/plugin-index.json.minisig）" : "无"}`);
  console.log(`插件：${manifest.id} v${manifest.version}  ${statSync(zipPath).size} 字节  sha256=${sha256.slice(0, 16)}…`);
  console.log("\n怎么算通过：界面上能看到来源「本机演示索引（127.0.0.1:…）」+ 条目 + 权限与理由；");
  console.log("点安装 → 确认框 → 装完默认未启用（再去「启用」）。Ctrl+C 结束（临时 zip 会被清掉）。");
});

const stop = () => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
