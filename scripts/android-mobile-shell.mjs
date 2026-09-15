#!/usr/bin/env node
// 给「生成出来的」Android 工程补上移动端壳适配层：**窗口 inset 桥** + **返回键**。
//
// ## 为什么是脚本，而不是直接改文件
//
// `src-tauri/gen` 在 `.gitignore` 里（"可重建"），CI 每次都要自己 `tauri android init`
// ——所以对 gen/android 的任何手工改动**都不可复现**。照 `scripts/android-platform-verifier.mjs`
// 的模式：内容写在本文件里，每次覆盖生成，`--check` 给门禁用。
//
// ## 它修的两个真机问题（2026-09-15 实测，Mate 40 / Android 12 / 密度 3.0）
//
// ### ① 顶部被状态栏压住 + 顶部 41 CSS px 是触摸死区
//
//   `dumpsys` 状态栏 inset `visible=true frame=[0,0][1080,123]` = **41 CSS px**，
//   而应用内容从 y=0 开始画 ⇒ 标题与系统时间叠字；`adb shell input tap` 打在
//   y≤123 时**一个 DOM 事件都没有**（y=130/180 有 100+ 个）⇒ 编辑器顶部工具条点不到。
//
//   根因**不是**透明覆盖层、也不是 WebView 的命中测试：状态栏是 **SystemUI 自己的窗口**，
//   位于应用窗口之上，那一带的触摸**按设计归它**（下拉通知栏就是靠它）。应用能把内容
//   *画*在那里，却**永远收不到那里的触摸**——这正是 window insets 存在的理由。
//   而 App 的 `targetSdk = 36`，Android 15 起对 SDK≥35 的 App **强制 edge-to-edge**，
//   去掉 `enableEdgeToEdge()` 在 Android 12 上有效、在 15+ 上**退不回去** ⇒
//   唯一正确的修法是**真的消费窗口 inset**。
//
//   为什么不能用 `env(safe-area-inset-top)` 兜：Android WebView 的 safe-area inset
//   取自**屏幕物理刘海**（display cutout），不是系统状态栏；这台机器没有刘海，
//   实测四个方向 `env()` **全是 0px**。所以 inset 必须由壳层送进来。
//
//   于是：监听 `WindowInsetsCompat`，把 systemBars 与 ime 折算成 **CSS px**，
//   用 `evaluateJavascript` 推给页面：
//       window.__SHUYONOTE_INSETS__({top,right,bottom,left,ime})
//   页面侧（`src/lib/viewportInsets.ts`）把它写成 `--sat/--sar/--sab/--sal/--kb`，
//   App.css 用这些变量给外壳与浮层让位——**顶部不再放任何可交互 UI**，触摸自然恢复。
//
// ### ② 软键盘遮挡底部弹层
//
//   实测键盘弹起后 `innerHeight` 与 `visualViewport.height` **都不变**，
//   `interactive-widget=resizes-content` 同样不生效。原因与 ① 同源：
//   `enableEdgeToEdge()`（= `setDecorFitsSystemWindows(false)`）之下
//   **系统的 `adjustResize` 是空转的**，窗口不会为 IME 缩小。
//   ⇒ **web 层不可能察觉键盘**，"读 visualViewport 写 --kb" 那条路在这台设备上走不通。
//   所以键盘高度也只能走同一条 inset 桥（`Type.ime()`），页面拿到 `--kb` 后
//   把底部弹层抬到键盘之上。
//
//   ⚠️ 因此**不**改 manifest 的 `windowSoftInputMode`：默认已经是 `adjustResize`，
//   在 edge-to-edge 下它是死代码；写上去只会让人以为"机制在 manifest 里"。
//
// ### ③ 返回键直接退出应用
//
//   `TauriActivity` 把 wry 的返回回调**关掉了**（`handleBackNavigation = false`，
//   tauri `mobile/android-codegen/TauriActivity.kt:35`），而 Tauri 自己的 Kotlin
//   `AppPlugin` 注册的回调在"没有 `back-button` 监听者"时走
//   `canGoBack()` ⇒ SPA 没有历史 ⇒ `false` ⇒ `activity.onBackPressed()` ⇒ **finish**。
//   这正好解释了实测的 `APP_STILL_FOREGROUND: False`。
//
//   上游给的逃生口是 `back-button` 事件（web 侧监听后 AppPlugin 就不再退出），
//   但**web 侧退不了应用**：`plugin:app|exit` 不在 `core:app` 的权限清单里
//   （见 `src-tauri/gen/schemas/acl-manifests.json`：有 `allow-register-listener`，
//   **没有** `allow-exit`），调用会被 ACL 直接拒掉。所以在移动端**必须由壳层退出**。
//
//   做法：`onWebViewCreate` 里注册自己的 `OnBackPressedCallback`。
//   `OnBackPressedDispatcher` 按**后注册先派发**，而 AppPlugin 的回调是在
//   `Builder::build` 阶段（`tauri` 的 `src/app/plugin.rs:141` 的 setup）注册的，
//   远早于 webview 创建 ⇒ 我们的回调**一定先被调用**。
//   它先问页面：`window.__SHUYONOTE_BACK__.handle()`（见 `src/lib/overlayStack.ts`）
//     · `true`  ⇒ 页面关掉了最上层浮层，本次返回键到此为止；
//     · `false` ⇒ 栈是空的：把自己 disable 后重新派发，落回 AppPlugin 那条回调
//                 （它没监听者 ⇒ `finish()`），应用正常退出。
//
// ## 用法
//
//   node scripts/android-mobile-shell.mjs            # 注入（覆盖写，可重复执行）
//   node scripts/android-mobile-shell.mjs --check     # 只检查（给门禁用，不写文件）
//   node scripts/android-mobile-shell.mjs --device-check   # 真机断言（需 adb + 已装自检包）
//
// ⚠️ 必须排在 `pnpm tauri android init --ci` **之后**（gen/ 是刚生成的）。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JAVA_DIR = join(ROOT, 'src-tauri/gen/android/app/src/main/java/cn/shuyo/shuyonote')
const MAIN_ACTIVITY = join(JAVA_DIR, 'MainActivity.kt')
/** 问系统「这个 content:// URI 叫什么 / 是什么类型」的本地 Tauri 插件（Rust 侧在
 *  `src-tauri/src/android_fs.rs`）。 */
