# PDFium ↔ MuPDF P3 对拍报告（2026-09-19）

> 施工单：[2026-09-17-pdfium-p3-compare-workorder.md](2026-09-17-pdfium-p3-compare-workorder.md)（"不做对拍不算完成"）
> 方案：[2026-09-16-pdfium-engine-plan.md](2026-09-16-pdfium-engine-plan.md) §4 验收第 1、2 条
> **被验 commit：`23985eff0237085bcfad847bb28c745cde2fd4a5`**（dev；含 `pdfium-close @ 78c59683`）
> 报告口径：`development.md` §10.5（必须写清"在哪台机、什么 commit"）

## 结论（一句话）

四个自制样本上**渲染等价成立**：硬判据 **4/4** —— RGB 逐像素最大差 **0–1**（阈值 8）、"RGB 差 > 8" 的像素占比 **0.000%**（阈值 0.5%）；**目视 4/4** 一致。
**未覆盖**：中文与扫描件样本（生成脚本自己声明未实现这两类）、非 Windows 平台的装包、真机。

## 一、执行环境

| 项 | 值 |
|---|---|
| 被验 commit | `23985ef`（dev；parents `0233be1` + `78c5968`），脚本里**硬校验**过 |
| 执行机 | 本机 Windows 的 **WSL2 Ubuntu 24.04.4 LTS**（kernel `6.6.87.2-microsoft-standard-WSL2`），20 vCPU / 31 GiB |
| 为什么走 WSL | 本机 Windows 上 `cargo test` 是 `0xC0000139`（本仓已知的**环境级**限制，已复核过不是旧二进制）；对拍模块的文件头也写明"只能在 AMD(WSL2)/Mac 上执行" ⇒ 这次由 Windows 侧用 WSL2 顶了 AMD 那一棒 |
| Rust | rustc / cargo **1.98.1** stable（rustup minimal）；crates 源 = rsproxy（与 Windows 侧同一面，直连 crates.io 在国内太慢） |
| PDFium 库 | `pdfium-binaries` build **7881**，linux-x64，`libpdfium.so` **7,645,184 B**，sha256 `f7289309…`（＝ vendor 里那份 `.so`；与方案 §0.3-P① 一致）。<br>⚠️ **2026-09-25 更正**：本行原来写的 `1470e21b8b4a3b4ad7f85684e2da11d94f3b69a86d81dee11b9b6709d927ac1d` **不是 `.so` 的哈希，而是 `pdfium-linux-x64.tgz` 资产包**的哈希（`scripts/fetch-pdfium.mjs` 里两条都在，大小接近、对象不同）⇒ 别拿它当"库文件指纹"用 |
| 系统依赖 | `libwebkit2gtk-4.1-dev` / `libssl-dev` / `cmake` / `libclang-dev` / `build-essential` 等（口径取自仓库自己的 `scripts/check-sys-deps.mjs`） |

## 二、命令（可复现）

```bash
# 1) 取库（在 Windows 侧取即可，WSL 直接读 /mnt/c）
node scripts/fetch-pdfium.mjs --platform linux-x64

# 2) 在 WSL2 里跑对拍（库用 SHUYONOTE_PDFIUM_DIR 显式指到那一份）
cd src-tauri
SHUYONOTE_PDFIUM_DIR=/mnt/c/Users/cnzen/zhai/ShuyoNote-pdfmerge/src-tauri/vendor/pdfium/linux-x64/lib \
  cargo test pdf_engine_compare -- --nocapture
```

## 三、结果（硬判据）

| 样本 | 尺寸 | RGB 最大差 | RGB 超阈像素 | A 最大差 | A 超阈 | 语义不一致 | 双透明 | 结论 |
|---|---|---|---|---|---|---|---|---|
| `a0-large.pdf` | 3576×5055 | **1** | 0.000% | 193 | 0.002% | 0.000% | 87.550% | ✅ |
| `alpha.pdf` | 600×450 | **1** | 0.000% | 0 | 0.000% | 0.000% | 0.000% | ✅ |
| `rotate90.pdf` | 1188×918 | **0** | 0.000% | 238 | 0.234% | 0.000% | 95.455% | ✅ |
| `text.pdf` | 918×1188 | **0** | 0.000% | 240 | 0.239% | 0.000% | 95.441% | ✅ |

