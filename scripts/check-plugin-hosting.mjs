// 插件托管的"线上那一份"验收：索引与包**从公网拉回来**逐条核对。
//
// 为什么需要它：应用侧的门禁（`external_index` / `external_package`）验的是**文件**，
// 而托管方真正要保证的是**线上那一份**能装：字节与索引一致、签名能验、缓存头别把新版本藏起来。
// 这几条里有两条是"发布时毫无征兆、用户端才炸"的：
//   · 索引被长缓存 ⇒ 新插件永远看不到（应用侧永远拿到旧清单）；
//   · 包被 no-store 或者被 CDN 改写 ⇒ 每次安装都重下几十 MB（慢，但不报错）。
//
// 用法：
//   node scripts/check-plugin-hosting.mjs --url https://community.shuyo.cn/plugins/plugin-index.json
//   node scripts/check-plugin-hosting.mjs --url … --limit 3        # 只抽查前 3 个包（默认全部）
//
// 它**不做密码学**：索引签名与发布者签名由应用真正的校验器验（脚本最后会打印那条命令）。
// 这里只回答"线上那份是不是它声称的那一份"。

import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const INDEX_URL = argOf("--url", "https://community.shuyo.cn/plugins/plugin-index.json");
const LIMIT = Number(argOf("--limit", "0")) || 0;

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
};

const fetchWith = async (url, init = {}) => {
  const r = await fetch(url, { redirect: "follow", ...init });
  return r;
};

const cacheControl = (res) => (res.headers.get("cache-control") ?? "").toLowerCase();

console.log(`插件托管验收 · ${INDEX_URL}`);

// ---- 1) 索引本身 -----------------------------------------------------------
const indexRes = await fetchWith(INDEX_URL);
ok(indexRes.status === 200, `索引取得到（HTTP ${indexRes.status}）`);
if (indexRes.status !== 200) process.exit(1);
const cc = cacheControl(indexRes);
ok(
  cc.includes("no-store") || cc.includes("no-cache") || /max-age=(0|60)\b/.test(cc),
  `索引的缓存头不会把它藏起来（cache-control: ${cc || "(未提供)"}）——索引被长缓存 = 新插件看不到`,
);
const indexText = await indexRes.text();
let index;
try {
  index = JSON.parse(indexText);
} catch (e) {
  ok(false, `索引是合法 JSON（${e instanceof Error ? e.message : e}）`);
  process.exit(1);
}
ok(true, `索引是合法 JSON（${indexText.length} 字节，owner=${index.owner?.name ?? "未声明"}，插件 ${index.plugins?.length ?? 0} 个）`);
ok(
  index.owner?.name && index.owner?.url,
  `索引写明了来源（${index.owner?.name ?? "?"} · ${index.owner?.url ?? "?"}）——用户要能看出自己订阅了谁`,
);

// ---- 2) 索引签名（HTTP 层：存在且不被缓存） --------------------------------
const sigRes = await fetchWith(`${INDEX_URL}.minisig`);
ok(sigRes.status === 200, `索引签名取得到（HTTP ${sigRes.status}）`);
if (sigRes.status === 200) {
  const sigCc = cacheControl(sigRes);
  ok(
    sigCc.includes("no-store") || sigCc.includes("no-cache") || /max-age=(0|60)\b/.test(sigCc),
    `索引签名的缓存头与索引一致（cache-control: ${sigCc || "(未提供)"}）`,
  );
}

// ---- 3) 每个包：字节与索引一致、可长缓存 ----------------------------------
const plugins = LIMIT > 0 ? index.plugins.slice(0, LIMIT) : index.plugins;
console.log(`\n逐条核对 ${plugins.length} 个包：`);
for (const p of plugins) {
  const res = await fetchWith(p.downloadUrl);
  if (res.status !== 200) {
    ok(false, `${p.id}: 包取得到（HTTP ${res.status}）`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex");
  const sizeOk = buf.length === p.size;
  const shaOk = sha === p.sha256;
  ok(sizeOk && shaOk, `${p.id}: 线上字节与索引一致（${buf.length}/${p.size} 字节，sha256 ${shaOk ? "一致" : `${sha.slice(0, 12)}≠${String(p.sha256).slice(0, 12)}`}）`);
  const pcc = cacheControl(res);
  ok(
    pcc.includes("immutable") || /max-age=[1-9][0-9]{4,}/.test(pcc),
    `${p.id}: 包是可长缓存的（cache-control: ${pcc || "(未提供)"}）——名字带版本号，内容不变`,
  );
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  ok(
    !ctype.includes("text/html"),
    `${p.id}: 包不是网页（content-type: ${ctype || "(未提供)"}）`,
  );
}

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
console.log(
  [
    "",
    "密码学那两段（索引签名 / 发布者签名）交给应用**真正的**校验器；上面这些只回答「线上就是那份」：",
    "  curl -sO <索引 URL> && curl -sO <索引 URL>.minisig",
    "  SHUYONOTE_INDEX_FIXTURE=plugin-index.json SHUYONOTE_INDEX_SIG=plugin-index.json.minisig \\",
    "  SHUYONOTE_INDEX_PUBKEY=<公钥文件> cargo test --lib external_index -- --ignored --nocapture",
  ].join("\n"),
);
process.exit(fail === 0 ? 0 : 1);
