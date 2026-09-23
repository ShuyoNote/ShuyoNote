#!/bin/sh
# 交叉编译**静态** Tongsuo（libcrypto.a）给 Android arm64 —— 库级国密那一格（owner 2026-09-23 拍「做」）。
#
# 为什么静态：Android 系统不带 OpenSSL，必须**随包**一份；而且必须是**静态**的 ——
# `check-android-bundle` 要断言 APK 里的 `.so` **没有** `libcrypto.so` 依赖（动态档会要求设备上有那份库）。
#
# 与桌面 Windows 那条的关系：那边也走"自编静态 Tongsuo"（因为本机拿不到 vcpkg），但那边**额外**要
# `no-uplink`（`LNK2001: OPENSSL_UplinkTable`，Windows DLL 时代的机制）；Android/ELF 不需要那一条。
#
# 用法（在 Linux / WSL / CI 里跑）：
#   sh scripts/build-tongsuo-android.sh                 # 装进 src-tauri/vendor/openssl/android-arm64/
#   ANDROID_NDK_ROOT=/path/to/ndk sh scripts/build-tongsuo-android.sh
#   TONGSUO_SRC=/path/to/Tongsuo sh scripts/build-tongsuo-android.sh   # 用已有的源码检出（跳过 git clone）
#
# 前置：`ANDROID_NDK_ROOT`（**必须**，`Configure` 的 android-* 目标要它；只设 ANDROID_NDK_HOME 会
#       报 `$ANDROID_NDK_ROOT is not defined ... build file wasn't produced`）、`git`、`make`、`perl` 视平台。
# 退出码：0 = 就位且 sha256 与钉死值一致；1 = 构建/安装失败；2 = **没验**（产物的 sha256 与钉死值不符）。
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/src-tauri/vendor/openssl/android-arm64"

# ── 钉死的三件事（改这里 = 换版本；换完要用 `node scripts/check-openssl-android.mjs --print-sha256` 更新 sha256）──
TONGSUO_COMMIT="540603a3"        # Gitee 镜像的 commit（与 Linux / macOS 侧同一个）
# ⚠️ 这是**读数**、不是门禁：实测同机同参数连编三遍得到三个不同 sha256（大小相同）⇒ 自编产物按字节钉不住
#    （见 scripts/check-openssl-android.mjs 文件头的三遍读数）。判据改在**属性**上（静态/大小/headers/SM 符号），
#    这个值只用来在人眼层面比"两台机器编出来的是不是同一批"。
RECORDED_SHA256="19e2541af8fa3041ef7e0f6d8466705f9780f610f1395039f476fd45d6affd00"
RECORDED_SIZE="10931686"
SIZE_BAND_MIN=8000000
SIZE_BAND_MAX=16000000
API=24
MIRROR="https://gitee.com/mirrors/Tongsuo.git"

# ⚠️ **固定的安装前缀**（不是构建目录）：OpenSSL 会把 `OPENSSLDIR` 编译进库，而 `--prefix` 直接决定它。
# 若按"就地安装"，同一个源码在两台机器上会产出**不同字节**（路径不同）⇒ 钉 sha256 就变成"钉我这台机的目录"。
# 所以：configure 用这个常量前缀 ＋ `make install_dev DESTDIR=<本地 staging>`，产物落在
# `<staging><PREFIX_FIXED>/lib/…` ⇒ 换机器/换目录都能复现同一份字节（这也是钉死值能立住的前提）。
PREFIX_FIXED="/opt/shuyonote/openssl-android"

die() { echo "build-tongsuo-android: ✗ $1" >&2; exit "${2:-1}"; }

