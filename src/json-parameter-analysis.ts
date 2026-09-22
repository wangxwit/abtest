import { createScanner, parseTree, printParseErrorCode } from 'jsonc-parser';
import * as jsoncParser from 'jsonc-parser';
import type { Node, ParseError } from 'jsonc-parser';

// The runtime exports this object, but its ambient const-enum declaration cannot
// be imported as a value with verbatimModuleSyntax and isolatedModules enabled.
const SyntaxKind = (jsoncParser as unknown as { SyntaxKind: Record<'EOF' | 'OpenBraceToken' | 'CloseBraceToken' | 'OpenBracketToken' | 'CloseBracketToken', number> }).SyntaxKind;

export type ParameterJsonDiagnostic = {
  from: number;
  to: number;
  message: string;
  severity: 'error' | 'warning';
};

export type ParameterJsonNode = {
  /** JSON Pointer: dots in parameter keys remain literal; ~ and / are escaped. */
  path: string;
  segments: (string | number)[];
  key: string;
  type: string;
  /** The first parameter level has depth 0. */
  depth: number;
  /** Property key start (or array item start) through the end of its value. */
  from: number;
  to: number;
  line: number;
  preview: string;
  topLevelKey: string;
};

export type ParameterJsonAnalysis = {
  valid: boolean;
  diagnostics: ParameterJsonDiagnostic[];
  nodes: ParameterJsonNode[];
  /** Present only when the entire source is a strict, finite, duplicate-free JSON object. */
  value?: Record<string, unknown>;
  /** Limits only the navigation outline, never validation or structural comparisons. */
  truncated?: boolean;
};

export type ParameterJsonChange = {
  path: string;
  segments: (string | number)[];
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
  /** Offsets refer to the after document; removed paths do not have offsets. */
  from?: number;
  to?: number;
};

export type ParameterJsonDiff = {
  valid: boolean;
  changes: ParameterJsonChange[];
  error?: string;
};

const MAX_DEPTH = 32;
const MAX_OUTLINE_NODES = 5000;
const strictOptions = { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false };
const parseMessages: Record<string, string> = {
  InvalidSymbol: '存在无效的 JSON 符号',
  InvalidNumberFormat: '数字格式无效',
  PropertyNameExpected: '此处需要双引号包围的属性名，不能使用尾随逗号',
  ValueExpected: '此处缺少有效的 JSON 值',
  ColonExpected: '属性名后缺少冒号',
  CommaExpected: '字段或数组项之间缺少逗号',
  CloseBraceExpected: '缺少对象的右花括号 }',
  CloseBracketExpected: '缺少数组的右方括号 ]',
  EndOfFileExpected: 'JSON 值结束后存在多余内容',
  InvalidCommentToken: 'JSON 不支持注释',
  UnexpectedEndOfComment: 'JSON 不支持注释，且当前注释未结束',
  UnexpectedEndOfString: '字符串缺少结束双引号',
  UnexpectedEndOfNumber: '数字未填写完整',
  InvalidUnicode: 'Unicode 转义格式无效',
  InvalidEscapeCharacter: '字符串转义字符无效',
  InvalidCharacter: '字符串中存在需要转义的控制字符',
};

