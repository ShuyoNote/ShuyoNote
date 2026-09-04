import { WebviewController, Web } from "@kit.ArkWeb";
import { hilog } from "@kit.PerformanceAnalysisKit";

// 阶段 0/1：ArkWeb 壳加载 ShuyoNote Web 版。
// - 默认加载本地打包的 dist-web（resources/rawfile/shuyo/index.html），离线可用。
// - 便于 POC 验证 WASM/IndexedDB/contenteditable：可临时切到远程 URL。
@Entry
@Component
struct Index {
  controller: WebviewController = new WebviewController();
  // 本地：$rawfile('shuyo/index.html')；远程（POC 验证）：'http://121.199.8.24/app/'
  // 注意：ArkWeb 对远程跨域资源需配置，本地 rawfile 无此问题。
  private src: Resource | string = $rawfile("shuyo/index.html");

  build() {
    Column() {
      Web({ src: this.src as Resource, controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .onlineImageAccess(true)
        .onConsoleMessage((m) => {
          hilog.info(0x0000, "ShuyoNote", "web[%{public}s] %{public}s", m.level, m.message);
          return true;
        })
        .onErrorReceive((e) => {
          hilog.error(0x0000, "ShuyoNote", "web error %{public}s", JSON.stringify(e));
        })
        .width("100%")
        .height("100%");
    }
    .width("100%")
    .height("100%");
  }
}
