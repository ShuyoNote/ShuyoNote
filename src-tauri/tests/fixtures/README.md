# 测试夹具：一个真包 + 两把一次性密钥的签名

这些文件只服务于**签名链路的端到端验收**：本机与 CI 都没有 `minisign` 可执行文件，
而"我们自己签的包，我们自己的校验器认不认"这件事必须被验证过。

| 文件 | 是什么 |
|---|---|
| `signed-plugin.zip` | 一个**真的**插件包（`fixture-plugin/manifest.json` + `main.js`，包内多一层目录——顺带覆盖"自动下钻"那条规则） |
| `signed-plugin.zip.minisig` | 用一次性密钥 **A** 对它签的 minisign 签名（预哈希 `ED` 格式） |
| `signed-plugin-zip.pub` | 密钥 **A** 的公钥（`minisign.pub` 文件形式，指纹 `5ee2-b2a1-c3cf-565c`） |
| `signed-plugin-alt.zip` | 与上面**字节完全相同**的副本（签名不覆盖文件名，所以两份签名都对这个包成立） |
| `signed-plugin-alt.zip.minisig` | 用一次性密钥 **B** 对同一个包签的签名 |
| `signed-plugin-alt-zip.pub` | 密钥 **B** 的公钥（指纹 `6125-bcfa-e894-cf00`） |

用途：A 用来验"真签名通过 / 改一个字节即拒 / 换 key 就要用户明确同意"；
两把 key 都存在，才能测出"**包本身签名有效，但签发者换了**"这条最关键的路径
（只拦"验签失败"是不够的）。

重新生成（密钥是一次性的，重签会换掉指纹 —— 记得同步改
`plugin_index.rs` 里那条写死的指纹断言）：

```bash
cp src-tauri/tests/fixtures/signed-plugin.zip /tmp/pkg.zip
node scripts/minisign-fixture.mjs /tmp/pkg.zip --out /tmp   # 一次一把新密钥
```

⚠️ 这不是发布工具链的一部分：正式签名请用 minisign 本体（`minisign -Sm 包.zip`）。
