#!/bin/sh
# ⚠️ **本脚本不是判据入口**：权威、跨平台的驱动是 `scripts/check-gm-conformance.mjs`
#    （2026-09-19 由 macOS 侧移植；它同时会跑「RustCrypto 单侧」的三个用例，并在 Tongsuo 缺席时
#    **自报跳过**而不是静默通过）。
#    本脚本保留为**来源凭证**：它是 AMD 2026-09-17 在 Linux 侧写的原始驱动（5 个用例、Tongsuo openssl
#    对比），里面的环境假设（`$HOME/tongsuo-build/install`、`stat -c`、`sha256sum`、`xxd -r -p`）
#    是 Linux 专用的 —— 所以没有直接搬进判据，而是把**用例口径**逐条移植进了 Node 驱动。
#    两者对同一份 Cargo 包跑同一组命令；如果哪天你想在 Linux 上手工复跑 AMD 的原始流程，用它。
# 国密对拍夹具 · 驱动脚本（Linux 侧）
#   Case 1/2: 标准向量（RustCrypto 与 Tongsuo 各自算，与 GM/T 期望值比）
#   Case 3  : RustCrypto 加密 → Tongsuo 解密
#   Case 4  : Tongsuo 加密 → RustCrypto 解密
#   Case 5  : HMAC-SM3（EtM 的 MAC）两边一致
#
# ⚠️ 注意：本脚本用 `sh`（dash）跑，**dash 的 printf 不展开 \xHH**（第一版就栽在这），
#    所以二进制向量一律用 `xxd -r -p` 从十六进制生成。
set -u
C="$HOME/gm-conformance"
TON="$HOME/tongsuo-build/install"
export LD_LIBRARY_PATH="$TON/lib64"
OSSL="$TON/bin/openssl"
BIN="$C/target/release/gm-conformance"
W="$C/work"; mkdir -p "$W"
KEY=0123456789abcdeffedcba9876543210
IV=000102030405060708090a0b0c0d0e0f
PASS=0; FAIL=0
ok() { echo "  [PASS] $1"; PASS=$((PASS+1)); }
ng() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "###### 环境 ######"
echo "  RustCrypto 夹具: $([ -x "$BIN" ] && echo 可执行 || echo 不可执行)"
echo "  Tongsuo: $("$OSSL" version 2>/dev/null | head -1)"
echo "  版本: $(cd "$C" && grep -E '^name = "(sm4|cbc|ecb|sm3|hmac|cipher)"' Cargo.lock -A1 | grep -E 'name|version' | paste - - | tr '\n' ' ')"

echo
echo "###### Case 1/2：标准向量 ######"
# 二进制向量：GM/T 0002 的 key = 明文 = 0123456789abcdeffedcba9876543210
printf '%s' "$KEY" | xxd -r -p > "$W/vec.bin"
echo "  向量文件 $(stat -c %s "$W/vec.bin") 字节（应为 16）"
RUST_ECB=$("$BIN" sm4-ecb "$KEY" "$KEY")
TON_ECB=$("$OSSL" enc -sm4-ecb -K "$KEY" -nopad -in "$W/vec.bin" 2>/dev/null | xxd -p | tr -d '\n')
EXP_ECB=681edf34d206965e86b3e94f536e4246
echo "  SM4-ECB  RustCrypto = $RUST_ECB"
echo "           Tongsuo    = $TON_ECB"
echo "           GM/T 0002  = $EXP_ECB"
[ "$RUST_ECB" = "$EXP_ECB" ] && ok "RustCrypto SM4-ECB 命中标准向量" || ng "RustCrypto SM4-ECB 偏离标准向量"
[ "$TON_ECB" = "$EXP_ECB" ] && ok "Tongsuo SM4-ECB 命中标准向量" || ng "Tongsuo SM4-ECB 偏离标准向量"
printf 'abc' > "$W/abc.bin"
RUST_SM3=$("$BIN" sm3 616263)
TON_SM3=$("$OSSL" dgst -sm3 "$W/abc.bin" 2>/dev/null | awk '{print $NF}')
EXP_SM3=66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0
echo "  SM3(abc) RustCrypto = $RUST_SM3"
echo "           Tongsuo    = $TON_SM3"
[ "$RUST_SM3" = "$EXP_SM3" ] && ok "RustCrypto SM3 命中标准向量" || ng "RustCrypto SM3 偏离标准向量"
[ "$TON_SM3" = "$EXP_SM3" ] && ok "Tongsuo SM3 命中标准向量" || ng "Tongsuo SM3 偏离标准向量"

