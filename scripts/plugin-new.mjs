// 插件脚手架：`pnpm plugin:new <插件id> [目录]`
//
// 目标只有一件事：**把"开始写"的成本降到一条命令**——生成的插件立刻能被作者 CLI 校验通过、
// 装进应用就能跑（不需要任何权限，用的是 api.notify / api.log 这两个免权限能力）。
//
// 刻意不做的事：
//   · 不生成"示例大全"：模板越长，作者越要删。这里只有 manifest + 一个能跑的命令 + 一页说明。
//   · 不替作者声明权限：`permissions: []` 起步，缺什么自己加（README 里写了怎么查有哪些）。
//     生成一个"顺手要 5 项权限"的模板，等于教人先把权限要满。
//   · 不假装成功：生成后**当场跑一遍作者 CLI**，不通过就以非零退出并打印它的输出。
//
// 用法：
//   pnpm plugin:new my-first-plugin              → examples/plugins/my-first-plugin
//   pnpm plugin:new weekly-report ~/my-plugins   → 指定目录
//   node scripts/plugin-new.mjs hello --name "打招呼" --force

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "./gen-capabilities.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) flags.set(a, args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true);
  else positional.push(a);
}
const id = positional[0];
const outDir = positional[1] ? resolve(positional[1].replace(/^~/, process.env.HOME ?? "~")) : join(root, "examples", "plugins");
const force = flags.has("--force");

if (!id) {
  console.error("用法：pnpm plugin:new <插件id> [目录] [--name 显示名] [--force]");
  process.exit(2);
}
// id 规则与运行时一致（`is_safe_plugin_id` / 索引里更紧的那套）：先拦住，别等装的时候才报
if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(id)) {
  console.error(
    `插件 id「${id}」不合规：只允许小写字母/数字/短横线，长度 2–40，且不以短横线开头或结尾。`,
  );
  process.exit(2);
}
const dir = join(outDir, id);
if (existsSync(dir) && !force) {
  console.error(`${dir} 已存在（要覆盖就加 --force）。`);
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const reg = loadRegistry();
const apiVersion = reg.apiVersion;
const name = typeof flags.get("--name") === "string" ? flags.get("--name") : id;

// 人类可读的名字：没给 --name 就把 id 的短横线换成空格并首字母大写（英文 id 看着还像句话）
const displayName = name === id ? id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()) : name;

const manifest = {
  id,
  name: displayName,
  version: "1.0.0",
  description: "一句话说清这个插件解决什么问题（用户装之前只看得到这句和权限清单）。",
  apiVersion,
  main: "main.js",
  permissions: [],
};

writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

writeFileSync(
  join(dir, "main.js"),
  `// ${displayName} —— 刚生成的起点：一个命令，什么都不依赖。
//
// 三条规矩（写在最前面，因为它们是这个运行时最容易踩的地方）：
//   1. 只用 api.* 里的能力；用了什么就要在 manifest.permissions 里声明 + 写 reason（用户会看到）。
//   2. 写笔记内容不直接落库：api.pages.create / blocks.append 产出的是**草稿**，用户确认后才写。
//   3. 顶层代码要短——它在"加载插件"时就跑（有超时），真正的活放到命令里。

register({
  id: "${id}.hello",
  title: "${displayName}：打个招呼",
  description: "把这句话换掉：它是命令面板里那一行说明。",
  closeOnRun: false, // false = 跑完不关面板，方便连点
  run: function () {
    // api.notify / api.log 是**免权限**的：通知用户、写自己的日志各一条。
    api.log("hello 被点了");
    api.notify("${displayName} 跑起来了");
    // 命令的返回值就是命令面板里显示的那句话。
    return "你好，我是 ${displayName}。";
  },
});
`,
  "utf8",
);

writeFileSync(
  join(dir, "README.md"),
  `# ${displayName}（\`${id}\`）

> 由 \`pnpm plugin:new ${id}\` 生成。下面三件事按顺序做，就能把它装进应用并跑起来。

## 1. 校验

\`\`\`bash
pnpm plugin:validate ${join(outDir, id).replace(root + "/", "")}
\`\`\`

它会检查 manifest、权限理由、JS 语法，并告诉你哪些地方会被应用拒载。

## 2. 装进应用

打开「设置 → 插件 → 打开插件管理」，然后三选一：

- **从文件夹安装**：选这个目录；
- **装 zip 包**：把目录压成 zip（\`zip -r ${id}.zip ${id}\`）再选它；
- **从索引安装（给 URL）**：把 zip 与一份 \`plugin-index.json\` 放到某处（含 \`sha256\`），
  规范见 [docs/plugin-index-spec.md](../../../docs/plugin-index-spec.md)。

装完**默认未启用**：先看清权限与理由，再点启用。

## 3. 改

- 改 \`main.js\` 里的命令；命令面板（Ctrl+K）里搜 ${displayName} 就能跑。
- 要读笔记、建页面、标签……先想清楚**需要哪一项权限**，加进 \`manifest.json.permissions\`
  并写清楚理由；能力表与权限 id 见 [docs/plugin-api.md](../../../docs/plugin-api.md)。
- 调试：插件管理里点这个插件的「日志」（\`api.log\` / \`api.notify\` 都进那里），
  「活动」看它调用过哪些能力、有没有被权限拦下，「事实」看它可查证的那些信息。

## 发布给别人

打包 → 算 \`sha256\` → 写进索引 →（可选）用 minisign 签名。完整流程见
[docs/plugin-recipes.md](../../../docs/plugin-recipes.md)；发布前的底线见
[docs/plugin-policy.md](../../../docs/plugin-policy.md)。
`,
  "utf8",
);

console.log(`已生成 ${dir}`);
console.log(`  manifest.json（apiVersion ${apiVersion}，${manifest.permissions.length} 项权限）`);
console.log("  main.js（一个免权限命令：api.log + api.notify）");
console.log("  README.md（校验 / 安装 / 发布三步）");

// 当场自检：生成的东西必须能过作者 CLI，否则这个脚手架就是在生产废品。
try {
  const out = execFileSync("node", [join(root, "scripts", "plugin-cli.mjs"), "validate", dir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log("\n自检（作者 CLI）：");
  console.log(out.trimEnd());
} catch (e) {
  console.error("\n自检失败——生成出来的插件没能通过作者 CLI（这属于脚手架的 bug，请修脚手架）：");
  console.error(String(e.stdout ?? "") + String(e.stderr ?? ""));
  process.exit(1);
}

console.log(`\n下一步：pnpm plugin:validate ${join(outDir, id).replace(root + "/", "")}`);
