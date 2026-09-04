# 鸿蒙桌面版（阶段 0 / 1：ArkWeb 壳）

HarmonyOS NEXT（ArkTS/ArkUI）入口壳：用 ArkWeb 加载 ShuyoNote Web 版，复用编辑器/数据库/看板/关系图。

## 怎么用
1. 用 **DevEco Studio** 新建一个 **HarmonyOS NEXT**（Stage 模型）工程（`empty ability` 模板）。
2. 把本目录的 `entry/src/main/ets/entryability/EntryAbility.ets`、`pages/Index.ets` 拷到工程对应位置；`module.json5`/`app.json5` 参考合并（bundleName/description 按你工程改）。
3. 把 Web 版资源拷到 `entry/src/main/resources/rawfile/shuyo/`：
   - 在 ShuyoNote 仓库跑 `pnpm run build:web` → `dist-web/` 内容整体拷进去（base/相对路径已就绪）。
4. 运行到 **2in1/平板/手机** 模拟器或真机。

## 阶段 0（POC）要验证的点
- ArkWeb 能否跑 **sql.js WASM**（Web 版数据库）
- ArkWeb **IndexedDB / localStorage**（数据存储）
- **Lexical contenteditable** 长文本输入 / 焦点
- 桌面窗口（2in1 卡片/窗口）与缩放

> 若 POC 通过 → 数据层走 Web 版（sql.js）；若 WASM/IndexedDB 受限 → 阶段 3 提前换鸿蒙原生 `@ohos.data.relationalStore`。

## 远程 URL 验证（可选）
把 `Index.ets` 里 `private src` 改成 `'http://121.199.8.24/app/'`（需 `ohos.permission.INTERNET`，module.json5 已加），先验证远程加载再切本地 rawfile。

## 同步（阶段 2）
Web 版**不实现同步**（web.ts 是 stub）。鸿蒙同步需 ArkTS 原生 `SyncClient`（对齐 `src-tauri/src/sync.rs` 协议：`/auth/*` `/spaces` `/push` `/pull` + `changes` 增量 + `token`），计划见 `docs/鸿蒙桌面版计划.md`。
