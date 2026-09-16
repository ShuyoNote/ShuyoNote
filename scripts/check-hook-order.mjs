// hooks 顺序门禁：**同一个组件里，早退之前还有 hooks 吗？**
//
// 为什么要有它——同一类错在这份代码里已经发生过**两次**，两次都是"用户的界面直接没了"：
//   1. v1.85.1：`CommandPalette` 把参数表单的三个 `useState` 放在 `if (!open) return null`
//      **之后** ⇒ 按 Ctrl+K 抛错（生产是 Minified React error #310）⇒ 整棵树被卸载成白屏。
//   2. 2026-09-16：`App` 的加密锁定闸门是一句**排在七八个 hooks 之前**的早退 ⇒
//      加密安装**重启即抛 `Rendered fewer hooks than expected`** ⇒ 根部 ErrorBoundary 接住 ⇒
//      用户看到崩溃屏，而 E1 那道锁定屏**一次都没出现过**（真机只验了设置页开关）。
// 两次都不是"写错了"，是"**看漏了**"：早退和 hooks 隔着几十行，人眼很难可靠发现。
// 渲染级测试能证明"某一个组件当前是对的"，这条管的是"**仓库里别再出现这种写法**"。
//
// 判据（按**顶层声明块**分段，块内看源码顺序）：
//   块内存在一行 `return`，且它**后面**还有一行 hook 调用，并且那个 hook 的缩进 ≤ 那个 return 的缩进
//   ⇒ 报红。缩进这一条是为了不误伤"早退之后定义的嵌套组件/局部函数里的 hooks"
//   （那种写法的 hooks 缩进更深，而且它本身另有问题，归渲染级测试管）。
//
// ⚠️ 边界（如实写清，别当它是 AST）：
//   - 这是**按 token + 花括号层级**的启发式：先把注释/字符串抹掉，再按 `{`/`}` 维护
//     "函数体层级"，只认**最外层那个函数体里**的 `return` 与 hooks（嵌套回调/嵌套组件里的
//     一律不算——它们属于别的函数）。
//   - 漏报：`return` 与 hooks 写在同一行；hook 调用写在字符串里被抹掉后再拼出来之类的花样；
//     以及"hooks 全排在最后一个 return 之后、只是数量随分支变化"那种（那类只能靠渲染级测试）。
//   - hooks 在条件里（同一类错的另一种写法）**本门禁不查**：没有语法树时误报率太高，
//     靠代码评审 + 渲染级测试兜。
//   `--self-test` 里放的是两次真事故的**真实写法**（必须判红）与几个必须放过的写法。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HOOK_RE = /\buse[A-Z][A-Za-z0-9_$]*\s*\(/g;
const RETURN_RE = /\breturn\b/g;
const CONTROL_START = /^(if|for|while|switch|catch|else|do|try)\b/;

// React 自带 hooks + 本仓自己声明的 `useXxx`——只认这些名字。
// 为什么不能见到 `use[A-Z]` 就算：仓里有**同名的 store 动作**（如 `useTemplate(t)`，
// 见 TemplateCenterView.tsx），照字面匹配会把它当成 hook 调用而误报。
const REACT_HOOKS = new Set([
  "useState",
  "useEffect",
  "useMemo",
  "useCallback",
  "useRef",
  "useReducer",
  "useContext",
  "useLayoutEffect",
  "useImperativeHandle",
  "useInsertionEffect",
  "useSyncExternalStore",
  "useTransition",
  "useDeferredValue",
  "useOptimistic",
  "useActionState",
  "useId",
  "useDebugValue",
]);
// 只把"**声明成函数**的 useXxx"当 hook：
//   `function useX(` / `const useX = (` / `const useX = async (`
// 不能把 `const useTemplate = useTemplates((s) => s.useTemplate)` 这种**同名 store 动作**
// 也算进来——仓里真有（TemplateCenterView.tsx），照字面匹配就会误报。
const DECLARED_HOOK_RE = /\b(?:function\s+(use[A-Z][A-Za-z0-9_$]*)\s*\(|(?:const|let|var)\s+(use[A-Z][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:function\b|\())/g;

/** 把注释与字符串字面量抹成空格（保留换行与长度，行号才对得上）。 */
function stripCommentsAndStrings(text) {
  const out = text.split("");
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? text.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === c) break;
        else j++;
      }
      blank(i + 1, Math.min(j, text.length));
      i = Math.min(j + 1, text.length);
      continue;
    }
    i++;
  }
  return out.join("");
}