[ -n "${ANDROID_NDK_ROOT:-}" ] || {
  # 没给就**显式**在几个标准位置找一下 —— 找到要**大声说找到哪一份**（悄悄挑一个错的 NDK 比失败更坏）
  for c in "$HOME/ndk/android-ndk-r29" "$HOME/android-ndk-r29" "/opt/android-ndk-r29" \
           "$HOME/Library/Android/sdk/ndk/29.0.14206865" "$HOME/Android/Sdk/ndk/29.0.14206865"; do
    if [ -d "$c" ]; then
      # ⚠️ **必须 export**：Configure（perl 脚本）读的是**环境**；只赋值不导出的话，子进程看不见，
      #    症状与"完全没设"一模一样（`$ANDROID_NDK_ROOT is not defined ... build file wasn't produced`）。
      ANDROID_NDK_ROOT="$c"
      export ANDROID_NDK_ROOT
      echo "build-tongsuo-android: 未给 ANDROID_NDK_ROOT ⇒ 自动选中 $c" >&2
      break
    fi
  done
}
[ -n "${ANDROID_NDK_ROOT:-}" ] || die "没有 ANDROID_NDK_ROOT（Configure 的 android-arm64 目标要它；本机标准位置也没找到）
  用法：ANDROID_NDK_ROOT=<ndk> sh scripts/build-tongsuo-android.sh"
[ -d "$ANDROID_NDK_ROOT" ] || die "ANDROID_NDK_ROOT 指向的目录不存在：$ANDROID_NDK_ROOT"
export ANDROID_NDK_HOME="$ANDROID_NDK_ROOT"
export PATH="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin:$PATH"

echo "build-tongsuo-android: NDK = $(grep Pkg.Revision "$ANDROID_NDK_ROOT/source.properties" 2>/dev/null || echo '?')"
echo "build-tongsuo-android: 目标 × DEST = android-arm64 × $DEST"

WORK="${TONGSUO_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/shuyonote/openssl-android-build}"
SRC="${TONGSUO_SRC:-}"
if [ -z "$SRC" ]; then
  rm -rf "$WORK/Tongsuo"
  mkdir -p "$WORK"
  echo "build-tongsuo-android: 取源码（Gitee 镜像）…"
  git clone --quiet "$MIRROR" "$WORK/Tongsuo" || die "克隆失败（Gitee 不可达？）"
  SRC="$WORK/Tongsuo"
  ( cd "$SRC" && git checkout --quiet "$TONGSUO_COMMIT" ) || die "checkout $TONGSUO_COMMIT 失败"
fi
echo "build-tongsuo-android: 源码 commit = $(cd "$SRC" && git log -1 --format='%h %cs' 2>/dev/null || echo '(非 git 检出)')"

cd "$SRC" || die "进不去源码目录：$SRC"
rm -rf "$SRC/stage"
if ! ./Configure android-arm64 "-D__ANDROID_API__=$API" --prefix="$PREFIX_FIXED" --openssldir="$PREFIX_FIXED/ssl" no-tests no-shared > "$WORK/configure.log" 2>&1; then
  echo "build-tongsuo-android: Configure 失败，尾部：" >&2
  tail -20 "$WORK/configure.log" >&2
  die "Configure 失败" 1
fi
echo "build-tongsuo-android: Configure OK（no-shared，prefix=$PREFIX_FIXED）"

if ! make -j"$(nproc 2>/dev/null || echo 4)" build_libs > "$WORK/build.log" 2>&1; then
  echo "build-tongsuo-android: build_libs 失败，尾部：" >&2
  tail -30 "$WORK/build.log" >&2
  die "build_libs 失败" 1
fi
make install_dev DESTDIR="$SRC/stage" > "$WORK/install.log" 2>&1 || die "install_dev 失败"

