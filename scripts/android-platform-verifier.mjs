#!/usr/bin/env node
// 给「生成出来的」Android 工程补上 rustls-platform-verifier 的 **JVM 组件**。
//
// ## 为什么需要这个 JVM 组件
//
// reqwest 0.13 在 Android 上用 `rustls-platform-verifier` 校验 TLS 证书，而它的 Android
// 后端**要回调 JVM** 里的 `org.rustls.platformverifier.CertificateVerifier`（就是系统证书库
// 那套 `TrustManager` 的封装）。那个 Kotlin 组件**不在 Maven Central 上**
// （rustls/rustls-platform-verifier#115），只能用它 crate 内自带的 maven 目录。
//
// ## 为什么是脚本，而不是直接改文件
//
// `src-tauri/gen` 在 `.gitignore` 里（"可重建"），CI 每次都要自己 `tauri android init`
// ——所以对 gen/android 的任何手工改动**都不可复现**。这是上线计划风险清单里那条
// "gen 定制要么脚本化、要么改成声明式"的具体落实。
//
// ## 做三件事（可重复执行，已注入则跳过）
//
// 1. 往 `app/build.gradle.kts` **末尾追加**一个指向 crate 内置 maven 目录的仓库
//    （追加而不是插入：不用解析 Kotlin 结构，`repositories {}` / `dependencies {}`
//    都可以出现多次）；
// 2. 追加一行 `implementation("rustls:rustls-platform-verifier:<版本>")`；
// 3. 写 `app/rustls-platform-verifier.pro`：**release 开了 R8**（`isMinifyEnabled = true`），
//    而这些类只被 JNI 按名字找，R8 看不见任何 Java 引用 ⇒ 会被当成死代码删掉/改名，
//    运行时直接 `ClassNotFoundException`。生成的 build.gradle.kts 里正好用
//    `fileTree(".") { include("**/*.pro") }` 收集规则，所以把 .pro 放进 app/ 就会被自动收走。
//
// 用法：node scripts/android-platform-verifier.mjs [--check]
//   --check：只检查"该注入的是不是已经在了"，不写文件（给门禁用）。

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_GRADLE = join(ROOT, 'src-tauri/gen/android/app/build.gradle.kts')
const PRO_FILE = join(ROOT, 'src-tauri/gen/android/app/rustls-platform-verifier.pro')
const MARK = '// [rustls-platform-verifier] 由 scripts/android-platform-verifier.mjs 注入'

const CHECK_ONLY = process.argv.includes('--check')

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------- 找 crate 的 maven 目录

/** `rustls-platform-verifier-android` 那个 crate 自带的 maven 目录（含 AAR）。 */
function findMavenDir() {
  const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo')
  const srcRoot = join(cargoHome, 'registry/src')
  if (!existsSync(srcRoot)) {
    fail(`找不到 ${srcRoot} —— 先跑一次 cargo fetch，crate 源码里才带着那份 AAR`)
  }

  const found = []
  for (const registry of readdirSync(srcRoot)) {
    const dir = join(srcRoot, registry)
    let names
    try {
      names = readdirSync(dir)
    } catch {
      continue // 权限/竞争：跳过这个 registry，不要因此整个失败
    }
    for (const name of names) {
      if (!name.startsWith('rustls-platform-verifier-android-')) continue
      const maven = join(dir, name, 'maven')
      if (existsSync(maven)) found.push({ crate: name, maven })
    }
  }
  if (!found.length) {
    fail(
      'cargo registry 里没有 rustls-platform-verifier-android —— ' +
        '它由 rustls-platform-verifier 带进来，先跑 `cargo fetch --manifest-path src-tauri/Cargo.toml`',
    )
  }
  // 多个 registry 镜像里都有时，取 crate 版本最大的那个（数字序，别用字典序：0.10 > 0.9）
  found.sort((a, b) => a.crate.localeCompare(b.crate, undefined, { numeric: true }))
  const picked = found[found.length - 1]

  // maven 坐标的**版本号是组件自己的**（0.1.x），不是 Rust crate 的 0.7.x —— 别混。
  const groupDir = join(picked.maven, 'rustls/rustls-platform-verifier')
  if (!existsSync(groupDir)) fail(`${groupDir} 不存在（crate 布局变了？）`)
  const versions = readdirSync(groupDir).filter((v) => statSync(join(groupDir, v)).isDirectory())
  if (!versions.length) fail(`${groupDir} 下没有任何版本目录`)
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const version = versions[versions.length - 1]
  const aar = join(groupDir, version, `rustls-platform-verifier-${version}.aar`)
  if (!existsSync(aar)) fail(`找不到 AAR：${aar}`)

  return { maven: picked.maven, version, aar, crate: picked.crate }
}

// ---------------------------------------------------------------- 生成要追加的两段

/**
 * Kotlin DSL 的路径必须写成 **正斜杠**：`uri("C:\Users\…")` 里的 `\U` 是转义，
 * 而且 `java.net.URI("C:/x")` 会被解析成"scheme 是 C"的怪 URI。用 `file(...)` 包一层
 * 由 Gradle 解析成本地文件，绕开这两个坑。
 */
const kotlinPath = (p) => p.replace(/\\/g, '/')

function gradleSnippet(maven, version) {
  return `
${MARK}
// 组件不在 Maven Central 上（rustls/rustls-platform-verifier#115），指向 crate 自带的 maven 目录。
// 路径由脚本在构建时解析成绝对路径写进来 —— gen/ 不入库，所以不能靠相对路径猜。
repositories {
    maven {
        url = uri(file("${kotlinPath(maven)}"))
        metadataSources { artifact() }
    }
}
dependencies {
    implementation("rustls:rustls-platform-verifier:${version}")
}
`
}

const PROGUARD = `# rustls-platform-verifier 的 JVM 组件只被 **JNI 按名字** 调用（Rust 侧 FindClass），
# R8 看不到任何 Java 引用，会把它当死代码删掉或改名 —— 运行时直接 ClassNotFoundException。
# 规则出自 crate README 的 Proguard 一节。
-keep,includedescriptorclasses class org.rustls.platformverifier.** { *; }
`

// ---------------------------------------------------------------- 主流程

if (!existsSync(APP_GRADLE)) {
  fail(
    `找不到 ${APP_GRADLE}\n` +
      '  gen/ 是生成物（不入库），所以这一步必须在 `pnpm tauri android init` **之后**跑。',
  )
}

const found = findMavenDir()
console.log(`crate  : ${found.crate}`)
console.log(`maven  : ${found.maven}`)
console.log(`artifact: rustls:rustls-platform-verifier:${found.version}`)
console.log(`aar    : ${found.aar}`)

const current = readFileSync(APP_GRADLE, 'utf8')
const injected = current.includes(MARK)

if (CHECK_ONLY) {
  if (!injected) fail('app/build.gradle.kts 里还没有注入（CI 里应排在 tauri android init 之后）')
  if (!existsSync(PRO_FILE)) fail(`缺少 ${PRO_FILE}`)
  console.log('✅ 已注入（--check）')
  process.exit(0)
}

if (injected) {
  console.log('app/build.gradle.kts 已注入过，跳过（可重复执行）')
} else {
  writeFileSync(APP_GRADLE, current + gradleSnippet(found.maven, found.version), 'utf8')
  console.log(`已追加仓库与依赖 → ${APP_GRADLE}`)
}

// Proguard 规则每次覆盖写：它是我们自己的文件，内容必须跟着这里走（别让手工改动留在 gen 里）
writeFileSync(PRO_FILE, PROGUARD, 'utf8')
console.log(`已写入 Proguard 规则 → ${PRO_FILE}`)