/** 扫描一段源码文本，返回"早退越过 hooks"的问题列表（行号 1 起）。 */
export function inspectSource(text, hookNames = REACT_HOOKS) {
  const code = stripCommentsAndStrings(text);
  const problems = [];

  // 用栈维护花括号层级；每个 `{` 判断它是不是"函数体"（回调/箭头/function/方法）。
  const stack = [];
  let pendingReturn = null;
  let line = 1;
  let stmtStart = 0; // 当前语句（用于判断 `{` 前的文本是不是控制语句）

  const fnDepth = () => stack.filter((s) => s.fn).length;

  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\n") {
      line++;
      continue;
    }
    if (c === "{" || c === "}") {
      if (c === "{") {
        const before = code.slice(stmtStart, i).trim();
        // 函数体的三种样子：箭头 `=> {`、`function ...(`、以及"以 `)` 结尾且不是控制语句"
        // （回调/方法的缩写写法）。`if (x) {` 不能算函数体，否则里面的 return 会被当成嵌套函数。
        const isFn =
          /=>$/.test(before) || /\bfunction\b/.test(before) || (/\)$/.test(before) && !CONTROL_START.test(before));
        stack.push({ fn: isFn });
        stmtStart = i + 1;
      } else {
        stack.pop();
        stmtStart = i + 1;
        // 最外层函数体关掉了：这一段结束，别把它的 return 带到下一个组件去。
        if (fnDepth() === 0) pendingReturn = null;
      }
      continue;
    }
    if (c === ";" || c === "(" || c === ")") {
      if (c === ";") stmtStart = i + 1;
      continue;
    }
    if (fnDepth() === 1) {
      // 只看最外层函数体里的 return / hooks
      RETURN_RE.lastIndex = i;
      const r = RETURN_RE.exec(code);
      if (r && r.index === i) {
        pendingReturn = { line };
        i += r[0].length - 1;
        continue;
      }
      HOOK_RE.lastIndex = i;
      const h = HOOK_RE.exec(code);
      if (h && h.index === i && hookNames.has(h[0].replace(/\s*\($/, ""))) {
        if (pendingReturn) {
          problems.push({
            line,
            returnLine: pendingReturn.line,
            hook: h[0].replace(/\s*\($/, ""),
          });
          pendingReturn = null; // 一个早退只报一次
        }
        i += h[0].length - 1;
        continue;
      }
    }
  }
  return problems;
}

