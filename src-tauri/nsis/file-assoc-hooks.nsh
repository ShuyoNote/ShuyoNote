; ============================================================================
; 文件关联（Windows 安装器侧）—— 让「双击 .docx」真的能唤起本应用，
; 但 ⛔ **不抢默认**（默认打开程序一个字都不动）。
;
; 这个文件是**我们自己的**（不是 Tauri 上游的）。它由 `src-tauri/tauri.conf.json` 的
; `bundle.windows.nsis.installerHooks` 指名，被 `nsis/installer.nsi`（我们 fork 的、
; 与上游逐字节相同、只差默认安装目录那一行的那份）第 59-60 行 `!include` 进来，
; 并在模板的 666 / 758 / 803 / 911 行分别插入下面这四个 hook 宏。
;   ⇒ 本文件**不碰 installer.nsi 一个字** ⇒ `scripts/check-nsis-template.mjs` 那条
;     「模板与上游的差异只许是那一行」不受影响 ✓
;
; ⛔⛔ 两条红线（`scripts/check-nsis-template.mjs` 的「判据 b」机械钉住它们，
;       带注释的写法**不算**违规 —— 判据先剥注释再匹配）：
;   1. **绝不写** `Software\Classes\.<ext>` 的**默认值（空值名）**。
;      写它 = 把用户双击 .docx 时打开的程序改成我们 = **抢掉 Word** ✗
;      Tauri 的 `bundle.fileAssociations` 走的正是那条路 —— 上游 `FileAssociation.nsh`
;      的 `APP_ASSOCIATE` 里逐字有这一行：
;         WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "${FILECLASS}"
;      而且那个文件自己的注释写着「…only meant to associate an application with a
;      single file and using the "open" verb as default」。
;      ⇒ 所以我们**不用** `fileAssociations`，改走 `OpenWithProgids` ✓
;   2. 卸载时**不删** `Software\Classes\.<ext>` 的默认值 —— 我们从头到尾没写过它；
;      去删等于**破坏别人的**关联（用户机器上那是 Word 的）✗
;      ⇒ 只精确删掉我们自己写的那两处（见下面 UNREGISTER）。
;
; 只写 `OpenWithProgids` ⇒ 语义是「**可以用它打开**」：资源管理器「打开方式」里多一项，
; 而「默认打开程序」保持不变 ✓
;
; ⚠️ 本文件**未在本机编译验证**（本机没有 `makensis`；发版/打包归 Lead）⇒
;    用到的 NSIS 命令与 define 逐条都取自上游那两份文件（可 grep 复核，2026-10-10 实测）：
;      WriteRegStr ✓ ／ DeleteRegValue ✓ ／ DeleteRegKey（含 `/ifempty`）✓ ／ SHCTX ✓
;      UPDATEFILEASSOC（定义在 FileAssociation.nsh，模板第 52 行已 include）✓
;      $INSTDIR ／ ${PRODUCTNAME} ／ ${MAINBINARYNAME}（均模板 `!define`）✓
;    ⛔ 刻意**不用** `WriteRegNone`（那两份文件里 0 次命中 ⇒ 不赌它存在）；
;      `OpenWithProgids` 的枚举只认**值名**，所以空字符串的 REG_SZ 一样会被列出来 ✓
; ============================================================================

; 登记一个扩展名：建自有 ProgID（决定「打开方式」里那一项显示什么、用什么命令打开）
; ＋ 把它挂进该扩展名的 OpenWithProgids（只「可以用它打开」）。
!macro SHUYONOTE_OPENWITH_REGISTER EXT PROGID DESC
  ; ① 自有 ProgID 类键。DESC 会显示在资源管理器的「类型」列
  WriteRegStr SHCTX "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open" "" "用 ${PRODUCTNAME} 打开"
  ; `--import <文件>` 这条命令行由 task-10 实现（src-tauri/src/office_import.rs），这里只引用不改
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --import $\"%1$\""

  ; ② ⭐ 只挂进「打开方式」候选清单。
  ;    ⛔ 注意：这里**没有**、也永远不许有
  ;       WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "…"
  ;       那一行才是「抢默认」。判据 b 就是钉住它不出现（剥掉注释后匹配）。
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
!macroend

; 反登记：只删我们自己写的那两处；⛔ 不碰 `.ext` 的默认值（那是别人的）。
!macro SHUYONOTE_OPENWITH_UNREGISTER EXT PROGID
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  ; 别的程序（Word / WPS…）也往同一个键里挂过 ⇒ **空了才删**，绝不整键扫掉
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey SHCTX "Software\Classes\${PROGID}"
!macroend

; 装完之后（模板 758 行插入）。
; 只登记导入引擎**真的支持**的 4 个扩展名（源码：src/lib/extract/ooxml.ts:564/571/578
; 与 src/lib/extract/text.ts:32-33）；`.doc` / `.xls` / `.ppt` 那三个旧格式（legacy.ts）
; 这一轮**不登记** —— 真机验过再说。
!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SHUYONOTE_OPENWITH_REGISTER "docx" "ShuyoNote.docx" "Word 文档（用数友笔记打开）"
  !insertmacro SHUYONOTE_OPENWITH_REGISTER "xlsx" "ShuyoNote.xlsx" "Excel 工作簿（用数友笔记打开）"
  !insertmacro SHUYONOTE_OPENWITH_REGISTER "pptx" "ShuyoNote.pptx" "PowerPoint 演示文稿（用数友笔记打开）"
  !insertmacro SHUYONOTE_OPENWITH_REGISTER "md" "ShuyoNote.md" "Markdown 文档（用数友笔记打开）"
  !insertmacro UPDATEFILEASSOC
!macroend

; 卸载之后（模板 911 行插入）—— 不留孤儿关联。
!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro SHUYONOTE_OPENWITH_UNREGISTER "docx" "ShuyoNote.docx"
  !insertmacro SHUYONOTE_OPENWITH_UNREGISTER "xlsx" "ShuyoNote.xlsx"
  !insertmacro SHUYONOTE_OPENWITH_UNREGISTER "pptx" "ShuyoNote.pptx"
  !insertmacro SHUYONOTE_OPENWITH_UNREGISTER "md" "ShuyoNote.md"
  !insertmacro UPDATEFILEASSOC
!macroend
