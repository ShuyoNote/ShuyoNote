#!/usr/bin/env node
// **生成** `patches/0001-sqlcipher-sm3-provider.patch`（不是应用它 —— 应用在 `scripts/sm-library-build.mjs`）。
//
// 为什么要有生成器，而不是手写一份 diff：
//   补丁的上下文行必须与**将要编译的那份** SQLCipher 源码逐字一致；SQLCipher 一升级，行号与上下文都会动。
//   这里把"要改什么"写成**一段一段的锚点替换**，每段都断言"锚点在原始文件里出现**恰好一次**"：
//   对不上就**当场失败**（`assert-exactly-once`），不会安静地改错地方、也不会生成一份"看着像补丁"的废纸。
//   ⇒ 升级 SQLCipher 时的正确动作：跑本脚本 → 看它报哪一段锚点没了 → 对着新源码改那一段 → 重新生成。
//
// 用法（在**干净的**源码上跑；脚本自己会先验"原始文件里 SM3 命中为 0"）：
//   node patches/tools/make-sm3-provider-patch.mjs <原始的 sqlite3.c> [输出 .patch]
//   node patches/tools/make-sm3-provider-patch.mjs --from-lock     # 自己定位（Cargo.lock 里锁的那份）
//
// ⚠️ 生成的 diff 用 `--label a/sqlite3.c --label b/sqlite3.c` ⇒ 消费者在 `sqlcipher/` 目录里
//    `git apply -p1` 即可（或 `patch -p1`）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSqlcipherSource } from "../../scripts/lib/sm-library-source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

const argv = process.argv.slice(2);
let srcPath = argv[0];
let outPath = argv[1] || join(root, "patches", "0001-sqlcipher-sm3-provider.patch");

if (srcPath === "--from-lock" || !srcPath) {
  const pick = resolveSqlcipherSource({ lockPath: join(root, "src-tauri", "Cargo.lock") });
  srcPath = join(pick.dir, "sqlite3.c");
  if (!existsSync(srcPath)) {
    console.error(`make-sm3-provider-patch: ❌ 锁定的源码里没有 sqlite3.c：${srcPath}`);
    process.exit(1);
  }
  console.log(`make-sm3-provider-patch: 源码由 Cargo.lock 定位 = ${srcPath}（libsqlite3-sys ${pick.version}, via=${pick.via}）`);
}

const pristine = readFileSync(srcPath, "utf8");

// ---- 先验原始：这份源码里**不该**已经有任何 SM3 / 本补丁的痕迹 ----
if (/SM3|sm3|SM4_CBC|EVP_sm3/.test(pristine)) {
  console.error(
    "make-sm3-provider-patch: ❌ 输入文件里已经有 SM3 痕迹 —— 这**不是干净的源码**（可能已经打过补丁）。\n" +
      "  生成补丁必须在原始文件上做，否则 diff 里会混进上一次的改动。",
  );
  process.exit(1);
}
if (pristine.includes("SHUYONOTE-GM")) {
  console.error("make-sm3-provider-patch: ❌ 输入文件里已经有 SHUYONOTE-GM 标记 ⇒ 不是干净的源码。");
  process.exit(1);
}