// ---- 自测：样本来自两次真事故 + 两个必须放过的写法 ----
function selfTest() {
  const cases = [
    {
      name: "真事故①（v1.85.1 命令面板白屏）：`if (!open) return null;` 之后才 useState",
      code: [
        "export function CommandPalette() {",
        "  const open = useEditorStore((s) => s.paletteOpen);",
        "  if (!open) return null;",
        '  const [argInput, setArgInput] = useState("");',
        "  return <div />;",
        "}",
      ].join("\n"),
      expect: 1,
    },
    {
      name: "真事故②（2026-09-16 加密重启崩溃屏）：早退在 if 块里，后面才有 useEffect",
      code: [
        "function App() {",
        "  const view = useViewStore((s) => s.view);",
        "  const locked = true;",
        "  if (locked) {",
        "    return <LockScreen />;",
        "  }",
        "  useEffect(() => {",
        "    loadPages();",
        "  }, []);",
        "  return <div />;",
        "}",
      ].join("\n"),
      expect: 1,
    },
    {
      name: "正确写法：所有 hooks 在前，早退在后",
      code: [
        "function C({ open }) {",
        "  const [a] = useState(1);",
        "  useEffect(() => {}, [a]);",
        "  if (!open) return null;",
        "  return <b>{a}</b>;",
        "}",
      ].join("\n"),
      expect: 0,
    },
    {
      name: "必须放过：早退之后定义的**嵌套组件**里的 hooks（缩进更深，不是同一层）",
      code: [
        "function C({ open }) {",
        "  if (!open) return null;",
        "  function Inner() {",
        "    const [a] = useState(1);",
        "    return <b>{a}</b>;",
        "  }",
        "  return <Inner />;",
        "}",
      ].join("\n"),
      expect: 0,
    },
    {
      name: "必须放过：注释里的 return / 字符串里的 useXxx 不算",
      code: [
        "function C() {",
        "  const [a] = useState(1);",
        "  // if (!a) return null;",
        '  const label = "useState(";',
        "  return <b>{a}{label}</b>;",
        "}",
      ].join("\n"),
      expect: 0,
    },
  ];
  let failed = 0;
  for (const c of cases) {
    const got = inspectSource(c.code);
    const ok = got.length === c.expect;
    if (!ok) failed++;
    console.log(`${ok ? "  ✓" : "  ✗"} ${c.name}（期望 ${c.expect} 条，实际 ${got.length} 条）`);
    if (!ok) for (const g of got) console.log(`      → 第 ${g.line} 行 ${g.hook}（早退在第 ${g.returnLine} 行）`);
  }
  console.log(failed === 0 ? "\n自测通过：2 个真事故写法判红、3 个正确写法放过" : `\n自测失败：${failed} 例`);
  return failed === 0;
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry && process.argv.includes("--self-test")) {
  process.exit(selfTest() ? 0 : 1);
}

if (!isEntry) {
  // 被 import 时只导出 inspectSource（自测/调试用），不跑仓库扫描。
} else {
  run();
}

function run() {
  function walk(dir, out) {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "dist-web") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  }

  const files = [];
  walk(resolve(root, "src"), files);

  // 先扫一遍：本仓自己声明的 `useXxx` 也算 hook——但**只认 hooks 目录/`use*.ts` 里的声明**。
  // 为什么收这么紧：组件里会有"名字以 use 开头、但根本不是 hook"的局部函数
  // （`TemplateCenterView.tsx` 里就有 `const useTemplate = async (t) => {...}`，
  // 它是这个组件的动作），把它当 hook 会误报。宁可漏（漏了还有渲染级测试兜），不要误报。
  const sources = files.map((f) => ({ f, rel: relative(root, f).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));
  const hookNames = new Set(REACT_HOOKS);
  for (const { rel, text } of sources) {
    const isHooksModule = rel.includes("/hooks/") || /(^|\/)use[A-Z][^/]*\.tsx?$/.test(rel);
    if (!isHooksModule) continue;
    DECLARED_HOOK_RE.lastIndex = 0;
    for (const m of text.matchAll(DECLARED_HOOK_RE)) {
      const name = m[1] ?? m[2];
      if (name) hookNames.add(name);
    }
  }

  const all = [];
  for (const { rel, text } of sources) {
    for (const p of inspectSource(text, hookNames)) all.push({ ...p, file: rel });
  }

  if (all.length === 0) {
    console.log(`[check-hook-order] ${files.length} 个 .ts/.tsx：没有"早退越过 hooks"的写法。`);
    process.exit(0);
  }

  console.error(`[check-hook-order] 发现 ${all.length} 处"早退越过 hooks"：`);
  for (const p of all) {
    console.error(`  ${p.file}:${p.line}  ${p.hook}  —— 第 ${p.returnLine} 行的 return 排在它前面`);
  }
  console.error("\nhooks 必须在这个函数的**每一次**渲染里按同一顺序全部跑到：早退要放到所有 hooks 之后。");
  console.error("修好后重跑 `pnpm check:hook-order`（自测：`node scripts/check-hook-order.mjs --self-test`）。");
  process.exit(1);
}