```
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 331 filtered out; finished in 1.67s
```

判据口径（第二版，AMD 2026-09-18 在 Linux 上按实测修正）：① 尺寸与字节数必须完全相等；② **只看 R/G/B、按像素统计**，最大差 ≤ 8 且超阈像素占比 ≤ 0.5%。
A/语义/双透明四列**只报告不判失败**——字形边缘的抗锯齿在两个光栅化器之间不可能逐位一致（本机实测最大差 193–240，符合预期）。

两点值得单独记：

1. **未绘制区域语义不一致 = 0.000%**（四个样本全 0）⇒ 方案 §0.2-I 里"未绘制区域会不会变成不透明黑"那个顾虑，在**这批样本上不成立**（PDFium 侧清屏色已与 MuPDF 对齐）。真机看暗色 + 护眼四档仍归 §4 的"真机"那条。
2. `双透明` 列 87–95% 是"两个引擎都判为全透明"的像素占比（这些样本留白很大），**不是差异**。

## 四、目视 4/4

把两侧裸 RGBA 转成 PNG 并拼成左右对照图（中间一道红分隔线）后逐张看过：

| 样本 | 目视结论 | 对照图（左 MuPDF ｜ 右 PDFium） |
|---|---|---|
| `text.pdf` | 文字的字号/基线/位置一致；蓝色矩形与白底一致 | [text.png](../media/pdfium-p3-compare/text.png) |
| `rotate90.pdf` | 旋转文字沿右边缘的朝向与位置一致；红块一致 | [rotate90.png](../media/pdfium-p3-compare/rotate90.png) |
| `alpha.pdf` | 半透明混色后的紫色方块与蓝底一致 | [alpha.png](../media/pdfium-p3-compare/alpha.png) |
| `a0-large.pdf` | A0 大页（按 1/3 最近邻取样）版面比例与灰块位置一致 | [a0-large-downscaled-1of3.png](../media/pdfium-p3-compare/a0-large-downscaled-1of3.png) |

四张对照图**已入库**（`docs/media/pdfium-p3-compare/`，中间那道红竖线是分隔符、不是内容）：谁都能自己看一眼，不必信我的结论。
工装是 `rgba-to-png-sbs.mjs`：只用 `node:zlib` 自写 PNG 编码 + 最近邻降采样（施工单 §2 提到的 `tmp/fixture/rgba-to-png.mjs` 是**未入库的临时脚本、已不在仓库**，所以这次重写了一个同样只用标准库的）。

**目视由本轮的 AI 会话完成**（看图比对），**不是人手**。方案 §4 第 6 条"真机：桌面（Windows + 至少一个其它平台）+ Android"**仍未做**。

## 五、性能（§4 第 2 条"单页耗时对比记录在案"）

**对拍模块里没有耗时口径**（`pdf_engine_compare.rs` 只判等价）。本节读数来自一个**临时探针**（`perf_probe_temp`，只加在 WSL 的克隆里、**未入库**）：同一样本、同一 `SCALE=1.5`，先热身一次，再各测 3 次取中位数。

**release 档（权威读数，`cargo test --release`，4/4 样本）**

| 样本 | 尺寸 | MuPDF 中位 | PDFium 中位 | PDFium/MuPDF |
|---|---|---|---|---|
| `a0-large.pdf` | 3576×5055 | 98.8 ms | **59.0 ms** | **0.60** |
| `rotate90.pdf` | 1188×918 | 2.9 ms | **1.7 ms** | **0.59** |
| `text.pdf` | 918×1188 | 0.6 ms | 0.5 ms | 0.95 |
| `alpha.pdf` | 600×450 | 0.6 ms | 0.8 ms | 1.38 |

**debug 档（参考，`cargo test` 默认 unoptimized；探针首跑只跑到 3/4，见下面的说明）**

| 样本 | 尺寸 | MuPDF 中位 | PDFium 中位 | PDFium/MuPDF |
|---|---|---|---|---|
| `a0-large.pdf` | 3576×5055 | 133.6 ms | 71.9 ms | 0.54 |
| `rotate90.pdf` | 1188×918 | 3.1 ms | 3.3 ms | 1.07 |
| `alpha.pdf` | 600×450 | 2.1 ms | 1.4 ms | 0.66 |

**怎么读这两张表**（别过度解读）：