// ---- 改动表：每条都是"锚点 → 锚点＋新增"，锚点必须**恰好出现一次** ----
// 编号与 `patches/README.md` 的「四处必改」对应；SM4 页加密（方案 §3.1 第 4 项）**不在本补丁**，
// 见 README 的「P3 还没做的部分」—— 那是 `cipher` 回调，与这里同一文件同一结构体，但需要另一层设计。
const EDITS = [
  {
    id: "6 OPENSSL_CIPHER：无条件 SM4 页加密（P3 快路）",
    anchor: `#define OPENSSL_CIPHER EVP_aes_256_cbc()
`,
    add: `/* SHUYONOTE-GM: **无条件**换 SM4 页加密（owner 2026-09-20「无兼容快路」拍板：不做兼容、页加密只有 SM4）。
** 只改这一处定义** —— 五处使用点（cipher / get_cipher / get_key_sz / get_iv_sz / get_block_sz）都只是引用它，
** 等价且补丁面最小（少 4 段漂移面）；按快路**不加任何 #ifdef、不加构建开关**。
** ⚠️ 已知代价（写给下一个人）：这份补丁打在 cargo registry 那份**全机共享**源码上 ⇒ 打过之后，
** 同一台机器上**任何**后续构建（默认构建、Apple 的 CommonCrypto 构建、别人的 cargo test）都变成 SM4 页。
** 跑默认门禁前先 node scripts/sm-library-build.mjs --revert（2026-09-20：这条从"行为中性"变成"有后果"，
** 因为去掉了 #ifdef）。 */
#define OPENSSL_CIPHER EVP_sm4_cbc()
`,
  },
  {
    id: "1a 枚举/标签：HMAC_SM3",
    anchor: `#define SQLCIPHER_HMAC_SHA512 2
#define SQLCIPHER_HMAC_SHA512_LABEL "HMAC_SHA512"
`,
    add: `#define SQLCIPHER_HMAC_SHA512 2
#define SQLCIPHER_HMAC_SHA512_LABEL "HMAC_SHA512"
/* SHUYONOTE-GM BEGIN (patches/0001-sqlcipher-sm3-provider.patch)
** 国密取值。注意 hmac 与 kdf 两张表**各自独立编号**（各自 0/1/2），本补丁新增的 SM3 在两张表里都取 3；
** 这不是巧合可用，而是 provider 的 \`get_hmac_sz(ctx, algorithm)\` 用**同一个 int 判"能不能算"**，
** 下面两处 setter 里的能力门正是依赖这一点（见 2a/2b）。 */
#define SQLCIPHER_HMAC_SM3 3
#define SQLCIPHER_HMAC_SM3_LABEL "HMAC_SM3"
`,
  },
  {
    id: "1b 枚举/标签：PBKDF2_HMAC_SM3",
    anchor: `#define SQLCIPHER_PBKDF2_HMAC_SHA512 2
#define SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL "PBKDF2_HMAC_SHA512"
`,
    add: `#define SQLCIPHER_PBKDF2_HMAC_SHA512 2
#define SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL "PBKDF2_HMAC_SHA512"
#define SQLCIPHER_PBKDF2_HMAC_SM3 3
#define SQLCIPHER_PBKDF2_HMAC_SM3_LABEL "PBKDF2_HMAC_SM3"
`,
  },
  {
    id: "2a 能力门：set_hmac_algorithm",
    anchor: `static int sqlcipher_codec_ctx_set_hmac_algorithm(codec_ctx *ctx, int algorithm) {
  if(SQLCIPHER_FLAG_GET(ctx->flags, CIPHER_FLAG_KEY_USED)) return SQLITE_OK;

  ctx->hmac_algorithm = algorithm;
  return sqlcipher_codec_ctx_reserve_setup(ctx);
}
`,
    add: `static int sqlcipher_codec_ctx_set_hmac_algorithm(codec_ctx *ctx, int algorithm) {
  if(SQLCIPHER_FLAG_GET(ctx->flags, CIPHER_FLAG_KEY_USED)) return SQLITE_OK;

  /* SHUYONOTE-GM: **能力门** —— 当前 provider 算不了这个算法就**不落值**。
  ** 不加这道门，只加标签的话，"设了 HMAC_SM3" 在 CommonCrypto/libtomcrypt 后端上也会**被接受**：
  ** 回显是 SM3、真算的是别的（或 hmac_sz=0 直接把保留区算错）—— 正是我们要防的**静默降级**。
  ** 三个 provider 的 get_hmac_sz() 对既有三种算法一律 > 0 ⇒ 对老路径**零行为变化**。 */
  if(ctx->provider != NULL && ctx->provider->get_hmac_sz != NULL &&
     ctx->provider->get_hmac_sz(ctx->provider_ctx, algorithm) <= 0) {
    sqlcipher_log(SQLCIPHER_LOG_ERROR, SQLCIPHER_LOG_PROVIDER,
                  "%s: crypto provider does not support hmac algorithm %d", __func__, algorithm);
    return SQLITE_ERROR;
  }

  ctx->hmac_algorithm = algorithm;
  return sqlcipher_codec_ctx_reserve_setup(ctx);
}
`,
  },
  {
    id: "2b 能力门：set_kdf_algorithm",
    anchor: `static int sqlcipher_codec_ctx_set_kdf_algorithm(codec_ctx *ctx, int algorithm) {
  if(SQLCIPHER_FLAG_GET(ctx->flags, CIPHER_FLAG_KEY_USED)) return SQLITE_OK;

  ctx->kdf_algorithm = algorithm;
  return SQLITE_OK;
}
`,
    add: `static int sqlcipher_codec_ctx_set_kdf_algorithm(codec_ctx *ctx, int algorithm) {
  if(SQLCIPHER_FLAG_GET(ctx->flags, CIPHER_FLAG_KEY_USED)) return SQLITE_OK;

  /* SHUYONOTE-GM: 同 2a 的能力门。⚠️ **探测的是"这次要设的那个算法"，不是 SM3 常量** ——
  ** 第一版我写成了 get_hmac_sz(ctx->provider_ctx, SQLCIPHER_PBKDF2_HMAC_SM3)，
  ** 于是"没有 SM3 的 provider"（Apple 的 CommonCrypto 就是）连**默认的** PBKDF2-HMAC-SHA512
  ** 都会被拒 ⇒ ctx_init 失败 ⇒ PRAGMA key 直接不认那把 key（macOS 上 12+7 条红，2026-09-20 mac 抓出）。
  ** KDF 与 HMAC 两张表的枚举取值本来就是同一套编号（0/1/2/3），所以用 algorithm 探测与 2a 等价且正确。 */
  if(ctx->provider != NULL && ctx->provider->get_hmac_sz != NULL &&
     ctx->provider->get_hmac_sz(ctx->provider_ctx, algorithm) <= 0) {
    sqlcipher_log(SQLCIPHER_LOG_ERROR, SQLCIPHER_LOG_PROVIDER,
                  "%s: crypto provider does not support kdf algorithm %d", __func__, algorithm);
    return SQLITE_ERROR;
  }

  ctx->kdf_algorithm = algorithm;
  return SQLITE_OK;
}
`,
  },
  {
    id: "3a PRAGMA cipher_hmac_algorithm：接受分支",
    anchor: `        } else if(sqlite3_stricmp(zRight, SQLCIPHER_HMAC_SHA512_LABEL) == 0) {
          rc = sqlcipher_codec_ctx_set_hmac_algorithm(ctx, SQLCIPHER_HMAC_SHA512);
        }
`,
    add: `        } else if(sqlite3_stricmp(zRight, SQLCIPHER_HMAC_SHA512_LABEL) == 0) {
          rc = sqlcipher_codec_ctx_set_hmac_algorithm(ctx, SQLCIPHER_HMAC_SHA512);
        } else if(sqlite3_stricmp(zRight, SQLCIPHER_HMAC_SM3_LABEL) == 0) {
          rc = sqlcipher_codec_ctx_set_hmac_algorithm(ctx, SQLCIPHER_HMAC_SM3);
        }
`,
  },
  {
    id: "3b PRAGMA cipher_hmac_algorithm：回显分支",
    anchor: `        } else if(algorithm == SQLCIPHER_HMAC_SHA512) {
          sqlcipher_vdbe_return_string(pParse, "cipher_hmac_algorithm", SQLCIPHER_HMAC_SHA512_LABEL, P4_TRANSIENT);
        }
`,
    add: `        } else if(algorithm == SQLCIPHER_HMAC_SHA512) {
          sqlcipher_vdbe_return_string(pParse, "cipher_hmac_algorithm", SQLCIPHER_HMAC_SHA512_LABEL, P4_TRANSIENT);
        } else if(algorithm == SQLCIPHER_HMAC_SM3) {
          sqlcipher_vdbe_return_string(pParse, "cipher_hmac_algorithm", SQLCIPHER_HMAC_SM3_LABEL, P4_TRANSIENT);
        }
`,
  },
  {
    id: "3c PRAGMA cipher_default_hmac_algorithm：设置",
    anchor: `      } else if(sqlite3_stricmp(zRight, SQLCIPHER_HMAC_SHA512_LABEL) == 0) {
        default_hmac_algorithm = SQLCIPHER_HMAC_SHA512;
      }
`,
    add: `      } else if(sqlite3_stricmp(zRight, SQLCIPHER_HMAC_SHA512_LABEL) == 0) {
        default_hmac_algorithm = SQLCIPHER_HMAC_SHA512;
      } else if(sqlite3_stricmp(zRight, SQLCIPHER_HMAC_SM3_LABEL) == 0) {
        default_hmac_algorithm = SQLCIPHER_HMAC_SM3;
      }
`,
  },
  {
    id: "3d PRAGMA cipher_default_hmac_algorithm：回显",
    anchor: `      } else if(default_hmac_algorithm == SQLCIPHER_HMAC_SHA512) {
        sqlcipher_vdbe_return_string(pParse, "cipher_default_hmac_algorithm", SQLCIPHER_HMAC_SHA512_LABEL, P4_TRANSIENT);
      }
`,
    add: `      } else if(default_hmac_algorithm == SQLCIPHER_HMAC_SHA512) {
        sqlcipher_vdbe_return_string(pParse, "cipher_default_hmac_algorithm", SQLCIPHER_HMAC_SHA512_LABEL, P4_TRANSIENT);
      } else if(default_hmac_algorithm == SQLCIPHER_HMAC_SM3) {
        sqlcipher_vdbe_return_string(pParse, "cipher_default_hmac_algorithm", SQLCIPHER_HMAC_SM3_LABEL, P4_TRANSIENT);
      }
`,
  },
  {
    id: "3e PRAGMA cipher_kdf_algorithm：接受分支",
    anchor: `        } else if(sqlite3_stricmp(zRight, SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL) == 0) {
          rc = sqlcipher_codec_ctx_set_kdf_algorithm(ctx, SQLCIPHER_PBKDF2_HMAC_SHA512);
        }
`,
    add: `        } else if(sqlite3_stricmp(zRight, SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL) == 0) {
          rc = sqlcipher_codec_ctx_set_kdf_algorithm(ctx, SQLCIPHER_PBKDF2_HMAC_SHA512);
        } else if(sqlite3_stricmp(zRight, SQLCIPHER_PBKDF2_HMAC_SM3_LABEL) == 0) {
          rc = sqlcipher_codec_ctx_set_kdf_algorithm(ctx, SQLCIPHER_PBKDF2_HMAC_SM3);
        }
`,
  },
  {
    id: "3f PRAGMA cipher_kdf_algorithm：回显分支",
    anchor: `        } else if(ctx->kdf_algorithm == SQLCIPHER_PBKDF2_HMAC_SHA512) {
          sqlcipher_vdbe_return_string(pParse, "cipher_kdf_algorithm", SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL, P4_TRANSIENT);
        }
`,
    add: `        } else if(ctx->kdf_algorithm == SQLCIPHER_PBKDF2_HMAC_SHA512) {
          sqlcipher_vdbe_return_string(pParse, "cipher_kdf_algorithm", SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL, P4_TRANSIENT);
        } else if(ctx->kdf_algorithm == SQLCIPHER_PBKDF2_HMAC_SM3) {
          sqlcipher_vdbe_return_string(pParse, "cipher_kdf_algorithm", SQLCIPHER_PBKDF2_HMAC_SM3_LABEL, P4_TRANSIENT);
        }
`,
  },
  {
    id: "3g PRAGMA cipher_default_kdf_algorithm：设置",
    anchor: `      } else if(sqlite3_stricmp(zRight, SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL) == 0) {
        default_kdf_algorithm = SQLCIPHER_PBKDF2_HMAC_SHA512;
      }
`,
    add: `      } else if(sqlite3_stricmp(zRight, SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL) == 0) {
        default_kdf_algorithm = SQLCIPHER_PBKDF2_HMAC_SHA512;
      } else if(sqlite3_stricmp(zRight, SQLCIPHER_PBKDF2_HMAC_SM3_LABEL) == 0) {
        default_kdf_algorithm = SQLCIPHER_PBKDF2_HMAC_SM3;
      }
`,
  },
  {
    id: "3h PRAGMA cipher_default_kdf_algorithm：回显",
    anchor: `      } else if(default_kdf_algorithm == SQLCIPHER_PBKDF2_HMAC_SHA512) {
        sqlcipher_vdbe_return_string(pParse, "cipher_default_kdf_algorithm", SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL, P4_TRANSIENT);
      }
`,
    add: `      } else if(default_kdf_algorithm == SQLCIPHER_PBKDF2_HMAC_SHA512) {
        sqlcipher_vdbe_return_string(pParse, "cipher_default_kdf_algorithm", SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL, P4_TRANSIENT);
      } else if(default_kdf_algorithm == SQLCIPHER_PBKDF2_HMAC_SM3) {
        sqlcipher_vdbe_return_string(pParse, "cipher_default_kdf_algorithm", SQLCIPHER_PBKDF2_HMAC_SM3_LABEL, P4_TRANSIENT);
      }
`,
  },
  {
    id: "4a PRAGMA cipher_settings 自省：hmac",
    anchor: `      } else if(algorithm == SQLCIPHER_HMAC_SHA512) {
        pragma = sqlite3_mprintf("PRAGMA cipher_hmac_algorithm = %s;", SQLCIPHER_HMAC_SHA512_LABEL);
      }
`,
    add: `      } else if(algorithm == SQLCIPHER_HMAC_SHA512) {
        pragma = sqlite3_mprintf("PRAGMA cipher_hmac_algorithm = %s;", SQLCIPHER_HMAC_SHA512_LABEL);
      } else if(algorithm == SQLCIPHER_HMAC_SM3) {
        pragma = sqlite3_mprintf("PRAGMA cipher_hmac_algorithm = %s;", SQLCIPHER_HMAC_SM3_LABEL);
      }
`,
  },
  {
    id: "4b PRAGMA cipher_settings 自省：kdf",
    anchor: `      } else if(algorithm == SQLCIPHER_PBKDF2_HMAC_SHA512) {
        pragma = sqlite3_mprintf("PRAGMA cipher_kdf_algorithm = %s;", SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL);
      }
`,
    add: `      } else if(algorithm == SQLCIPHER_PBKDF2_HMAC_SHA512) {
        pragma = sqlite3_mprintf("PRAGMA cipher_kdf_algorithm = %s;", SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL);
      } else if(algorithm == SQLCIPHER_PBKDF2_HMAC_SM3) {
        pragma = sqlite3_mprintf("PRAGMA cipher_kdf_algorithm = %s;", SQLCIPHER_PBKDF2_HMAC_SM3_LABEL);
      }
`,
  },
  {
    id: "4c PRAGMA cipher_default_settings 自省：hmac",
    anchor: `    } else if(default_hmac_algorithm == SQLCIPHER_HMAC_SHA512) {
      pragma = sqlite3_mprintf("PRAGMA cipher_default_hmac_algorithm = %s;", SQLCIPHER_HMAC_SHA512_LABEL);
    }
`,
    add: `    } else if(default_hmac_algorithm == SQLCIPHER_HMAC_SHA512) {
      pragma = sqlite3_mprintf("PRAGMA cipher_default_hmac_algorithm = %s;", SQLCIPHER_HMAC_SHA512_LABEL);
    } else if(default_hmac_algorithm == SQLCIPHER_HMAC_SM3) {
      pragma = sqlite3_mprintf("PRAGMA cipher_default_hmac_algorithm = %s;", SQLCIPHER_HMAC_SM3_LABEL);
    }
`,
  },
  {
    id: "4d PRAGMA cipher_default_settings 自省：kdf",
    anchor: `    } else if(default_kdf_algorithm == SQLCIPHER_PBKDF2_HMAC_SHA512) {
      pragma = sqlite3_mprintf("PRAGMA cipher_default_kdf_algorithm = %s;", SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL);
    }
`,
    add: `    } else if(default_kdf_algorithm == SQLCIPHER_PBKDF2_HMAC_SHA512) {
      pragma = sqlite3_mprintf("PRAGMA cipher_default_kdf_algorithm = %s;", SQLCIPHER_PBKDF2_HMAC_SHA512_LABEL);
    } else if(default_kdf_algorithm == SQLCIPHER_PBKDF2_HMAC_SM3) {
      pragma = sqlite3_mprintf("PRAGMA cipher_default_kdf_algorithm = %s;", SQLCIPHER_PBKDF2_HMAC_SM3_LABEL);
    }
`,
  },
  {
    id: "5a OpenSSL provider · hmac：SM3 摘要参数",
    anchor: `  OSSL_PARAM sha512[] = { { "digest", OSSL_PARAM_UTF8_STRING, "sha512", 6, 0 }, OSSL_PARAM_END };
`,
    add: `  OSSL_PARAM sha512[] = { { "digest", OSSL_PARAM_UTF8_STRING, "sha512", 6, 0 }, OSSL_PARAM_END };
  /* SHUYONOTE-GM: 摘要名按 OpenSSL/Tongsuo 的 EVP_MAC 取法给 "SM3"（Tongsuo 3.x 里注册名大小写敏感）。 */
  OSSL_PARAM sm3[] = { { "digest", OSSL_PARAM_UTF8_STRING, "SM3", 3, 0 }, OSSL_PARAM_END };
`,
  },
  {
    id: "5b OpenSSL provider · hmac：SM3 分支",
    anchor: `    case SQLCIPHER_HMAC_SHA512:
      if(!(rc = EVP_MAC_init(hctx, hmac_key, key_sz, sha512))) {
        sqlcipher_log(SQLCIPHER_LOG_ERROR, SQLCIPHER_LOG_PROVIDER, "sqlcipher_openssl_hmac: EVP_MAC_init() with key size %d and sha512 returned %d", key_sz, rc);
        sqlcipher_openssl_log_errors();
        goto error;
      }
      break;
`,
    add: `    case SQLCIPHER_HMAC_SHA512:
      if(!(rc = EVP_MAC_init(hctx, hmac_key, key_sz, sha512))) {
        sqlcipher_log(SQLCIPHER_LOG_ERROR, SQLCIPHER_LOG_PROVIDER, "sqlcipher_openssl_hmac: EVP_MAC_init() with key size %d and sha512 returned %d", key_sz, rc);
        sqlcipher_openssl_log_errors();
        goto error;
      }
      break;
    case SQLCIPHER_HMAC_SM3:
      if(!(rc = EVP_MAC_init(hctx, hmac_key, key_sz, sm3))) {
        sqlcipher_log(SQLCIPHER_LOG_ERROR, SQLCIPHER_LOG_PROVIDER, "sqlcipher_openssl_hmac: EVP_MAC_init() with key size %d and sm3 returned %d", key_sz, rc);
        sqlcipher_openssl_log_errors();
        goto error;
      }
      break;
`,
  },
  {
    id: "5c OpenSSL provider · kdf：SM3 分支",
    anchor: `    case SQLCIPHER_HMAC_SHA512:
      if(!(rc = PKCS5_PBKDF2_HMAC((const char *)pass, pass_sz, salt, salt_sz, workfactor, EVP_sha512(), key_sz, key))) {
        sqlcipher_log(SQLCIPHER_LOG_ERROR, SQLCIPHER_LOG_PROVIDER, "sqlcipher_openssl_kdf: PKCS5_PBKDF2_HMAC() for EVP_sha512() workfactor %d and key size %d returned %d", workfactor, key_sz, rc);
        sqlcipher_openssl_log_errors();
        goto error;
      }
      break;
`,
    add: `    case SQLCIPHER_HMAC_SHA512:
      if(!(rc = PKCS5_PBKDF2_HMAC((const char *)pass, pass_sz, salt, salt_sz, workfactor, EVP_sha512(), key_sz, key))) {
        sqlcipher_log(SQLCIPHER_LOG_ERROR, SQLCIPHER_LOG_PROVIDER, "sqlcipher_openssl_kdf: PKCS5_PBKDF2_HMAC() for EVP_sha512() workfactor %d and key size %d returned %d", workfactor, key_sz, rc);
        sqlcipher_openssl_log_errors();
        goto error;
      }
      break;
    case SQLCIPHER_HMAC_SM3: /* == SQLCIPHER_PBKDF2_HMAC_SM3（两张表都取 3） */
      if(!(rc = PKCS5_PBKDF2_HMAC((const char *)pass, pass_sz, salt, salt_sz, workfactor, EVP_sm3(), key_sz, key))) {
        sqlcipher_log(SQLCIPHER_LOG_ERROR, SQLCIPHER_LOG_PROVIDER, "sqlcipher_openssl_kdf: PKCS5_PBKDF2_HMAC() for EVP_sm3() workfactor %d and key size %d returned %d", workfactor, key_sz, rc);
        sqlcipher_openssl_log_errors();
        goto error;
      }
      break;
`,
  },
  {
    id: "5d OpenSSL provider · get_hmac_sz：SM3 → 32",
    anchor: `    case SQLCIPHER_HMAC_SHA512:
      return EVP_MD_size(EVP_sha512());
      break;
`,
    add: `    case SQLCIPHER_HMAC_SHA512:
      return EVP_MD_size(EVP_sha512());
      break;
    case SQLCIPHER_HMAC_SM3:
      return EVP_MD_size(EVP_sm3()); /* 32 —— 同时是上面两处能力门的探测口 */
      break;
`,
  },
];