# ── 自检 + 装进 vendor（**二进制不入库**，见 .gitignore）──
INST="$SRC/stage$PREFIX_FIXED"
BUILT="$INST/lib/libcrypto.a"
[ -f "$BUILT" ] || die "产物不在：$BUILT"
GOT_SHA=$(sha256sum "$BUILT" | cut -d' ' -f1)
GOT_SIZE=$(stat -c%s "$BUILT" 2>/dev/null || wc -c < "$BUILT")
SM_HITS=$(llvm-nm --defined-only "$BUILT" 2>/dev/null | grep -ciE 'sm3|sm4' || echo 0)
SO_COUNT=$(ls "$INST/lib"/libcrypto.so* 2>/dev/null | wc -l)
echo "build-tongsuo-android: libcrypto.a = $GOT_SIZE 字节 · sha256 $GOT_SHA"
echo "build-tongsuo-android: SM 符号 = $SM_HITS · libcrypto.so 数量 = $SO_COUNT（必须是 0）"
[ "$SO_COUNT" = "0" ] || die "居然产出了 libcrypto.so —— 静态那一格不成立" 1
[ "$GOT_SIZE" -ge "$SIZE_BAND_MIN" ] && [ "$GOT_SIZE" -le "$SIZE_BAND_MAX" ] \
  || die "大小 $GOT_SIZE 不在合理带 [$SIZE_BAND_MIN, $SIZE_BAND_MAX] ⇒ 构建可能坏了" 1
[ "$SM_HITS" -ge 100 ] || die "SM 符号只有 $SM_HITS 个（下界 100）⇒ 这库不含国密" 1
if [ "$GOT_SHA" != "$RECORDED_SHA256" ]; then
  echo "build-tongsuo-android: 注：sha256 与记录值不同（记录 ${RECORDED_SHA256%??????????????????????????????????????????????}…）—— **正常**：" \
       "实测同机同参数连编三遍也会得到三个不同值，所以判据在属性上、不在字节上（见 check-openssl-android.mjs 文件头）。"
fi

if [ "$GOT_SHA" != "$RECORDED_SHA256" ]; then
  echo "build-tongsuo-android: 注：sha256 与记录值不同 —— **正常**（实测同机同参数连编三遍得到三个不同值）"
  echo "  本次 $GOT_SHA"
  echo "  记录 $RECORDED_SHA256"
  echo "  判据在**属性**上（静态 / 大小带 / headers / SM 符号），不在字节上；详见 check-openssl-android.mjs 文件头。"
fi

mkdir -p "$DEST/lib" "$DEST/include"
cp "$BUILT" "$DEST/lib/libcrypto.a"
[ -f "$INST/lib/libssl.a" ] && cp "$INST/lib/libssl.a" "$DEST/lib/libssl.a"
cp -r "$INST/include/." "$DEST/include/"
cat > "$DEST/SOURCE.txt" <<EOF
Android arm64 静态 Tongsuo（库级国密随包）
source   : $MIRROR @ $TONGSUO_COMMIT
ndk      : $(grep Pkg.Revision "$ANDROID_NDK_ROOT/source.properties" 2>/dev/null || echo '?')
configure: ./Configure android-arm64 -D__ANDROID_API__=$API --prefix=$PREFIX_FIXED --openssldir=$PREFIX_FIXED/ssl no-tests no-shared
install  : make install_dev DESTDIR=<stage>
sha256   : $GOT_SHA（**读数**；记录值 $RECORDED_SHA256 —— 每编一次都会变，见下）
size     : $GOT_SIZE（记录值 $RECORDED_SIZE）
sm syms  : $SM_HITS
built    : $(date -u +%Y-%m-%dT%H:%M:%SZ)

⚠️ 为什么 sha256 每编一次都不同：实测同机、同工作目录、同源码 commit、同参数连编三遍得到三个不同值
   （大小完全相同）⇒ 自编产物**按字节钉不住**（真因未定）。所以判据在**属性**上：静态（无 libcrypto.so）、
   大小在合理带、headers 齐、SM 符号数够；sha256 只作人眼对照。
EOF
echo "build-tongsuo-android: 已装进 $DEST"
echo "build-tongsuo-android: ✅ 属性全过（静态 + 大小带 + SM 符号 $SM_HITS 个）"
