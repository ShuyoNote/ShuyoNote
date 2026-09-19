# 国密对拍夹具（`gm-conformance`）

把「应用层走 **RustCrypto**（纯 Rust，全平台一份）」与「库级走 **Tongsuo**（C，SQLCipher 的 provider）」
这两份 SM4/SM3 实现的**一致性**变成可执行判据。依据：`docs/plans/2026-09-16-sm-crypto-full-plan.md`
§0-F（按层分工）与 §0.1（套件常量表：SM4-CBC ＋ HMAC-SM3 / EtM、PKCS#7、IV 16B、
MAC 覆盖 版本头‖IV‖密文、enc/mac 两把独立密钥）。

> **两份实现漂移的症状**：跨设备读不出对方的数据（密文互解失败）。它**没有编译期信号**，
> 本机单测也照绿 ⇒ 只能靠"对着标准向量 + 对方实现"的对拍守着。

## 来源与搬迁（2026-09-19）

- 原版：AMD 2026-09-17 写在**协同信箱仓**（`ShuyoNote-collab/gm-conformance`），Linux 侧 5 个用例。
- 搬进本仓时做了三件事：① **不带 `target/`**（原仓误入库了 26M 构建产物；本仓 `.gitignore` 已加
  `tools/gm-conformance/target/`）；② 驱动**重写成跨平台 Node**
  （`scripts/check-gm-conformance.mjs`；原 `driver.sh` 用 `stat -c` / `sha256sum` /
  `$HOME/tongsuo-build` 这类 Linux 专用假设，macOS/Windows 跑不了）；③ Tongsuo 缺席时**自报跳过**。
- `driver-linux.sh` 保留为**来源凭证**（不是判据入口）：它是 AMD 的原始驱动，里面记着当时的环境假设。
  两者对同一份 Cargo 包跑同一组命令；权威、跨平台的入口是那个 Node 脚本。

## 判据（`node scripts/check-gm-conformance.mjs`，已登记进门禁 `gm-conformance`）

| 用例 | 内容 | 需要 Tongsuo？ |
|---|---|---|
| R1/R2 | GM/T 0002 SM4-ECB ＋ GM/T 0004 SM3("abc") 标准向量（夹具自算自比） | 否 |
| R3 | SM4-CBC ＋ PKCS#7 往返（37 字节非整块明文 ⇒ 必然补到 48，专测填充） | 否 |
| R4 | HMAC-SM3：32 字节 tag ＋ 确定性（同输入两次同值） | 否 |
| T1 | Tongsuo 自己命中同样的标准向量（SM4-ECB / SM3） | 是 |
| T2/T3 | 双向互解：RustCrypto 加密 → Tongsuo 解密；Tongsuo 加密 → RustCrypto 解密 | 是 |
| T4 | 两侧密文**逐字节相同**（CBC＋PKCS#7 下应当如此）＋ HMAC-SM3 两侧一致 | 是 |

要点：**标准向量在判据侧与夹具侧各自硬编码一遍**（不共用同一份常量）——共用的话，谁把那个常量改错
两边会一起错、还不报警。另有「**空跑即红**」下限：固定下限会漏掉"Tongsuo 分支整段被删"，
所以下限随 Tongsuo 是否参与而变（缺席 3 / 在场 8）。

## 跑法

```bash
# 任何机器：R1–R4（macOS / Linux / Windows 均可，只需 cargo）
node scripts/check-gm-conformance.mjs

# 连跨实现对拍一起（要 Tongsuo 的 CLI；系统自带 OpenSSL 通常**没有** sm4-cbc，探不到就自报跳过）
SHUYONOTE_TONGSUO_OPENSSL=/path/to/tongsuo/bin/openssl node scripts/check-gm-conformance.mjs
```

## 边界（如实写，别读成"跑得起来"）

- 本夹具证的是**算法层一致**（SM4/SM3/HMAC-SM3），**不是**整条加密存储链路：页加密 / KDF 属于
  库级（P2/P3 的 provider 补丁线），其验收在 SQLCipher 层（`cargo test` + 迁移用例）。
- PBKDF2 的**迭代数**在方案 §0-D 里故意留空（等压测写死）⇒ 夹具**不断言迭代数**。
- 夹具先证算法一致；真正的 EtM 组装（**两把独立密钥** ＋ `版本头‖IV‖密文`）由 P1/P2 的调用方负责。