const SHUYO_FS_PLUGIN = join(JAVA_DIR, 'ShuyoFsPlugin.kt')
/** Proguard 规则：R8 开着（`isMinifyEnabled = true`），而 `app/` 下的 `**`/*.pro`
 *  会被 `proguardFiles(fileTree(".")...)` 自动收走。 */
const PRO_FILE = join(ROOT, 'src-tauri/gen/android/app/shuyo-fs.pro')
/** Rust 侧那位"调用点"：脚本要从它里面读出类名/命令名，与 Kotlin 对齐。 */
const RUST_ANDROID_FS = join(ROOT, 'src-tauri/src/android_fs.rs')
/** AndroidManifest：应用内更新要往里面加 `REQUEST_INSTALL_PACKAGES` 与 FileProvider。 */
const MANIFEST = join(ROOT, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml')
/** FileProvider 的白名单路径（APK 落在应用缓存里，所以 `<cache-path>` 就够）。 */
const FILE_PATHS_XML = join(ROOT, 'src-tauri/gen/android/app/src/main/res/xml/shuyo_file_paths.xml')

/** 页面侧桥名（与 `src/lib/overlayStack.ts` / `src/lib/viewportInsets.ts` 同一个字符串）。 */
const INSETS_FN = '__SHUYONOTE_INSETS__'
const BACK_FN = '__SHUYONOTE_BACK__'

const MARK = '// [mobile-shell] 由 scripts/android-mobile-shell.mjs 注入，别手改 gen/'

const CHECK_ONLY = process.argv.includes('--check')
const DEVICE_CHECK = process.argv.includes('--device-check')

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

// ---------------------------------------------------------------- Kotlin 内容

const MAIN_ACTIVITY_KT = `package cn.shuyo.shuyonote

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

${MARK}
//
// 这个文件是**生成物**：内容在 scripts/android-mobile-shell.mjs 里，每次构建覆盖写。
// 直接改 gen/ 不会进库（gen/ 在 .gitignore 里），下次 CI init 就没了。
//
// 它做三件事：
//   1. 继续 edge-to-edge（targetSdk=36 ⇒ Android 15+ 本来就强制，退不回去）；
//   2. 把窗口 inset（状态栏 / 手势条 / 软键盘）折算成 CSS px 推给页面，
//      页面写成 --sat/--sab/--kb 并据此让位 —— 顶部那 41px 原来是触摸死区，
//      因为状态栏属于 SystemUI 的窗口，应用在那里收不到触摸，
//      所以**正确修法是别把可交互 UI 放进去**，而不是想办法穿透它；
//   3. 返回键先问页面的浮层栈（关掉最上层），栈空才放行退出应用。
class MainActivity : TauriActivity() {

  private var web: WebView? = null

  /** 最近一次算出来的 inset（CSS px），直接当 JS 对象字面量推给页面。 */
  private var insetsJs = "{\\"top\\":0,\\"right\\":0,\\"bottom\\":0,\\"left\\":0,\\"ime\\":0}"

  /**
   * 页面 JS 可能在首次 inset 分发时还没就绪（分发发生在 layout，早于页面 load 完成）。
   * 所以启动后按 200ms 的节奏重复推送若干次；页面侧是**幂等**的（就是 setProperty）。
   * 单条链（removeCallbacks + post）而不是每次 kick 起一条，避免叠成多条。
   */
  private var pushesLeft = 0
  private val pump = object : Runnable {
    override fun run() {
      if (pushesLeft <= 0) return
      pushesLeft -= 1
      web?.evaluateJavascript(
        "window.${INSETS_FN} && window.${INSETS_FN}($insetsJs)",
        null,
      )
      web?.postDelayed(this, 200L)
    }
  }

  private var backRegistered = false

  /**
   * 返回键：先问 web 的浮层栈。
   *
   * ⚠️ 返回值必须是**真布尔**：下面用 \`=== true\` 取值，\`evaluateJavascript\` 的回调
   * 拿到的是字符串 'true' / 'false' / 'null'（页面里没有这个桥时是 null ⇒ 直接退）。
   */
  private val backCallback = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() {
      val w = web
      if (w == null) {
        quitApp()
        return
      }
      w.evaluateJavascript(
        "(window.${BACK_FN} && window.${BACK_FN}.handle()) === true",
      ) { result ->
        if (result?.trim('"') != "true") quitApp()
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // 必须在 super 之前：edge-to-edge 要在窗口装饰建立时生效。
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    web = webView

    // inset 桥：把系统 inset 送给页面。返回原样 insets，不消费、不改变别的行为
    // （wry 自己不碰 WindowInsets，见 wry-0.55.1 全仓 grep：一处都没有）。
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      onWindowInsets(insets)
      insets
    }

    kickPushes(50)

    // 只注册一次：onWebViewCreate 在多窗口/重建场景下可能被再次调用。
    if (!backRegistered) {
      backRegistered = true
      onBackPressedDispatcher.addCallback(this, backCallback)
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // 切回前台时补推几次：这期间页面可能刚被系统重建过。
    if (hasFocus) kickPushes(10)
  }

  private fun kickPushes(n: Int) {
    val w = web ?: return
    if (n > pushesLeft) pushesLeft = n
    w.removeCallbacks(pump)
    w.post(pump)
  }

  private fun onWindowInsets(insets: WindowInsetsCompat) {
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val json = "{\\"top\\":" + css(bars.top) +
      ",\\"right\\":" + css(bars.right) +
      ",\\"bottom\\":" + css(bars.bottom) +
      ",\\"left\\":" + css(bars.left) +
      ",\\"ime\\":" + css(ime.bottom) + "}"
    if (json == insetsJs) return
    insetsJs = json
    // inset 变了（旋转 / 键盘弹起收起 / 手势条）⇒ 立刻推，并补几次覆盖页面重载窗口。
    kickPushes(6)
  }

  /**
   * 设备 px → CSS px。
   *
   * 用 \`displayMetrics.density\`（= 页面里的 \`devicePixelRatio\`）折算，而不是让页面
   * 自己除：真机实测 1080/123 = 密度 3.0 ⇒ 41 CSS px，与 \`dumpsys\` 完全对得上。
   */
  private fun css(devicePx: Int): Float {
    val d = resources.displayMetrics.density
    if (d <= 0f) return 0f
    return Math.round(devicePx / d * 100f) / 100f
  }

  /** 栈空时放行返回键：disable 自己再派发，落回 AppPlugin 那条回调（它会 finish）。 */
  private fun quitApp() {
    backCallback.isEnabled = false
    onBackPressedDispatcher.onBackPressed()
    backCallback.isEnabled = true
  }
}
`

// ------------------------------------------------- Android：文件选择器的"名字/类型"插件

// 真机症状（2026-09-17）：经系统文件选择器导入的附件显示成
//   📎41449ced-d44e-4d3c-8e14-7c6733ad042a  未整理  文件  1.8 KB
// 名字和 mime 同时丢 —— 因为 `tauri-plugin-dialog` 的 Android 实现只把
// `uri.toString()` 交出来（`DialogPlugin.kt::createPickFilesResult`），Rust 侧
// 于是把选中文件拷成**裸 UUID、无扩展名**的临时文件，而下游 `mime_from_path`
// **只看扩展名** ⇒ octet-stream ⇒ 前端的 `file.mime` 分支全都进不去
// （内置文件预览 / PDF 阅读器 / 照片墙），掉到 `opener.openPath()` 也失败。
//
// URI 尾段救不了：外置存储那条是 `primary%3ADownload%2Fphoto.png`（能解出真名），
// 但 MediaStore/Downloads 给的是 `image%3A1234` / `msf%3A1000000042` —— **那是 id**。
// 名字只有 `ContentResolver.query(OpenableColumns.DISPLAY_NAME)` 知道，
// mime 只有 `ContentResolver.getType(uri)` 知道，**两者都只在 Android 运行时里**。
//
// 所以这里注入一个正经的本地 Tauri 插件（与 tauri-plugin-fs/-opener/-dialog 同一套
// 机制），Rust 侧 `api.register_android_plugin(...)` + `run_mobile_plugin(...)` 调用。
const SHUYO_FS_PLUGIN_KT = `package cn.shuyo.shuyonote

import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

${MARK}
//
// 这个文件是**生成物**：内容在 scripts/android-mobile-shell.mjs 里，每次构建覆盖写。
// 直接改 gen/ 不会进库（gen/ 在 .gitignore 里），下次 CI init 就没了。
//
// 它只回答一个问题：**系统选择器给的这个 content:// URI 叫什么名字、是什么类型**。
// 调用方是 Rust：src-tauri/src/android_fs.rs（类名与命令名两边必须对得上，
// scripts/android-mobile-shell.mjs --check 会把这两边一起核）。
//
// 失败一律**返回空串**，绝不抛出去：拿不到名字不该让导入失败 —— Rust 侧会依次
// 退回"URI 尾段启发"与"按内容嗅探（magic bytes）"。
@InvokeArg
class PickedFileInfoArgs {
  lateinit var uri: String
}

@InvokeArg
class InstallApkArgs {
  lateinit var path: String
}

@TauriPlugin
class ShuyoFsPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun pickedFileInfo(invoke: Invoke) {
    val args = invoke.parseArgs(PickedFileInfoArgs::class.java)
    val resolver = activity.contentResolver
    val res = JSObject()
    res.put("name", displayName(resolver, args.uri))
    res.put("mime", mimeType(resolver, args.uri))
    invoke.resolve(res)
  }

  /**
   * C2 网络闸门：当前网络的**传输类型**。
   *
   * 只回答"现在是不是 Wi-Fi"，**不做任何猜测**——不用 UA、不看平台名。
   * 拿不到就回 unknown，由前端按"不确定 ⇒ **不**自动拉取"处理（fail-safe）。
   *
   * ⚠️ 这段注释里**不要写反引号**：整个 Kotlin 源是 JS 模板字符串里的一段，
   * 反引号会把模板提前截断（这次就踩了一次，脚本直接 SyntaxError）。
   */
  @Command
  fun networkType(invoke: Invoke) {
    val res = JSObject()
    res.put("kind", currentNetworkKind())
    invoke.resolve(res)
  }

  /**
   * 传输类型：wifi / cellular / ethernet / other / none / unknown。
   *
   * 与 displayName 同样的理由刻意写笨：这段 Kotlin **本机编不了**（要 Android SDK/NDK），
   * 只有 CI 会编它 —— 宁可啰嗦也不要巧妙。任何异常都退化成 unknown，绝不抛出去。
   */
  private fun currentNetworkKind(): String {
    try {
      val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val net = cm.activeNetwork
      if (net == null) return "none"
      val caps = cm.getNetworkCapabilities(net)
      if (caps == null) return "none"
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi"
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular"
      if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet"
      return "other"
    } catch (e: Exception) {
      return "unknown"
    }
  }

  /**
   * OpenableColumns.DISPLAY_NAME —— **原始文件名**，这是唯一可靠来源。
   *
   * 刻意用最笨的写法（不用 use/非局部返回）：这段 Kotlin **本机编不了**
   * （要 Android SDK/NDK），只有 CI 会编它，所以宁可啰嗦也不要巧妙。
   */
  private fun displayName(resolver: ContentResolver, raw: String): String {
    if (!raw.startsWith("content://")) return ""
    var out = ""
    var cursor: Cursor? = null
    try {
      cursor = resolver.query(
        Uri.parse(raw),
        arrayOf(OpenableColumns.DISPLAY_NAME),
        null,
        null,
        null,
      )
      if (cursor != null && cursor.moveToFirst()) {
        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0) {
          val value = cursor.getString(idx)
          if (value != null) out = value
        }
      }
    } catch (e: Exception) {
      out = ""
    } finally {
      try {
        cursor?.close()
      } catch (e: Exception) {
        // 关不掉就算了，别让它盖住真正的结果。
      }
    }
    return out
  }

  /** ContentResolver.getType —— provider 自己声明的 mime，比我们那张扩展名表权威。 */
  private fun mimeType(resolver: ContentResolver, raw: String): String {
    if (!raw.startsWith("content://")) return ""
    return try {
      val t = resolver.getType(Uri.parse(raw))
      if (t == null) "" else t
    } catch (e: Exception) {
      ""
    }
  }

  /**
   * 应用内更新的第二步：把下好的 APK 交给**系统安装器**。
   *
   * 三条必须守住的：
   *  · 路径要经 FileProvider 换成 content:// —— file:// 从 Android 7 起直接抛
   *    FileUriExposedException；authority 必须与 AndroidManifest 里那个 provider 一致
   *    （脚本注入时用的是 \`\${applicationId}.fileprovider\`，这里用 packageName 拼，两者相同）。
   *  · 只 \`startActivity(ACTION_VIEW)\`，**不做静默安装**：Android 8 起"从应用里装 APK"
   *    要用户给本应用开「安装未知应用」，那个确认界面是系统的，选择权留给用户。
   *  · 失败要把原因回给 Rust（前端据此给"前往发布页"的退路），不要静默什么都不发生。
   */
  @Command
  fun installApk(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(InstallApkArgs::class.java)
      val file = File(args.path)
      if (!file.exists()) {
        invoke.reject("安装包不存在：\${args.path}")
        return
      }
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
      val intent = Intent(Intent.ACTION_VIEW)
      intent.setDataAndType(uri, "application/vnd.android.package-archive")
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity.startActivity(intent)
      invoke.resolve(JSObject())
    } catch (e: Exception) {
      invoke.reject(e.message ?: "拉起系统安装器失败")
    }
  }
}
`

// ⚠️ **R8 是开着的**（`gen/android/app/build.gradle.kts` 的 `isMinifyEnabled = true`），
// 而这个类**只被 JNI/反射按名字调用**（Rust 侧 FindClass + `PluginManager` 反射找
// `@Command` 方法），R8 看不到任何 Java 静态引用 ⇒ 会把它当死代码删掉或改名，
// 运行时直接 ClassNotFoundException / "Plugin shuyo-fs not initialized"。
// **漏了这段就是"CI 绿、真机 release 炸"**（与 rustls-platform-verifier 那条同源，
// 见 scripts/android-platform-verifier.mjs）。
const PROGUARD = `# 我们自己注入的 Android 壳插件（scripts/android-mobile-shell.mjs 生成）。
# 只被 JNI/反射按名字调用，必须 keep，否则 release（R8 开着）上找不到类/方法。
-keep class cn.shuyo.shuyonote.ShuyoFsPlugin { *; }
-keep class cn.shuyo.shuyonote.PickedFileInfoArgs { *; }
-keep class cn.shuyo.shuyonote.InstallApkArgs { *; }
# tauri 的注解与"被注解的方法/字段"是反射的入口。
-keep class app.tauri.annotation.** { *; }
-keepclassmembers class * { @app.tauri.annotation.Command <methods>; }
-keepclassmembers class * { @app.tauri.annotation.InvokeArg <fields>; }
`

if (!existsSync(join(ROOT, 'src-tauri/gen/android/app'))) {
  fail(
    `找不到 src-tauri/gen/android/app\n` +
      '  gen/ 是生成物（不入库），所以这一步必须在 `pnpm tauri android init` **之后**跑。',
  )
}

// ---------------------------------------------------------------- 应用内更新（APK 安装）

/**
 * AndroidManifest 的两处注入（应用内更新要拉起系统安装器）：
 *  · `REQUEST_INSTALL_PACKAGES` 权限——Android 8 起"从应用里装 APK"需要它；
 *    真正装不装仍由用户决定（系统会让你先给本应用开「安装未知应用」）。
 *  · `FileProvider`——APK 必须以 `content://` 交出去（`file://` 从 Android 7 起抛
 *    `FileUriExposedException`）。authority 用 `${applicationId}.fileprovider`，
 *    与 Kotlin 侧 `activity.packageName + ".fileprovider"` 一致。
 *
 * 为什么用"找不到才插"而不是"整份覆盖写"：manifest 里有 tauri 生成的一堆节点
 * （activity/usesCleartextTraffic 等），我们只该往里加东西，不该重写别人的。
 */
const FILE_PATHS = `<?xml version="1.0" encoding="utf-8"?>
<!-- APK 落在应用缓存目录（app_cache_dir/updates/），所以 cache-path 就够。
     这份白名单是 FileProvider 允许分享出去的路径**范围**：写宽了等于把私有目录
     整个暴露给任何拿到 URI 的应用，所以只列真正用到的那一个。 -->
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="updates" path="updates/" />
</paths>
`

function injectManifest() {
  if (!existsSync(MANIFEST)) {
    fail(`找不到 ${MANIFEST}\n  gen/ 是生成物，这一步必须在 \`pnpm tauri android init\` **之后**跑。`)
  }
  let xml = readFileSync(MANIFEST, 'utf8')
  let changed = false
  if (!xml.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
    xml = xml.replace(
      /<manifest([^>]*)>/,
      (m, attrs) =>
        `<manifest${attrs}>\n` +
        '    <!-- 应用内更新：把下好的 APK 交给系统安装器（见 docs/MOBILE.md §2.5）。\n' +
        '         装不装由用户决定——Android 8+ 还会要求用户给本应用开「安装未知应用」。 -->\n' +
        '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
    )
    changed = true
  }
  // C2 网络闸门（2026-09-15）：读当前网络类型要 `ACCESS_NETWORK_STATE`。
  // ⚠️ 它是**普通权限**（normal）——安装即授予，**不弹窗、不需要运行时申请**，
  // 所以这里只加声明，不碰 `MainActivity` 的权限请求流程。
  if (!xml.includes('android.permission.ACCESS_NETWORK_STATE')) {
    xml = xml.replace(
      /<manifest([^>]*)>/,
      (m, attrs) =>
        `<manifest${attrs}>\n` +
        '    <!-- C2 网络闸门：读当前网络类型（是不是 Wi-Fi）要这个权限。\n' +
        '         它是普通权限——安装即授予，不会弹窗。 -->\n' +
        '    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
    )
    changed = true
  }
  if (!xml.includes('shuyo_file_paths')) {
    xml = xml.replace(
      /<\/application>/,
      '        <!-- APK 经 FileProvider 换成 content://（file:// 从 Android 7 起会抛 FileUriExposedException）。\n' +
        '             authority 必须与 ShuyoFsPlugin.installApk 里拼的那个一致。 -->\n' +
        '        <provider\n' +
        '            android:name="androidx.core.content.FileProvider"\n' +
        '            android:authorities="${applicationId}.fileprovider"\n' +
        '            android:exported="false"\n' +
        '            android:grantUriPermissions="true">\n' +
        '            <meta-data\n' +
        '                android:name="android.support.FILE_PROVIDER_PATHS"\n' +
        '                android:resource="@xml/shuyo_file_paths" />\n' +
        '        </provider>\n' +
        '    </application>',
    )
    changed = true
  }
  if (changed) writeFileSync(MANIFEST, xml, 'utf8')
  return changed
}

if (CHECK_ONLY) {
  if (!existsSync(MAIN_ACTIVITY)) {
    fail(`缺少 ${MAIN_ACTIVITY}（CI 里应排在 \`pnpm tauri android init --ci\` 之后、\`pnpm android:mobile-shell\` 之前）`)
  }
  const kt = readFileSync(MAIN_ACTIVITY, 'utf8')
  // 三处注入缺一不可，而且都要能被机器判定（这类回归**只有真机看得见**）。
  for (const [needle, why] of [
    ['enableEdgeToEdge()', '没有 edge-to-edge（或没调）'],
    ['setOnApplyWindowInsetsListener', '没有 inset 桥 ⇒ 顶部又会被状态栏压住'],
    ['OnBackPressedCallback', '没有返回键回调 ⇒ 返回键会直接退出应用'],
    [INSETS_FN, '没有推送 inset 函数名（与页面侧对不上）'],
    [BACK_FN, '没有浮层栈桥名（与页面侧对不上）'],
  ]) {
    if (!kt.includes(needle)) fail(`${MAIN_ACTIVITY} 缺少 \`${needle}\`：${why}`)
  }
  if (!kt.includes('.trim(\'"\')')) {
    fail('返回键回调没有按 "true" 判定 —— 返回值会被当成"永远关掉了浮层"，返回键再也退不出应用')
  }

  // ---- 文件选择器插件：类 + .pro + 调用点，三样一起把关 ----
  //
  // 这一段存在的理由是**它坏起来只有真机 release 看得见**：
  //   · Kotlin 类没注入 ⇒ Rust 侧 `register_android_plugin` 直接 FindClass 失败；
  //   · 少一个 `@Command` 方法 ⇒ `run_mobile_plugin` 回"命令不存在"；
  //   · 少了 .pro ⇒ debug/CI 全绿，**release 上才** ClassNotFoundException（R8 删了它）；
  //   · 两边名字对不上（改了 Kotlin 忘了改 Rust）⇒ 编译全过，运行时静默退化成
  //     "问不到名字"（表现就是这条 bug 原样复发）。
  if (!existsSync(SHUYO_FS_PLUGIN)) {
    fail(`缺少 ${SHUYO_FS_PLUGIN}（应排在 \`pnpm android:mobile-shell\` 之后）`)
  }
  const fsKt = readFileSync(SHUYO_FS_PLUGIN, 'utf8')
  for (const [needle, why] of [
    ['@TauriPlugin', '没有 @TauriPlugin 注解 ⇒ PluginManager 不认这个类'],
    ['@InvokeArg', '没有 @InvokeArg ⇒ Kotlin 侧 parseArgs 反序列化不出 uri'],
    ['OpenableColumns.DISPLAY_NAME', '没有查 DISPLAY_NAME ⇒ 原始文件名还是拿不到（这条 bug 的一半）'],
    ['getType(', '没有 ContentResolver.getType ⇒ mime 拿不到'],
    // 应用内更新第二步：没有这段，前端就只能让用户自己去文件管理器点安装。
    ['FileProvider.getUriForFile', '没有 FileProvider ⇒ 交出去的是 file://，Android 7+ 抛 FileUriExposedException'],
    ['application/vnd.android.package-archive', '拉安装器的 intent 类型不对 ⇒ 系统不知道这是个 APK'],
    // C2 网络闸门：没有这段就只剩"猜"，而"猜"是我们明确拒绝的（见 platform/index.ts 的告警）。
    ['ConnectivityManager', '没有 ConnectivityManager ⇒ 拿不到真实网络类型（C2 会退化成"永远 unknown"）'],
    ['TRANSPORT_WIFI', '没有判 TRANSPORT_WIFI ⇒ 分不出 Wi-Fi 与蜂窝'],
  ]) {
    if (!fsKt.includes(needle)) fail(`${SHUYO_FS_PLUGIN} 缺少 \`${needle}\`：${why}`)
  }

  // **两边名字对齐**：Rust 侧声明了类名与每个命令名，Kotlin 侧必须真的存在同名类/方法。
  // 这是唯一能挡住"改了一边忘了另一边"的机器判据。
  // ⚠️ 命令可能不止一个（pickedFileInfo / installApk），所以要**全量**比对，
  //    只 `match` 第一个的话，"新加的那个命令忘了写 Kotlin"会被漏掉。
  if (!existsSync(RUST_ANDROID_FS)) fail(`缺少 ${RUST_ANDROID_FS}（Rust 侧的调用点）`)
  const rust = readFileSync(RUST_ANDROID_FS, 'utf8')
  const className = (rust.match(/PLUGIN_CLASS:\s*&str\s*=\s*"([A-Za-z0-9_]+)"/) || [])[1]
  if (!className) fail(`${RUST_ANDROID_FS} 里读不到 PLUGIN_CLASS（Rust 与 Kotlin 的类名要对齐）`)
  if (!fsKt.includes(`class ${className}`)) {
    fail(`Kotlin 里没有 \`class ${className}\` —— 与 Rust 侧 PLUGIN_CLASS 对不上`)
  }
  const allRust = readFileSync(join(ROOT, 'src-tauri/src/updates.rs'), 'utf8') + rust
  const commands = [...allRust.matchAll(/run_mobile_plugin::<[^>]+>\("([A-Za-z0-9_]+)"/g)].map((m) => m[1])
  if (commands.length === 0) fail('读不到任何 `run_mobile_plugin("<命令名>"` —— Rust 侧没有调用点？')
  for (const cmd of new Set(commands)) {
    if (!fsKt.includes(`fun ${cmd}(`)) {
      fail(`Kotlin 里没有 \`fun ${cmd}(\` —— 与 Rust 侧 run_mobile_plugin 的命令名对不上`)
    }
    if (!fsKt.includes(`@Command\n  fun ${cmd}(`)) {
      fail(`\`${cmd}\` 前面少了 @Command —— PluginManager 只登记被注解的方法`)
    }
  }

  // 注入点那个包名也要与 Rust 侧一致（写错包名 = FindClass 失败）
  const pkg = (rust.match(/PLUGIN_IDENTIFIER:\s*&str\s*=\s*"([a-z0-9_.]+)"/) || [])[1]
  if (!pkg) fail(`${RUST_ANDROID_FS} 里读不到 PLUGIN_IDENTIFIER`)
  if (!fsKt.startsWith(`package ${pkg}`)) {
    fail(`${SHUYO_FS_PLUGIN} 的 package 必须是 ${pkg}（与 Rust 侧 PLUGIN_IDENTIFIER 一致）`)
  }

  // `.pro`：R8 开着，漏了就是"CI 绿、release 真机炸"。
  if (!existsSync(PRO_FILE)) {
    fail(`缺少 ${PRO_FILE} —— release 开了 R8，没有 keep 规则会把这个只被反射调用的类删掉`)
  }
  const pro = readFileSync(PRO_FILE, 'utf8')
  for (const [needle, why] of [
    [`-keep class ${pkg}.${className} { *; }`, '这个类只被 JNI/反射按名字调用，不 keep 会被删/改名'],
    [`-keep class ${pkg}.InstallApkArgs { *; }`, '安装参数类同理（R8 改名后 parseArgs 反序列化不出来）'],
    ['@app.tauri.annotation.Command', '@Command 方法是反射入口，方法名不能被 R8 改掉'],
    ['@app.tauri.annotation.InvokeArg', '@InvokeArg 的字段是反射入口'],
  ]) {
    if (!pro.includes(needle)) fail(`${PRO_FILE} 缺少 \`${needle}\`：${why}`)
  }

  // ---- 应用内更新：manifest 权限 + FileProvider + 白名单路径 ----
  // 这三样缺任何一个，手机上"下载完点安装"都会失败，而且**只有真机能发现**
  // （CI 编译得过、桌面上根本不走这条路）。
  if (!existsSync(MANIFEST)) fail(`缺少 ${MANIFEST}`)
  const man = readFileSync(MANIFEST, 'utf8')
  for (const [needle, why] of [
    ['android.permission.REQUEST_INSTALL_PACKAGES', 'Android 8+ 从应用里装 APK 需要这个权限'],
    ['android.permission.ACCESS_NETWORK_STATE', 'C2 网络闸门读网络类型要它（普通权限，不弹窗）'],
    ['androidx.core.content.FileProvider', '没有 FileProvider ⇒ APK 只能以 file:// 交出去，Android 7+ 直接抛异常'],
    ['android:authorities="${applicationId}.fileprovider"', 'FileProvider 的 authority 与 Kotlin 侧拼的那个必须一致'],
    ['@xml/shuyo_file_paths', 'FileProvider 没有路径白名单 ⇒ getUriForFile 抛 IllegalArgumentException'],
  ]) {
    if (!man.includes(needle)) fail(`${MANIFEST} 缺少 \`${needle}\`：${why}`)
  }
  if (!existsSync(FILE_PATHS_XML)) fail(`缺少 ${FILE_PATHS_XML}（FileProvider 的路径白名单）`)
  if (!readFileSync(FILE_PATHS_XML, 'utf8').includes('cache-path')) {
    fail(`${FILE_PATHS_XML} 里没有 <cache-path> —— APK 下在应用缓存目录，不在白名单里就分享不出去`)
  }

  console.log('✅ Android 壳适配层已注入（--check）')
  process.exit(0)
}

mkdirSync(JAVA_DIR, { recursive: true })
// MainActivity.kt 是我们自己的文件（tauri 模板里它是空的壳）：整份覆盖写，
// 与 `android-platform-verifier.mjs` 写 .pro 规则同一个道理——内容必须跟着脚本走，
// 不让手工改动留在 gen/ 里。
writeFileSync(MAIN_ACTIVITY, MAIN_ACTIVITY_KT, 'utf8')
console.log(`已写入 Android 壳适配层（inset 桥 + 返回键）→ ${MAIN_ACTIVITY}`)

// 选择器插件（Kotlin）+ 它的 Proguard 规则：同样是**整份覆盖写**的生成物。
writeFileSync(SHUYO_FS_PLUGIN, SHUYO_FS_PLUGIN_KT, 'utf8')
console.log(`已写入 Android 选择器插件（DISPLAY_NAME + getType）→ ${SHUYO_FS_PLUGIN}`)
writeFileSync(PRO_FILE, PROGUARD, 'utf8')
console.log(`已写入 Proguard 规则（R8 keep）→ ${PRO_FILE}`)

// 应用内更新的两处 manifest 注入 + FileProvider 白名单（找不到才插，不重写别人的节点）
const manifestChanged = injectManifest()
mkdirSync(dirname(FILE_PATHS_XML), { recursive: true })
writeFileSync(FILE_PATHS_XML, FILE_PATHS, 'utf8')
console.log(`已写入 FileProvider 白名单 → ${FILE_PATHS_XML}`)
console.log(`AndroidManifest 注入（权限 + FileProvider）：${manifestChanged ? '本次写入' : '已存在，未改动'}`)


// ---------------------------------------------------------------- 真机断言

if (DEVICE_CHECK) {
  const pkg = process.env.ANDROID_PACKAGE || 'cn.shuyo.shuyonote'
  const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' }).trim()
  let pass = 0
  let failed = 0
  const ok = (cond, msg) => {
    if (cond) {
      pass++
      console.log(`  ✓ ${msg}`)
    } else {
      failed++
      console.error(`  ✗ ${msg}`)
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const main = async () => {
    const devices = adb('devices').split('\n').slice(1).filter((l) => l.includes('\tdevice'))
    if (!devices.length) fail('没有已连接的设备（adb devices 为空）')
    console.log(`设备: ${devices[0].split('\t')[0]}`)

    // WebView 的 devtools socket（调试包才有）——用它读页面里的真实几何。
    const unix = adb('shell', 'cat', '/proc/net/unix')
    const sock = (unix.match(/@?([^\s]*webview_devtools_remote[^\s]*)/) || [])[1]
    ok(!!sock, `找到 WebView devtools socket（${sock || '没有——是否 debug 构建？'}）`)
    if (!sock) return process.exit(1)
    adb('forward', 'tcp:9222', `localabstract:${sock.replace(/^@/, '')}`)

    const { default: puppeteer } = await import('puppeteer-core')
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' })
    const pages = await browser.pages()
    const page = pages[pages.length - 1]

    const density = await page.evaluate(() => window.devicePixelRatio)
    const tap = async (x, y) => {
      adb('shell', 'input', 'tap', String(Math.round(x * density)), String(Math.round(y * density)))
      await sleep(500)
    }

    // ---- ① 顶部 inset 真的到位：状态栏高度 > 0，且**没有可交互 UI 落在状态栏里** ----
    const geo = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement)
      const appEl = document.querySelector('.app')
      // ⚠️ 量 `.app` 自己的 `getBoundingClientRect().top` 是**量错对象**：
      // 它量的是 border box，padding 不会改变它（永远是 0）。要看的是 padding
      // 与"最高的那个可交互元素"。
      const tops = [...document.querySelectorAll("button, input, textarea, select, a[href], [role='button']")]
        .map((el) => el.getBoundingClientRect())
        .filter((b) => b.width > 1 && b.height > 1 && b.top >= -1)
        .map((b) => b.top)
      return {
        sat: cs.getPropertyValue('--sat').trim(),
        kb: cs.getPropertyValue('--kb').trim(),
        appPaddingTop: appEl ? getComputedStyle(appEl).paddingTop : null,
        innerH: window.innerHeight,
        firstInteractiveTop: tops.length ? Math.min(...tops) : null,
      }
    })
    const satPx = parseFloat(geo.sat) || 0
    ok(satPx > 0, `--sat 是真实值（${geo.sat}）——env(safe-area-inset-top) 在 Android 上恒为 0，这就是必须走壳层桥的原因`)
    ok(
      geo.appPaddingTop === geo.sat,
      `外壳用 padding 让开了状态栏（.app padding-top=${geo.appPaddingTop}）`,
    )
    ok(
      geo.firstInteractiveTop !== null && geo.firstInteractiveTop >= satPx - 0.5,
      `状态栏那一条带里**没有可交互元素**（最高的一个 y=${geo.firstInteractiveTop} ≥ ${satPx}）` +
        `⇒ 顶部不再是"看着在、点不到"的死区`,
    )

    // ---- ② 顶部真的能点到：装一个点击计数，然后**用真实 input tap** 点它 ----
    // ⚠️ 这里**必须**用 `adb shell input tap`（真实输入路径），不能用 CDP 的
    // `Input.dispatchTouchEvent`——后者直接注入渲染进程，**绕过了 SystemUI 的窗口**，
    // 在触摸死区里也会"成功"。上一轮就是靠真实 tap 才量出 y≤123 是 0 个事件。
    const probeY = Number(process.env.TAP_Y_CSS || (geo.firstInteractiveTop ?? 60) + 14)
    const probeX = Number(process.env.TAP_X_CSS || 40)
    await page.evaluate(() => {
      window.__TAPCOUNT = 0
      document.addEventListener('pointerdown', () => { window.__TAPCOUNT++ }, true)
      document.addEventListener('click', () => { window.__TAPCOUNT++ }, true)
    })
    await tap(probeX, probeY)
    const taps = await page.evaluate(() => window.__TAPCOUNT)
    ok(taps > 0, `真实 tap 打在 y=${probeY} CSS px 上收到了 DOM 事件（计数 ${taps} > 0）——修前 y≤41 是 0`)

    // ---- ③ 返回键：浮层开着时不许退出应用 ----
    const before = await page.evaluate(() =>
      document.querySelector('.app') ? 1 : 0,
    )
    ok(before === 1, '页面在跑（.app 存在）')
    // 用 DOM 点击打开搜索浮层（这里验的是"返回键 → 壳层 → 浮层栈"这条链，不是触摸投递）
    const opened = await page.evaluate(async () => {
      const m = await import('/src/store/palette.ts').catch(() => null)
      if (m) {
        m.usePalette.getState().setOpen(true)
        return 'palette'
      }
      return null
    })
    await sleep(800)
    const depth = await page.evaluate(
      () => (window.__SHUYONOTE_BACK__ ? window.__SHUYONOTE_BACK__.depth() : -1),
    )
    if (opened) {
      ok(depth > 0, `浮层栈里有 ${depth} 层（桥在、栈非空）`)
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
      await sleep(800)
      const after = await page.evaluate(() =>
        window.__SHUYONOTE_BACK__ ? window.__SHUYONOTE_BACK__.depth() : -1,
      )
      ok(after === depth - 1, `返回键关掉了最上层浮层（${depth} → ${after}），**没有退出应用**`)
      const fg = adb('shell', 'dumpsys', 'activity', 'activities')
      ok(
        /APP_STILL_FOREGROUND:\s*True/i.test(fg),
        'dumpsys 判据：APP_STILL_FOREGROUND = True（修前是 False ⇒ 应用直接退到桌面）',
      )
    } else {
      console.log('  · 打包构建读不到 /src/store/*（源码路径只在 dev server 下可用）——返回键那条留给下面的手动判据')
    }

    // ---- ④ 软键盘：--kb 必须 > 0，且底部弹层抬到键盘之上 ----
    const inputRect = await page.evaluate(() => {
      const el = document.querySelector('.search-popover input, .palette input, .set-dialog input')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    if (inputRect) {
      await tap(inputRect.x, inputRect.y)
      await sleep(1200)
      const kb = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement)
        const box = document.querySelector('.search-popover, .palette, .set-dialog')
        const r = box ? box.getBoundingClientRect() : null
        return {
          kb: parseFloat(cs.getPropertyValue('--kb')) || 0,
          boxBottom: r ? r.bottom : null,
          innerH: window.innerHeight,
          imeShown: true,
        }
      })
      ok(kb.kb > 0, `键盘可见时 --kb=${kb.kb}px > 0（修前 innerHeight/visualViewport 都不变 ⇒ web 层察觉不到键盘）`)
      ok(
        kb.boxBottom !== null && kb.boxBottom <= kb.innerH - kb.kb + 2,
        `弹层底边 (${kb.boxBottom}) 在键盘之上 (innerHeight ${kb.innerH} − kb ${kb.kb})`,
      )
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
      await sleep(600)
    } else {
      console.log('  · 没找到可聚焦的输入框（先手动打开一个带输入框的浮层再跑本项）')
    }

    browser.disconnect()
    console.log(`\n[结果] ${pass} 通过 / ${failed} 失败`)
    process.exit(failed ? 1 : 0)
  }

  main().catch((e) => fail(`真机断言异常：${(e && e.message) || e}`))
}
