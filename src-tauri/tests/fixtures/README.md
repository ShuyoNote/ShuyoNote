# 测试夹具：一个真包 + 两把一次性密钥的签名

这些文件只服务于**签名链路的端到端验收**：本机与 CI 都没有 `minisign` 可执行文件，
而"我们自己签的包，我们自己的校验器认不认"这件事必须被验证过。

| 文件 | 是什么 |
|---|---|
| `signed-plugin.zip` | 一个**真的**插件包（`fixture-plugin/manifest.json` + `main.js`，包内多一层目录——顺带覆盖"自动下钻"那条规则） |
| `signed-plugin.zip.minisig` | 用一次性密钥 **A** 对它签的 minisign 签名（预哈希 `ED` 格式） |
| `signed-plugin-zip.pub` | 密钥 **A** 的公钥（`minisign.pub` 文件形式，指纹 `1c27-c843-2c55-2322`） |
| `signed-plugin-alt.zip` | 与上面**字节完全相同**的副本（签名不覆盖文件名，所以两份签名都对这个包成立） |
| `signed-plugin-alt.zip.minisig` | 用一次性密钥 **B** 对同一个包签的签名 |
| `signed-plugin-alt-zip.pub` | 密钥 **B** 的公钥（指纹 `c94c-fe8b-4264-0141`） |

用途：A 用来验"真签名通过 / 改一个字节即拒 / 换 key 就要用户明确同意"；
两把 key 都存在，才能测出"**包本身签名有效，但签发者换了**"这条最关键的路径
（只拦"验签失败"是不够的）。

## ⚠️ 这些夹具的公钥盒曾经**不合规**（2026-09-11 已修）

夹具是用 `scripts/lib/minisign.mjs` 造的，而那份实现把**签名**的算法字节
`ED`(0x45 0x44) 也用在了**公钥盒**上。minisign 的公钥盒应当是 `Ed`(0x45 0x64)。

后果不是报错，而是**测试向量悄悄不合规**：本仓用的 `minisign-verify` 对公钥两种字节都收
（`match (..) { (0x45,0x64) | (0x45,0x44) => {} }`），所以**验签测试全绿**，
但真 minisign 会以 `Unsupported signature algorithm` 拒绝它。
也就是说那些测试证明的是"应用接受我们自己造的字节"，而不是"应用接受**真 minisign** 的公钥"
—— 而用户手里拿到的会是后者。

修了两处：`minisign.mjs` 拆开 `ALG_PUBKEY`(Ed) 与 `ALG_SIG_PREHASHED`(ED)；
夹具用 `--in-place` 重签，指纹随之变更（见上表）。

**核验命令**（不需要 minisign）：

```bash
node scripts/lib/minisign-fixture-check.mjs   # 钉住两个夹具公钥盒必须是 Ed
```

有 minisign 时，这两条更直接：

```bash
minisign -V -p signed-plugin-zip.pub     -m signed-plugin.zip
minisign -V -p signed-plugin-alt-zip.pub -m signed-plugin-alt.zip
```

重新生成（密钥是一次性的，重签会换掉指纹 —— 记得同步改
`plugin_index.rs` 里那条写死的指纹断言与上表）：

```bash
cp src-tauri/tests/fixtures/signed-plugin.zip /tmp/pkg.zip
node scripts/minisign-fixture.mjs /tmp/pkg.zip --out /tmp   # 一次一把新密钥
```

⚠️ 这不是发布工具链的一部分：正式签名请用 minisign 本体（`minisign -Sm 包.zip`）。
