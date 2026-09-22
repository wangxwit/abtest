import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory, redo as redoCommand, undo as undoCommand } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldAll as foldAllCommand, foldedRanges, foldGutter, foldKeymap, forceParsing, indentOnInput, indentUnit, syntaxHighlighting, unfoldAll as unfoldAllCommand, unfoldEffect } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { analyzeParameterJson } from '../json-parameter-analysis';
import './json-code-editor.css';

export type JsonCodeEditorDiagnostic = { from: number; to: number; message: string; severity: 'error' | 'warning' };
export type JsonCodeEditorHandle = {
  focusRange: (from: number, to?: number) => void;
  focus: () => void;
  search: () => void;
  foldAll: () => void;
  unfoldAll: () => void;
  format: () => void;
  undo: () => void;
  redo: () => void;
};
export type JsonCodeEditorProps = {
  documentId: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
  readOnly?: boolean;
  onCursor?: (position: { line: number; column: number }) => void;
  onFormatError?: (message: string) => void;
  diagnostics?: JsonCodeEditorDiagnostic[];
};

type ScrollSnapshot = ReturnType<EditorView['scrollSnapshot']>;
type SavedDocument = { state: EditorState; snapshot: ScrollSnapshot };
const externalChange = Annotation.define<boolean>();
const chinesePhrases = EditorState.phrases.of({
  Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全选匹配',
  'match case': '区分大小写', regexp: '正则表达式', 'by word': '全词匹配',
  replace: '替换', 'replace all': '全部替换', close: '关闭查找',
  'Fold line': '折叠此行', 'Unfold line': '展开此行', 'Unfold': '展开',
  'No diagnostics': '没有问题', 'Diagnostics': '配置问题',
  'replaced $ matches': '已替换 $ 处匹配', 'replaced match on line $': '已替换第 $ 行匹配',
  'current match': '当前匹配', 'on line': '位于行',
});

