import { WebviewController, Web } from "@kit.ArkWeb";
import { hilog } from "@kit.PerformanceAnalysisKit";

// 阶段 0/1：ArkWeb 壳加载 ShuyoNote Web 版。
// - 默认加载本地打包的 dist-web（resources/rawfile/shuyo/index.html），离线可用。
// - 便于 POC 验证 WASM/IndexedDB/contenteditable：可临时切到远程 URL。
// 运行前把 Web 版 build 产物拷到 rawfile/shuyo/（见 hongmeng/README.md）。
@Entry
@Component
struct Index {
  controller: WebviewController = new WebviewController();
  @State pageLoading: boolean = true;
  @State pageError: boolean = false;
  // 本地：$rawfile('shuyo/index.html')；远程（POC 验证）：'http://121.199.8.24/app/'
  private src: Resource | string = $rawfile("shuyo/index.html");

  build() {
    Column() {
      Web({ src: this.src as Resource, controller: this.controller })
        .javaScriptAccess(true)
        .javaScriptProxy({ object: this, name: "hmBridge", methodList: ["notifyReady"], controller: this.controller })
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .onlineImageAccess(true)
        .mixedMode(0) // 0=MIXED_CONTENT_ALWAYS_ALLOW（加载 http 资源）
        .onPageBegin(() => { this.pageLoading = true; this.pageError = false; })
        .onPageEnd(() => { this.pageLoading = false; })
        .onConsoleMessage((m) => {
          hilog.info(0x0000, "ShuyoNote", "web[%{public}s] %{public}s", m.level, m.message);
          return true;
        })
        .onErrorReceive((e) => {
          hilog.error(0x0000, "ShuyoNote", "web error %{public}s", JSON.stringify(e));
          this.pageError = true;
          this.pageLoading = false;
        })
        .onPermissionRequest((e) => {
          // 允许页面请求权限（Web 版一般不需要，留作音/视频等扩展）。
          const res = e.request.getAccessibleResource();
          if (res) e.request.grant(res);
          return true;
        })
        .width("100%")
        .height("100%");

      if (this.pageLoading) {
        LoadingProgress().width("100%").height("100%");
      }
      if (this.pageError) {
        Column() {
          Text("加载失败").fontSize(18).fontColor("#555").margin({ bottom: 8 });
          Text("请把 Web 版 dist-web 拷到 rawfile/shuyo/ 后重试。").fontSize(14).fontColor("#888").textAlign(TextAlign.Center);
          Button("重新加载").margin({ top: 16 }).onClick(() => this.controller.refresh());
        }
        .justifyContent(FlexAlign.Center)
        .padding(24)
        .width("100%")
        .height("100%");
      }
    }
    .width("100%")
    .height("100%");
  }

  // 供前端 window.hmBridge.notifyReady() 调用（可选：前端就绪后隐藏 loading）。
  notifyReady(): void {
    this.pageLoading = false;
    hilog.info(0x0000, "ShuyoNote", "web ready (jsProxy)");
  }
}
