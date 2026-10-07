// 判据：**导入 md 表格时按内容给列宽**（owner：「导入笔记时，表格列可否自动适配列宽，
//   或跳到一个视觉合理的宽度」✗）。
//   ⚠️ 本文件只用单引号字符串、中文引用用「」。
import { describe, expect, it } from 'vitest';
import { createEditor } from 'lexical';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { HeadingNode } from '@lexical/rich-text';
import { TableNode, TableRowNode, TableCellNode } from '@lexical/table';
import { CodeNode, CodeHighlightNode } from '@lexical/code';
import { suggestColWidths, visualLen } from './tableFit';
import { SHUYONOTE_TRANSFORMERS } from '../editor/markdownTransformers';
import { MermaidNode } from '../editor/nodes/MermaidNode';
import { SafeCodeNode } from '../editor/nodes/SafeCodeNode';
import { BlockTableNode } from '../editor/nodes/BlockTableNode';

describe('visualLen / suggestColWidths（纯规则）', () => {
  it('CJK 算 2、ASCII 算 1（中英混排才量得准 ✓）', () => {
    expect(visualLen('abc')).toBe(3);
    expect(visualLen('中文')).toBe(4);
    expect(visualLen('a中')).toBe(3);
    expect(visualLen('')).toBe(0);
  });

  it('★ 文字多的列分到更宽（owner 那张表的形状 ✓）', () => {
    const rows = [
      ['内容类型', '占比', '示例', '目的'],
      ['行业方案', '30%', '“招标公司如何用 AI 做合规审查”', '精准获客'],
      ['客户案例', '25%', '“某 500 强招标公司的 AI 原生实践”', '建立信任'],
    ];
    const w = suggestColWidths(rows, 1000);
    expect(w.length).toBe(4);
    expect(w.reduce((a, b) => a + b, 0)).toBe(1000); // 总和就是 total ✓
    expect(w[2]).toBeGreaterThan(w[1]); // 「示例」比「占比」宽 ✓（这正是它们现在等宽时最难看的地方 ✓）
    expect(Math.min(...w)).toBeGreaterThanOrEqual(80); // 每列都有下限 ✓
  });

  it('长文本列用 sqrt 压过 ⇒ 不会把别的列挤成一条（下限仍然守得住 ✓）', () => {
    const rows = [['a', 'x'.repeat(4000)]];
    const w = suggestColWidths(rows, 1000);
    expect(w[0]).toBeGreaterThanOrEqual(80);
    expect(w[1]).toBeLessThan(1000);
  });

  it('总宽不够分（列很多）⇒ 退化成等宽，不造负数 ✓；空表也不炸 ✓', () => {
    const many = [Array.from({ length: 20 }, () => 'x')];
    const w = suggestColWidths(many, 400);
    expect(w.length).toBe(20);
    expect(new Set(w).size).toBe(1);
    expect(suggestColWidths([], 1000).length).toBe(1);
  });
});

describe('导入 md 表格 ⇒ 列宽按内容来（端到端 ✓）', () => {
  const nodes = [MermaidNode, SafeCodeNode, HeadingNode, CodeNode, CodeHighlightNode, BlockTableNode, TableNode, TableRowNode, TableCellNode];

  function importTable(md: string): Record<string, unknown> | undefined {
    const editor = createEditor({
      namespace: 'table-colwidth',
      nodes,
      onError: (e) => {
        throw e;
      },
    });
    editor.update(() => $convertFromMarkdownString(md, SHUYONOTE_TRANSFORMERS), { discrete: true });
    const tree = editor.getEditorState().toJSON() as { root: { children: Array<Record<string, unknown>> } };
    const walk = (n: unknown): Record<string, unknown> | undefined => {
      if (!n || typeof n !== 'object') return undefined;
      const rec = n as Record<string, unknown>;
      if (rec.type === 'table') return rec;
      for (const v of Object.values(rec)) {
        if (Array.isArray(v)) {
          for (const c of v) {
            const hit = walk(c);
            if (hit) return hit;
          }
        } else if (v && typeof v === 'object') {
          const hit = walk(v);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    return walk(tree.root);
  }

  it('★ 导入后的表格**带** colWidths，且文字多的列更宽（⛔ 不再是各列等宽 ✗）', () => {
    const md = [
      '| 内容类型 | 占比 | 示例 | 目的 |',
      '| --- | --- | --- | --- |',
      '| 行业方案 | 30% | “招标公司如何用 AI 做合规审查” | 精准获客 |',
      '| 客户案例 | 25% | “某 500 强招标公司的 AI 原生实践” | 建立信任 |',
    ].join('\n');
    const table = importTable(md);
    expect(table, '没导入出表格节点').toBeTruthy();
    const widths = (table!.colWidths as number[]) ?? [];
    expect(widths.length, 'colWidths 没写进去 ✗（那就是各列等宽 ✗）').toBe(4);
    expect(widths[2]).toBeGreaterThan(widths[1]); // 示例 > 占比 ✓
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(80);
  });
});