let patched = pristine;
for (const e of EDITS) {
  const n = patched.split(e.anchor).length - 1;
  if (n !== 1) {
    console.error(
      `make-sm3-provider-patch: ❌ 锚点「${e.id}」在文件里出现 ${n} 次（要求恰好 1 次）⇒ 停手。\n` +
        `  多半是 SQLCipher 版本变了：请拿上面那段锚点原文去新源码里找，改好这一段再重新生成。`,
    );
    process.exit(1);
  }
  patched = patched.replace(e.anchor, e.add);
}

// ---- 生成 diff（a/sqlite3.c ↔ b/sqlite3.c，供 -p1 应用）----
const dir = mkdtempSync(join(tmpdir(), "sm3-patch-"));
const aDir = join(dir, "a");
const bDir = join(dir, "b");
execFileSync("mkdir", ["-p", aDir, bDir]);
writeFileSync(join(aDir, "sqlite3.c"), pristine);
writeFileSync(join(bDir, "sqlite3.c"), patched);
let diff = "";
try {
  diff = execFileSync("diff", ["-u", join(aDir, "sqlite3.c"), join(bDir, "sqlite3.c")], { encoding: "utf8" });
} catch (e) {
  diff = e.stdout || "";
}
if (!diff.trim()) {
  console.error("make-sm3-provider-patch: ❌ diff 为空 ⇒ 改动表没生效。");
  process.exit(1);
}
diff = diff.replace(/^--- .*$/m, "--- a/sqlite3.c").replace(/^\+\+\+ .*$/m, "+++ b/sqlite3.c");

const header = `SHUYONOTE-GM 补丁 0001：给 SQLCipher 加国密 SM3 两格（cipher_hmac_algorithm / cipher_kdf_algorithm）
================================================================================
生成者：patches/tools/make-sm3-provider-patch.mjs（在干净的 sqlite3.c 上跑）
应用者：scripts/sm-library-build.mjs（\`git apply -p1\`，在 sqlcipher/ 目录里；幂等）
判据：src-tauri/build.rs 扫 SQLCIPHER_HMAC_SM3_LABEL 标记；运行期判据在 src-tauri/src/gm_provider.rs
本补丁**不含** SM4 页加密（P3）—— 见 patches/README.md「P3 还没做的部分」。
`;
writeFileSync(outPath, header + diff);
console.log(`make-sm3-provider-patch: ✅ 写出 ${outPath}（${diff.split("\n").length} 行 diff，${EDITS.length} 段改动）`);
for (const e of EDITS) console.log(`  · ${e.id}`);
