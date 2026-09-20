#!/usr/bin/env bash
# 验证「随包字体」（路线 D）在**本机 Linux** 上真的把非嵌入字体画出来了 —— 正/负向两次对拍。
#
# 为什么要有这个脚本：施工单 §2 的判据 1（非矩形墨迹 > 0）与判据 4 的负向形式
# （**删掉字体必须回到 0 像素**）都需要"同一份样本、同一个二进制、只差一个字体文件"这两次读数。
# 手敲容易漏掉第二次，而**只跑正向就下结论**正是本仓最防的那种"看着好了"。
#
# 用法（WSL2 里跑）：
#   bash scripts/verify-bundled-font.sh [字体文件]
# 默认字体 `/mnt/c/Windows/Fonts/simhei.ttf` —— ⚠️ **只用于本机验证**（微软/中易的字体，不随包）。
# 真正随包必须是 OFL 的 Noto Sans SC / Source Han Sans（施工单 §4），且要过体积预算（判据 5）。
#
# 前置：`SHUYONOTE_PDFIUM_DIR` 指向一份**带库**的 PDFium 目录（vendored 或自取），
#      即 `vendor/pdfium/linux-x64/lib/`。
set -u
FONT_SRC="${1:-/mnt/c/Windows/Fonts/simhei.ttf}"
WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$WT/src-tauri/vendor/pdfium/linux-x64/lib"
# 候选表里的第一个名字（`pdfium_native.rs: BUNDLED_FONT_CANDIDATES`）——文件名只是为了让候选命中，
# PDFium 只认字节，所以这里可以放任何单面 TTF/OTF。
FONT_DST="$LIB/NotoSansSC-Regular.ttf"

[ -f "$FONT_SRC" ] || { echo "字体不存在：$FONT_SRC（用参数指定一个）"; exit 2; }
[ -d "$LIB" ] || { echo "库目录不存在：$LIB（先 node scripts/fetch-pdfium.mjs）"; exit 2; }

cd "$WT/src-tauri" || exit 2
. "$HOME/.cargo/env"
export SHUYONOTE_PDFIUM_DIR="$LIB"

run() {  # $1 = 标签
  cargo test pdf_engine_compare -- --nocapture 2>&1 | tee "/tmp/bundled-font-$1.log" | grep -E '^[a-z0-9-]+\.pdf'
  echo "rc_$1=${PIPESTATUS[0]}"
}

echo "=== [1/3] 正向：库里放字体（$(basename "$FONT_SRC") → $(basename "$FONT_DST")）==="
# ⚠️ 先删再拷：从 Windows 字体目录拷过来的文件带**只读位**（`-r-xr-xr-x`），直接 cp 到它头上会
# "Permission denied" —— 而那时**上一轮的字体还在**，正/负向两次会拿到同一个读数、看起来"跑通了"，
# 实际这次验证是**假的**（本脚本第一版就撞上这条：报错被淹没在 cargo 输出里）。
rm -f "$FONT_DST" || true
cp "$FONT_SRC" "$FONT_DST" || { echo "❌ 放字体失败（$FONT_DST）"; exit 3; }
[ -s "$FONT_DST" ] || { echo "❌ 字体没放上（0 字节）"; exit 3; }
run pos

echo
echo "=== [2/3] 负向：删掉字体再跑（必须回到 27000，且其余行一字不变）==="
rm -f "$FONT_DST" || { echo "❌ 删字体失败 —— 负向那次不算数"; exit 3; }
[ ! -e "$FONT_DST" ] || { echo "❌ 字体还在，负向无效"; exit 3; }
run neg

echo
echo "=== [3/3] 结论（只该差 cjk.pdf 那一行）==="
grep -h 'cjk.pdf' /tmp/bundled-font-pos.log | sed 's/^/有字体: /'
grep -h 'cjk.pdf' /tmp/bundled-font-neg.log | sed 's/^/无字体: /'
echo "--- 其余样本两次的差异（应当为空）---"
diff <(grep -E '^[a-z0-9-]+\.pdf' /tmp/bundled-font-pos.log | grep -v '^cjk\.pdf') \
     <(grep -E '^[a-z0-9-]+\.pdf' /tmp/bundled-font-neg.log | grep -v '^cjk\.pdf') && echo "（空 = 只有 cjk 那一行变了）"

# ★ 自检：正向**必须**比负向多画出东西 —— 否则"验证"本身无效（字体没放上 / provider 没生效 ⇒
#   两次其实都是"无字体"那一档）。这条让脚本**自己会红**，而不是靠人眼看两行数字。
ink() { grep -h 'cjk.pdf' "$1" | grep -o 'PDFium [0-9]*' | grep -o '[0-9]*'; }
POS_INK="$(ink /tmp/bundled-font-pos.log)"
NEG_INK="$(ink /tmp/bundled-font-neg.log)"
echo "墨迹：有字体 $POS_INK / 无字体 $NEG_INK"
if [ -z "$POS_INK" ] || [ -z "$NEG_INK" ]; then echo "❌ 没解析到读数"; exit 4; fi
if [ "$POS_INK" -le "$NEG_INK" ]; then
  echo "❌ 正向没有比负向多画东西 ⇒ **这次验证无效**（别读成「路线 D 不生效」，先查字体有没有放上）"
  exit 4
fi
echo "✅ 正向多画了 $((POS_INK - NEG_INK)) 个像素 ⇒ 变化确实来自随包字体"
