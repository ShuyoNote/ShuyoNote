# 鸿蒙桌面版（阶段 0 / 1：ArkWeb 壳）

HarmonyOS NEXT（ArkTS/ArkUI）入口壳：用 ArkWeb 加载 ShuyoNote Web 版，复用编辑器/数据库/看板/关系图。

> 同步说明：**Web 版不实现同步**（web.ts 是 stub），需鸿蒙用 ArkTS 原生 `SyncClient`（见 `docs/鸿蒙桌面版计划.md`）。

## 怎么用
1. 用 **DevEco Studio** 新建一个 **HarmonyOS NEXT**（Stage 模型）工程（`empty ability` 模板）。
2. 把本目录 `entry/src/main/ets/entryability/EntryAbility.ets`、`pages/Index.ets` 拷到工程对应位置；`module.json5`/`app.json5` 参考合并（bundleName/description 按你工程改）。
3. 把 Web 版资源拷到 `entry/src/main/resources/rawfile/shuyo/`：
   - ShuyoNote 仓库跑 `pnpm run build:web` → 把 `dist-web/` **内容整体**拷进去（`base:"."` 相对路径已就绪）。
4. 运行到 **2in1/平板/手机** 模拟器或真机。

## Index.ets 壳能力（阶段1）
- 默认加载本地 `rawfile/shuyo/index.html`（离线）。
- `javaScriptAccess/domStorageAccess/databaseAccess/fileAccess` 全开——**支持 sql.js WASM 与 IndexedDB/localStorage**。
- 加载态（`onPageBegin/onPageEnd`）与**错误态**（`onErrorReceive`→"重新加载"）；`onPermissionRequest` 授权请求。
- 可切远程 URL 快速验证（改 `private src`）。

## 阶段 0（POC）要验证的点
- ArkWeb 能否跑 **sql.js WASM**（Web 版数据库）
- ArkWeb **IndexedDB / localStorage**（数据存储）
- **Lexical contenteditable** 长文本输入 / 焦点
- 桌面窗口（2in1 卡片/窗口）与缩放

> 若 POC 通过 → 数据层走 Web 版（sql.js）；若 WASM/IndexedDB 受限 → 阶段 3 提前换鸿蒙原生 `@ohos.data.relationalStore`。

## 远程 URL 验证（可选）
把 `Index.ets` 里 `private src` 改成 `'http://121.199.8.24/app/'`（需 `ohos.permission.INTERNET`，module.json5 已加），先验证远程加载再切本地 rawfile。