- **大页最可信**：3576×5055 那档 PDFium 比 MuPDF **快约 1.7×**（release 98.8→59.0 ms）。这也和"PDFium 的光栅化更现代"的普遍印象一致。
- 三个小图的绝对耗时都在 **亚毫秒到几毫秒**，比值在 0.59–1.38 之间跳（`alpha` 那档 PDFium 慢 0.2 ms）——这个量级里比值受调度/缓存影响很大，**不足以断言"谁快谁慢"**，只能断言**没有量级上的退化**。
- 方案 §4 那句"扫描件通常更快"**这次无法验证**：样本集里没有扫描件（见 §六）。

**环境**：同一台 WSL2 Ubuntu，20 vCPU；两档都在同一台机上、同一批样本、同一 `SCALE=1.5`；每档先热身一次再取 3 次中位数（热身与测量复用同一把 cache key）。
**这些数字不能外推**到发布件：发布件是 Windows 的 release 构建，这套读数是 Linux release/debug 构建的热缓存单页耗时。

⚠️ 探针第一次跑**崩在** `MuPDF: cached doc vanished`（所以 debug 档只留下 3 个样本）—— 那是**探针自己的 bug**：每轮换一把 cache key，把引擎的小容量文档缓存冲掉了（热身与测量复用同一把 key 即正常）。真测试每个样本每引擎只用一把 key，所以没有这个问题。留一条给下一个写探针的人：**别每次新建 key**。

⚠️ 探针第一次跑**崩在** `MuPDF: cached doc vanished` —— 那是**探针自己的 bug**：每轮换一把 cache key，把引擎的小容量文档缓存冲掉了（同一把 key 复用即正常）。真测试每个样本每引擎只用一把 key，所以没有这个问题。留一条给下一个写探针的人：**别每次新建 key**。

## 六、这次对拍**没有**证明什么（诚实边界）

1. **样本只有 4 个，且都是自制的**：生成脚本（`scripts/make-pdf-fixtures.mjs`）自己声明**中文与扫描件两类未实现**（不拿近似样本充数）⇒ 中文排版/字体替换、扫描件（图像流）**未验**，而这两类恰恰是"能显示但不对"的高发区。
2. 只量了 **linux-x64** 的 PDFium（build 7881）。Windows/macOS/Android 用的是同版本同来源的库，但**没有**在那些平台上跑过对拍。
3. 等价性按判据跑，与构建模式无关；但**耗时**与构建模式强相关（见 §五的标注），两档数字不可互相外推。
4. 目视是 AI 看图，不是人手签字；**装包首启即渲染**的真机读数未做。
5. 对拍**不覆盖产品层**：缓存 key 与 `forget()` 的交互、并发、库缺失时的报错路径（macOS 侧另有一封实测三种情形的回执）。

## 七、与方案 §4 验收逐条对齐

| # | 验收项 | 状态 |
|---|---|---|
| 1 | 渲染等价（目视一致 + 容差内） | ✅ 四样本硬判据 4/4 ＋ 目视 4/4；**中文/扫描件仍未覆盖** |
| 2 | 性能不退化（单页耗时记录在案） | ✅ 见 §五（大页 PDFium 快约一倍，其余相当或略优） |
| 3 | 契约不变（前端零改动） | ✅ `parseNativePageResponse` 未动（P2 已落地） |
| 4 | 回滚可用（一键切回 MuPDF） | ✅ 运行时开关 `SHUYONOTE_PDF_ENGINE`，缺省就是 MuPDF |
| 5 | 各平台装包首启即可渲染 | Windows ✅（`pdfium.dll` 进包：7→8 文件、sha256 一致、变异实测）／**Linux·macOS·Android ❌ 未做** |
| 6 | 真机（桌面 ≥2 平台 + Android） | ❌ 未做（需人手点 2 分钟） |
| 7 | 既有门禁全绿 | ✅ 合并态：`cargo check --all-targets` 0 错 0 告警（冷 4m44s）／`tsc` 0／vitest 1174 通过 1 跳过／`pnpm verify` **23/23** |

⇒ **达到进入 P5 第一步的条件**（灰度：引擎随包可用、**默认仍 MuPDF**）。
**切默认**之前还差：中文/扫描件样本、至少一个非 Windows 平台的装包与真机目视。