echo
echo "###### Case 3：RustCrypto 加密 → Tongsuo 解密 ######"
printf '%s' 'ShuyoNote-GM-conformance-case3-37-bytes' | head -c 37 > "$W/pt.bin"
echo "  明文 37 字节（非 16 倍数，专测 PKCS#7）  sha256=$(sha256sum "$W/pt.bin" | cut -c1-32)…"
"$BIN" enc "$KEY" "$IV" "$W/pt.bin" > "$W/ct_rust.hex"
xxd -r -p < "$W/ct_rust.hex" > "$W/ct_rust.bin"
echo "  RustCrypto 密文 $(stat -c %s "$W/ct_rust.bin") 字节（37 → PKCS#7 补到 48）"
if "$OSSL" enc -d -sm4-cbc -K "$KEY" -iv "$IV" -in "$W/ct_rust.bin" -out "$W/pt_back.bin" 2>/dev/null; then
  cmp -s "$W/pt.bin" "$W/pt_back.bin" && ok "Tongsuo 解开 RustCrypto 的密文，明文逐字节一致" || ng "解开但明文不一致"
else
  ng "Tongsuo 解不开 RustCrypto 的密文"
fi

echo
echo "###### Case 4：Tongsuo 加密 → RustCrypto 解密 ######"
"$OSSL" enc -sm4-cbc -K "$KEY" -iv "$IV" -in "$W/pt.bin" -out "$W/ct_ton.bin" 2>/dev/null
xxd -p "$W/ct_ton.bin" | tr -d '\n' > "$W/ct_ton.hex"
"$BIN" dec "$KEY" "$IV" "$W/ct_ton.hex" > "$W/pt2.bin" 2>"$W/dec.err"
if [ -s "$W/pt2.bin" ]; then
  cmp -s "$W/pt.bin" "$W/pt2.bin" && ok "RustCrypto 解开 Tongsuo 的密文，明文逐字节一致" || ng "解开但明文不一致"
else
  ng "RustCrypto 解不开 Tongsuo 的密文：$(head -2 "$W/dec.err" | tr '\n' ' ')"
fi
echo "  两侧密文逐字节相同: $(cmp -s "$W/ct_rust.bin" "$W/ct_ton.bin" && echo 是 || echo 否)"
[ "$(cmp -s "$W/ct_rust.bin" "$W/ct_ton.bin" && echo y || echo n)" = "y" ] && ok "两份实现产出的密文完全相同（CBC+PKCS#7 下应当如此）" || ng "两份实现产出的密文不同"

echo
echo "###### Case 5：HMAC-SM3 ######"
cat "$W/ct_ton.bin" > "$W/mac_input.bin"     # 夹具先证算法一致；EtM 的拼接（版本头‖IV‖密文）在 P2 由调用方组
RUST_MAC=$("$BIN" hmac "$KEY" "$W/mac_input.bin")
TON_MAC=$("$OSSL" dgst -sm3 -mac HMAC -macopt "hexkey:$KEY" "$W/mac_input.bin" 2>/dev/null | awk '{print $NF}')
echo "  HMAC-SM3  RustCrypto = $RUST_MAC"
echo "            Tongsuo    = $TON_MAC"
[ -n "$RUST_MAC" ] && [ "$RUST_MAC" = "$TON_MAC" ] && ok "HMAC-SM3 两侧一致（32 字节 tag）" || ng "HMAC-SM3 两侧不一致"

echo
echo "###### 结论 ######"
echo "  PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "国密对拍夹具（Linux 侧）: ALL PASS" || echo "国密对拍夹具（Linux 侧）: 有失败（见上）"
