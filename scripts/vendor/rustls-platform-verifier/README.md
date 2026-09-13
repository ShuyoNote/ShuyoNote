# 为什么仓库里有一份 `CertificateVerifier.kt`

这个目录**不是**我们的代码，是从上游拷来并打了补丁的第三方源码。留着它是为了让
Android 上的 HTTPS 能用——**不改它，安卓上所有 Let's Encrypt 网站都连不上**。

## 来历

| 项 | 值 |
|---|---|
| 上游 | [`rustls/rustls-platform-verifier`](https://github.com/rustls/rustls-platform-verifier) |
| 文件 | `android/rustls-platform-verifier/src/main/java/org/rustls/platformverifier/CertificateVerifier.kt` |
| 取用 commit | `73a4df87d84b424c22d7818ce3ffbcefda5dff37`（2026-08-26，main 分支；该仓库没有 `v0.7.0` 之类的 tag） |
| 许可证 | MIT OR Apache-2.0（与上游一致） |
| 我们对应的 Rust 侧版本 | `rustls-platform-verifier 0.7.0`（crate 自带 AAR 组件版本 0.1.1） |
| 取用方式 | `curl -sSL` 直接落盘，未经手工改动（改动只有下面那处补丁） |

## 补丁（**唯一的改动**）

`revocationChecker.options` 里加两项：

```kotlin
PKIXRevocationChecker.Option.PREFER_CRLS,   // 优先用 CRL
PKIXRevocationChecker.Option.NO_FALLBACK    // 不要回退到 OCSP
```

文件里那段 `【ShuyoNote 本地补丁】` 注释写清了完整理由。一句话版：

**Let's Encrypt 从 2025-08 起取消 OCSP**（只发 CRL），而 Android 的吊销检查器**默认先查
OCSP**；证书里没有 OCSP 地址时它抛
`CertPathValidatorException: Certificate does not specify OCSP responder`，
上层把它当成**已吊销**（该 fail-open 的地方 fail-closed）⇒ 真机上所有 LE 站点都报
`invalid peer certificate: Revoked`。

真机实测（2026-09-13，Mate 40 / Android 12）：

| 目标 | 结果 |
|---|---|
| `https://shuyo.cn/` | ❌ `invalid peer certificate: Revoked` |
| `https://community.shuyo.cn/` | ❌ 同上 |
| `https://letsencrypt.org/`（LE 官网自己） | ❌ 同上 ⇒ **与我们服务器无关** |
| `https://www.baidu.com/` | ✅ 成功（它的中间证书**有** OCSP 地址） |
| 4 张 CRL 逐个查序列号 | 我们链上 4 张证书**都不在吊销清单里**（`openssl verify -crl_check_all` 也 OK） |

上游状态：issue [#221](https://github.com/rustls/rustls-platform-verifier/issues/221)
（2026-02 开，**至今未修**，已指派），PR [#179](https://github.com/rustls/rustls-platform-verifier/pull/179)
（**就是这两行**，2025-06 开、未合并）。我们用的 0.7.0 已是最新版，**升级解决不了**。

## 怎么用起来

`scripts/android-platform-verifier.mjs` 会把这份 `.kt` 拷进生成出来的
`src-tauri/gen/android/app/src/main/java/org/rustls/platformverifier/`，
由 Gradle 随 App 一起编译（**不再**依赖 crate 里那个预编译 AAR）。
`gen/` 不入库，所以这一步必须脚本化。

JNI 契约核对过（2026-09-13，用 `javap` 对比 AAR 与我们编译出来的形态）：

- 类名/包名：`org.rustls.platformverifier.CertificateVerifier` ✓
- 方法：`private static final VerificationResult verifyCertificateChain(Context, String, String, String[], byte[], long, byte[][])` ✓ 名字**未被混淆/未被 Kotlin mangle**；
- AAR 里的类经过 R8 压缩，所以 App 侧仍需要 `-keep` 规则（脚本会写 `.pro`）。

## 什么时候可以删掉这份拷贝

上游把 PR #179（或等价修复）合并并发版后：升级 Rust 依赖到含修复的版本、恢复脚本里的
AAR 注入方式，然后删掉本目录。**升级时务必回来核对本文档。**