function pointer(segments: (string | number)[]): string {
  return segments.map(segment => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

function nodePreview(node: Node | undefined): string {
  if (!node) return '未完成';
  if (node.type === 'object') return `${node.children?.length ?? 0} 个字段`;
  if (node.type === 'array') return `${node.children?.length ?? 0} 项`;
  const text = node.type === 'string' ? JSON.stringify(node.value) : String(node.value);
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

/** Analyze without normalizing or writing any of the user's original text. */
export function analyzeParameterJson(source: string): ParameterJsonAnalysis {
  const diagnostics: ParameterJsonDiagnostic[] = [];
  const nodes: ParameterJsonNode[] = [];
  const addError = (from: number, to: number, message: string) => {
    diagnostics.push({ from: Math.max(0, Math.min(source.length, from)), to: Math.max(0, Math.min(source.length, to)), message, severity: 'error' });
  };

  // parseTree is recursive. A scanner first bounds nesting even for malformed raw text.
  // The AST pass below checks leaf depth too, using the whole JSON object as depth 0.
  const scanner = createScanner(source, true);
  let nesting = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) nesting++;
    if (nesting > MAX_DEPTH + 1) {
      addError(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength(), `JSON 嵌套不能超过 ${MAX_DEPTH} 层`);
      return { valid: false, diagnostics, nodes };
    }
    if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) nesting = Math.max(0, nesting - 1);
  }

  const errors: ParseError[] = [];
  let root: Node | undefined;
  try {
    root = parseTree(source, errors, strictOptions);
  } catch {
    // Fault-tolerant parsing of a malformed document must never take down the editor.
    addError(0, source.length, 'JSON 结构无法解析，请检查嵌套层级和括号是否闭合');
    return { valid: false, diagnostics, nodes };
  }
  for (const error of errors) {
    const code = printParseErrorCode(error.error);
    addError(error.offset, error.offset + error.length, parseMessages[code] ?? 'JSON 格式无效');
  }
  if (!root || root.type !== 'object') {
    addError(root?.offset ?? 0, root ? root.offset + root.length : source.length, '实验分组参数必须是 JSON 对象，例如 {"ranking.enabled": true}');
  }

  const lineStarts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') index++;
      lineStarts.push(index + 1);
    } else if (source[index] === '\n') lineStarts.push(index + 1);
  }
  const lineAt = (offset: number) => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid;
    }
    return low + 1;
  };
  let truncated = false;
  const appendNode = (node: Node | undefined, segments: (string | number)[], from: number, fallbackEnd: number) => {
    if (nodes.length >= MAX_OUTLINE_NODES) { truncated = true; return; }
    nodes.push({
      path: pointer(segments), segments, key: String(segments.at(-1)), type: node?.type ?? 'unknown',
      depth: segments.length - 1, from, to: node ? Math.min(source.length, node.offset + node.length) : fallbackEnd,
      line: lineAt(from), preview: nodePreview(node), topLevelKey: String(segments[0]),
    });
  };
  const visit = (node: Node, segments: (string | number)[]) => {
    if (segments.length > MAX_DEPTH) {
      addError(node.offset, node.offset + node.length, `JSON 嵌套不能超过 ${MAX_DEPTH} 层`);
      return;
    }
    if (node.type === 'number' && !Number.isFinite(node.value)) {
      addError(node.offset, node.offset + node.length, '数字必须为有限值，不能超出 JavaScript 数值范围');
    }
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const keyNode = property.children?.[0];
        if (!keyNode || keyNode.type !== 'string') continue;
        const key = String(keyNode.value);
        if (keys.has(key)) addError(keyNode.offset, keyNode.offset + keyNode.length, `属性 ${JSON.stringify(key)} 重复，请为每个属性保留唯一值`);
        keys.add(key);
        const valueNode = property.children?.[1];
        const path = [...segments, key];
        appendNode(valueNode, path, keyNode.offset, keyNode.offset + keyNode.length);
        if (valueNode) visit(valueNode, path);
      }
    } else if (node.type === 'array') {
      for (const [index, child] of (node.children ?? []).entries()) {
        const path = [...segments, index];
        appendNode(child, path, child.offset, child.offset + child.length);
        visit(child, path);
      }
    }
  };
  if (root) visit(root, []);
  if (truncated) diagnostics.push({ from: 0, to: 0, severity: 'warning', message: `参数目录仅展示前 ${MAX_OUTLINE_NODES} 个条目；完整内容仍参与校验和差异比较` });
  diagnostics.sort((a, b) => a.from - b.from || a.to - b.to);
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) return { valid: false, diagnostics, nodes, ...(truncated ? { truncated: true } : {}) };

  try {
    // JSON.parse also preserves an own "__proto__" property without invoking its setter.
    // Never reconstruct user objects through Object.assign or object[key] assignments.
    const value = JSON.parse(source) as Record<string, unknown>;
    return { valid: true, diagnostics, nodes, value, ...(truncated ? { truncated: true } : {}) };
  } catch {
    addError(0, source.length, 'JSON 格式无效，请检查字符串转义和控制字符');
    return { valid: false, diagnostics, nodes };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (Array.isArray(before) && Array.isArray(after)) return before.length === after.length && before.every((value, index) => sameValue(value, after[index]));
  if (!isObject(before) || !isObject(after)) return false;
  const keys = Object.keys(before);
  return keys.length === Object.keys(after).length && keys.every(key => Object.hasOwn(after, key) && sameValue(before[key], after[key]));
}

/** Object key order and whitespace are ignored. Arrays are compared as whole values. */
export function diffParameterJson(before: string, after: string): ParameterJsonDiff {
  const previous = analyzeParameterJson(before);
  const next = analyzeParameterJson(after);
  if (!previous.valid || !next.valid) {
    const invalid = !previous.valid ? previous : next;
    const label = !previous.valid ? '对比分组' : '当前分组';
    return { valid: false, changes: [], error: `${label} JSON 无效：${invalid.diagnostics.find(diagnostic => diagnostic.severity === 'error')?.message ?? '请修复 JSON 后重试'}` };
  }
  const positions = new Map(next.nodes.map(node => [node.path, node]));
  const changes: ParameterJsonChange[] = [];
  const add = (segments: (string | number)[], kind: ParameterJsonChange['kind'], beforeValue: unknown, afterValue: unknown) => {
    const path = pointer(segments);
    const node = kind === 'removed' ? undefined : positions.get(path);
    changes.push({
      path, segments, kind,
      ...(kind === 'added' ? {} : { before: beforeValue }),
      ...(kind === 'removed' ? {} : { after: afterValue }),
      ...(node ? { from: node.from, to: node.to } : {}),
    });
  };
  const compare = (beforeValue: unknown, afterValue: unknown, segments: (string | number)[]) => {
    if (sameValue(beforeValue, afterValue)) return;
    if (isObject(beforeValue) && isObject(afterValue)) {
      for (const key of Object.keys(beforeValue)) {
        const path = [...segments, key];
        if (!Object.hasOwn(afterValue, key)) add(path, 'removed', beforeValue[key], undefined);
        else compare(beforeValue[key], afterValue[key], path);
      }
      for (const key of Object.keys(afterValue)) {
        if (!Object.hasOwn(beforeValue, key)) add([...segments, key], 'added', undefined, afterValue[key]);
      }
    } else add(segments, 'changed', beforeValue, afterValue);
  };
  compare(previous.value, next.value, []);
  return { valid: true, changes };
}