const editorTheme = EditorView.theme({
  '&': { height: '100%', color: '#263b33', backgroundColor: '#fff', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.7' },
  '.cm-content': { padding: '12px 0', caretColor: '#186a50', minHeight: '100%' },
  '.cm-line': { padding: '0 16px 0 8px' },
  '.cm-gutters': { color: '#8b9992', backgroundColor: '#f8faf9', borderRight: '1px solid #edf1ee' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 9px 0 12px', minWidth: '40px' },
  '.cm-activeLine': { backgroundColor: '#f1f7f3' },
  '.cm-activeLineGutter': { backgroundColor: '#eaf2ed', color: '#27674d' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#cfe7da' },
  '.cm-selectionMatch': { backgroundColor: '#e0eee6' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#186a50' },
  '.cm-foldPlaceholder': { backgroundColor: '#edf5f0', border: '1px solid #cee0d5', color: '#46745d', borderRadius: '4px', padding: '0 5px' },
  '.cm-matchingBracket': { backgroundColor: '#cbe7d7', outline: '1px solid #a6cbb5' },
  '.cm-panels': { backgroundColor: '#f7faf8', color: '#354b40' },
  '.cm-tooltip': { backgroundColor: '#fff', border: '1px solid #d9e5dd', borderRadius: '5px' },
  '.cm-searchMatch': { backgroundColor: '#fff0b8' },
  '.cm-searchMatch-selected': { backgroundColor: '#ffd589' },
});

/** Each group keeps its own CodeMirror document, history, selection, folds and scroll position. */
const JsonCodeEditor = forwardRef<JsonCodeEditorHandle, JsonCodeEditorProps>(function JsonCodeEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const documents = useRef(new Map<string, SavedDocument>());
  const activeId = useRef(props.documentId);
  const latest = useRef(props);
  latest.current = props;
  const attributes = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const restoreFrame = useRef<number | null>(null);
  const visiblePositions = useRef(new Map<string, ScrollSnapshot>());
  const pendingScroll = useRef<{ documentId: string; snapshot: ScrollSnapshot; token: number } | null>(null);
  const restoreToken = useRef(0), applyingToken = useRef<number | null>(null);
  const measureKey = useRef({});

  const isVisible = (view: EditorView) => view.scrollDOM.clientHeight > 0 && view.scrollDOM.clientWidth > 0;
  const cancelScrollRestore = () => {
    if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
    restoreFrame.current = null; pendingScroll.current = null; applyingToken.current = null;
  };
  const captureVisibleScroll = (view: EditorView) => {
    // display:none reports zero scroll coordinates. Keep the last visible position instead.
    if (isVisible(view) && !pendingScroll.current) visiblePositions.current.set(activeId.current, view.scrollSnapshot());
  };
  const scheduleScrollRestore = () => {
    const view = viewRef.current;
    if (!view || !pendingScroll.current || !isVisible(view) || restoreFrame.current !== null || applyingToken.current !== null) return;
    restoreFrame.current = requestAnimationFrame(() => {
      restoreFrame.current = null;
      const position = pendingScroll.current;
      if (!position || viewRef.current !== view || position.documentId !== activeId.current || !isVisible(view)) return;
      applyingToken.current = position.token;
      // A snapshot anchors a document position, not estimated pixel heights. CodeMirror
      // restores it after its virtual line-height map has settled, without scrolling parents.
      view.dispatch({ effects: position.snapshot });
      view.requestMeasure({
        key: measureKey.current,
        read: () => null,
        write: () => {
          if (pendingScroll.current?.token !== position.token || applyingToken.current !== position.token) return;
          restoreFrame.current = requestAnimationFrame(() => {
            restoreFrame.current = null;
            if (pendingScroll.current?.token !== position.token || viewRef.current !== view) return;
            applyingToken.current = null;
            if (!isVisible(view)) return;
            pendingScroll.current = null; captureVisibleScroll(view);
          });
        },
      });
    });
  };
  const restoreScroll = (documentId: string, snapshot: ScrollSnapshot) => {
    cancelScrollRestore();
    visiblePositions.current.set(documentId, snapshot);
    pendingScroll.current = { documentId, snapshot, token: ++restoreToken.current };
    scheduleScrollRestore();
  };
  const initialSnapshot = (view: EditorView) => {
    view.scrollDOM.scrollTop = 0; view.scrollDOM.scrollLeft = 0;
    return view.scrollSnapshot();
  };

  const contentAttributes = () => EditorView.contentAttributes.of({
    'aria-label': latest.current.label,
    'aria-multiline': 'true',
    'aria-readonly': latest.current.readOnly ? 'true' : 'false',
    role: 'textbox', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off',
  });
  const editingExtensions = () => [EditorState.readOnly.of(!!latest.current.readOnly), EditorView.editable.of(!latest.current.readOnly)];
  const reportCursor = (state: EditorState) => {
    const head = state.selection.main.head, line = state.doc.lineAt(head);
    latest.current.onCursor?.({ line: line.number, column: head - line.from + 1 });
  };
  const saveCurrent = () => {
    const view = viewRef.current;
    if (!view) return;
    captureVisibleScroll(view);
    const snapshot = visiblePositions.current.get(activeId.current) ?? initialSnapshot(view);
    documents.current.set(activeId.current, { state: view.state, snapshot });
  };
  const createState = (source: string) => EditorState.create({
    doc: source,
    extensions: [
      json(), history(), lineNumbers(), highlightActiveLineGutter(), foldGutter(), lintGutter(),
      drawSelection(), highlightActiveLine(), indentOnInput(), indentUnit.of('  '), bracketMatching(), closeBrackets(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }), search({ top: true }), highlightSelectionMatches(),
      // Tab remains browser focus navigation. Indentation is available through the normal Mod-[ / Mod-] commands.
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap]),
      editorTheme, chinesePhrases, attributes.current.of(contentAttributes()), editable.current.of(editingExtensions()),
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          const current = visiblePositions.current.get(activeId.current)?.map(update.changes);
          if (current) visiblePositions.current.set(activeId.current, current);
          const pending = pendingScroll.current;
          if (pending?.documentId === activeId.current) {
            const mapped = pending.snapshot.map(update.changes);
            if (mapped) pendingScroll.current = { ...pending, snapshot: mapped };
          }
        }
        if (update.transactions.some(transaction => ['select', 'input', 'undo', 'redo'].some(event => transaction.isUserEvent(event)))) {
          cancelScrollRestore();
        }
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) {
          latest.current.onChange(update.state.doc.toString());
        }
        if (update.docChanged || update.selectionSet) reportCursor(update.state);
      }),
    ],
  });

  useLayoutEffect(() => {
    if (!host.current) return;
    const cached = documents.current.get(latest.current.documentId);
    activeId.current = latest.current.documentId;
    const view = new EditorView({ state: cached?.state ?? createState(latest.current.value), parent: host.current });
    viewRef.current = view;
    restoreScroll(activeId.current, cached?.snapshot ?? initialSnapshot(view));
    const onScroll = () => captureVisibleScroll(view);
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    // Both the diff panel and the outer draft sections keep this editor mounted while hidden.
    // Defer restoration until the same editor has a layout box again.
    const observer = new ResizeObserver(() => {
      if (viewRef.current !== view) return;
      if (!isVisible(view)) {
        if (!pendingScroll.current) {
          const snapshot = visiblePositions.current.get(activeId.current);
          if (snapshot) restoreScroll(activeId.current, snapshot);
        }
      } else scheduleScrollRestore();
    });
    observer.observe(view.scrollDOM);
    reportCursor(view.state);
    return () => {
      saveCurrent(); cancelScrollRestore(); observer.disconnect(); view.scrollDOM.removeEventListener('scroll', onScroll);
      view.destroy(); viewRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (activeId.current !== props.documentId) {
      saveCurrent();
      const cached = documents.current.get(props.documentId);
      activeId.current = props.documentId;
      view.setState(cached?.state ?? createState(props.value));
      restoreScroll(props.documentId, cached?.snapshot ?? initialSnapshot(view));
      reportCursor(view.state);
    }
    if (view.state.doc.toString() !== props.value) {
      const selection = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.value },
        selection: EditorSelection.single(Math.min(selection.anchor, props.value.length), Math.min(selection.head, props.value.length)),
        annotations: [externalChange.of(true), isolateHistory.of('full')],
      });
    }
    view.dispatch({ effects: [attributes.current.reconfigure(contentAttributes()), editable.current.reconfigure(editingExtensions())] });
    const diagnostics = (props.diagnostics ?? []).map(diagnostic => {
      const from = Math.max(0, Math.min(diagnostic.from, view.state.doc.length));
      return { ...diagnostic, from, to: Math.max(from, Math.min(diagnostic.to, view.state.doc.length)) };
    });
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [props.documentId, props.value, props.label, props.readOnly, props.diagnostics]);

  useImperativeHandle(ref, () => ({
    focusRange(from, to = from) {
      const view = viewRef.current;
      if (!view) return;
      cancelScrollRestore();
      const start = Math.max(0, Math.min(from, view.state.doc.length));
      const end = Math.max(start, Math.min(to, view.state.doc.length));
      const effects = [];
      // Unfold every enclosing/intersecting range so a deep error is never selected inside a hidden region.
      const ranges = foldedRanges(view.state).iter();
      while (ranges.value) {
        if (ranges.from <= end && ranges.to >= start) effects.push(unfoldEffect.of({ from: ranges.from, to: ranges.to }));
        ranges.next();
      }
      view.dispatch({ selection: EditorSelection.single(start, end), effects: [...effects, EditorView.scrollIntoView(start, { y: 'center' })] });
      view.focus();
    },
    focus() { cancelScrollRestore(); viewRef.current?.focus(); },
    search() { const view = viewRef.current; if (view) { cancelScrollRestore(); openSearchPanel(view); } },
    foldAll() { const view = viewRef.current; if (view) { cancelScrollRestore(); forceParsing(view, view.state.doc.length, 150); foldAllCommand(view); } },
    unfoldAll() { const view = viewRef.current; if (view) { cancelScrollRestore(); unfoldAllCommand(view); } },
    format() {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return;
      const result = analyzeParameterJson(view.state.doc.toString());
      if (!result.valid || !result.value) {
        latest.current.onFormatError?.(result.diagnostics[0]?.message ?? '请先修正 JSON 配置，原文已保留。');
        return;
      }
      const formatted = JSON.stringify(result.value, null, 2);
      if (formatted !== view.state.doc.toString()) view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted },
        annotations: isolateHistory.of('full'), userEvent: 'input.format',
      });
      view.focus();
    },
    undo() { const view = viewRef.current; if (view && !view.state.readOnly) undoCommand(view); },
    redo() { const view = viewRef.current; if (view && !view.state.readOnly) redoCommand(view); },
  }), []);

  return <div ref={host} className="jce-host" />;
});

export default JsonCodeEditor;
