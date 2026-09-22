import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Code2, Download, FileDiff, ListTree, Maximize2, Minimize2, Search, Undo2, Redo2, CircleAlert, ArrowUpRight } from 'lucide-react';
import type { DraftExperimentVariant } from '../variant-draft-operations';
import { analyzeParameterJson, diffParameterJson } from '../json-parameter-analysis';
import { getTopology, getParameterDefinition } from '../traffic';
import { getParameterService, getParameterTags, getServiceTags } from '../service-catalog';
import type { ExperimentGroupFocusTarget } from './ExperimentGroupsEditor';
import type { JsonCodeEditorHandle } from './JsonCodeEditor';
import './json-parameter-workbench.css';
const JsonCodeEditor = lazy(() => import('./JsonCodeEditor'));
type Props = { variants: DraftExperimentVariant[]; selectedVariantId: string; onSelect: (id: string) => void; onChange: (value: string) => void; focusTarget?: ExperimentGroupFocusTarget; error?: string; saveState?: 'saved' | 'dirty' | 'error'; saveError?: string };
const valueText = (value: unknown) => value === undefined ? '（不存在）' : JSON.stringify(value, null, 2);
const locationOf = (source: string, offset: number) => { const lines = source.slice(0, offset).split('\n'); return { line: lines.length, column: lines.at(-1)!.length + 1 }; };
export default function JsonParameterWorkbench({ variants, selectedVariantId, onSelect, onChange, focusTarget, error, saveState, saveError }: Props) {
  const instanceId = useId();
  const selected = variants.find(v => v.id === selectedVariantId) ?? variants[0];
  const [mode, setMode] = useState<'source' | 'diff'>('source'), [focused, setFocused] = useState(false), [outlineOpen, setOutlineOpen] = useState(true);
  const [query, setQuery] = useState(''), [serviceId, setServiceId] = useState(''), [tagId, setTagId] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set()), [outlineLimit, setOutlineLimit] = useState(100), [diffLimit, setDiffLimit] = useState(50);
  const [activePaths, setActivePaths] = useState<Record<string, string>>({}), [referenceId, setReferenceId] = useState(''), [message, setMessage] = useState('');
  const [cursor, setCursor] = useState({ line: 1, column: 1 }), [showProblems, setShowProblems] = useState(false);
  const [editor, setEditor] = useState<JsonCodeEditorHandle | null>(null);
  const [navigation, setNavigation] = useState<{ from: number; to: number; nonce: number; documentId: string } | null>(null);
  const root = useRef<HTMLDivElement>(null), expandButton = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null), lastTarget = useRef('');
  const analysis = useMemo(() => analyzeParameterJson(selected.value), [selected.value]);
  const topology = getTopology();
  const keys = analysis.value ? Object.keys(analysis.value) : [...new Set(analysis.nodes.filter(node => node.depth === 0).map(node => node.topLevelKey))];
  const services = [...new Map(keys.map(key => getParameterService(key, topology)).filter(s => s !== undefined).map(s => [s.id, s])).values()];
  const tags = serviceId ? getServiceTags(serviceId, topology) : [];
  const reference = variants.find(v => v.id === referenceId && v.id !== selected.id) ?? variants.find(v => v.role === 'control' && v.id !== selected.id) ?? variants.find(v => v.id !== selected.id);
  const difference = useMemo(() => mode === 'diff' && reference ? diffParameterJson(reference.value, selected.value) : null, [mode, reference?.value, selected.value]);
  const filteredNodes = useMemo(() => {
    const matches = analysis.nodes.filter(node => {
      if (serviceId && getParameterService(node.topLevelKey, topology)?.id !== serviceId) return false;
      if (tagId && !getParameterTags(node.topLevelKey, topology).some(tag => tag.id === tagId && tag.serviceId === serviceId)) return false;
      if (query.trim()) return `${node.path} ${node.key} ${node.preview} ${getParameterDefinition(node.topLevelKey, topology)?.name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
      return node.depth === 0 || node.segments.slice(0, -1).every((_, index) => expanded.has('/' + node.segments.slice(0, index + 1).map(segment => String(segment).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')));
    });
    return matches;
  }, [analysis.nodes, query, serviceId, tagId, expanded, topology]);
  const activePath = activePaths[selected.id] ?? '';
  const activeNode = analysis.nodes.find(node => node.path === activePath);
  const navigate = (from: number, to = from, path = '') => { setMode('source'); setActivePaths(previous => ({ ...previous, [selected.id]: path })); setNavigation({ from, to, nonce: performance.now(), documentId: selected.id }); };
  useEffect(() => { if (navigation && navigation.documentId !== selected.id) { setNavigation(null); return; } if (!navigation || !editor || mode !== 'source') return; const frame = requestAnimationFrame(() => { editor.focusRange(navigation.from, navigation.to); setNavigation(null); }); return () => cancelAnimationFrame(frame); }, [navigation, editor, mode, selected.id]);
  useEffect(() => {
    if (!focusTarget || focusTarget.variantId !== selected.id || ['variant-name', 'variant-weight', 'variant-role', 'name', 'weight', 'role'].includes(focusTarget.field ?? '')) return;
    const token = JSON.stringify(focusTarget); if (lastTarget.current === token) return; lastTarget.current = token;
    if (focusTarget.parameterKey) {
      const node = analysis.nodes.find(node => node.depth === 0 && node.topLevelKey === focusTarget.parameterKey);
      if (node) { const problem = analysis.diagnostics.find(item => item.severity === 'error' && item.from >= node.from && item.from <= node.to); navigate(problem?.from ?? node.from, problem?.to ?? node.from, node.path); if (problem) setShowProblems(true); setMessage(`已定位参数 ${focusTarget.parameterKey}${problem ? ' 中的 JSON 问题' : ''}`); }
      else { navigate(0); setMessage(`当前组缺少顶层参数 ${focusTarget.parameterKey}，请补充或修正源码。`); }
    } else { const problem = analysis.diagnostics[0]; navigate(problem?.from ?? 0, problem?.to); }
  }, [focusTarget, selected.id, analysis.nodes, analysis.diagnostics]);
  useEffect(() => { setOutlineLimit(100); }, [query, serviceId, tagId]);
  useEffect(() => { setDiffLimit(50); }, [reference?.id, selected.id]);
  useEffect(() => {
    if (!focused || !root.current) return;
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow;
    const siblings = new Map<HTMLElement, boolean>();
    const parents: HTMLElement[] = [];
    let node: HTMLElement | null = root.current;
    while (node?.parentElement) { parents.push(node.parentElement); node = node.parentElement; if (node === document.body) break; }
    const makeSiblingsInert = () => {
      let child: HTMLElement | null = root.current;
      for (const parent of parents) { for (const sibling of parent.children) if (sibling !== child && sibling instanceof HTMLElement) { if (!siblings.has(sibling)) siblings.set(sibling, sibling.inert); sibling.inert = true; } child = parent; }
    };
    makeSiblingsInert();
    const observer = new MutationObserver(makeSiblingsInert);
    for (const parent of parents) observer.observe(parent, { childList: true });
    document.body.style.overflow = 'hidden'; closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); setFocused(false); }
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const controls = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,input,textarea,[contenteditable=true],[tabindex="0"]') ?? [])].filter(el => el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[hidden]'));
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { observer.disconnect(); for (const [sibling, wasInert] of siblings) sibling.inert = wasInert; document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [focused]);
  const download = () => { const url = URL.createObjectURL(new Blob([selected.value], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `${selected.name || selected.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage('已导出当前组源码原文。'); };
  return <div className={`jp-workbench ${focused ? 'is-focused' : ''}`} ref={root} role={focused ? 'dialog' : 'region'} aria-modal={focused || undefined} aria-label="实验参数 JSON 工作台" data-parameter-focus={focused || undefined}>
    <div className="jp-workbench-header"><div><span className="jp-overline">PARAMETER EDITOR</span><h3>参数编辑 <span>{selected.name || '未命名分组'}</span></h3></div><div className="jp-header-actions">{focused && <label className="jp-group-switch">编辑分组<select aria-label="专注编辑分组" value={selected.id} onChange={event => { onSelect(event.target.value); setMessage(''); }}>{variants.map(v => <option key={v.id} value={v.id}>{v.name || '未命名组'} · {v.role === 'control' ? '对照组' : '实验组'} · {v.weight}%</option>)}</select></label>}<button ref={focused ? closeButton : expandButton} className="btn btn-small" onClick={() => setFocused(!focused)}>{focused ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{focused ? '退出专注' : '专注编辑'}</button></div></div>
    <div className="jp-modebar"><div className="jp-modes" role="tablist" aria-label="参数查看模式" onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'source' : event.key === 'End' ? 'diff' : mode === 'source' ? 'diff' : 'source'; setMode(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus(); }}><button type="button" role="tab" id={`${instanceId}-source-tab`} data-mode="source" tabIndex={mode === 'source' ? 0 : -1} aria-controls={`${instanceId}-source`} aria-selected={mode === 'source'} onClick={() => setMode('source')}><Code2 size={14} />源码编辑</button><button type="button" role="tab" id={`${instanceId}-diff-tab`} data-mode="diff" tabIndex={mode === 'diff' ? 0 : -1} aria-controls={`${instanceId}-diff`} aria-selected={mode === 'diff'} onClick={() => setMode('diff')}><FileDiff size={14} />分组差异</button></div><span className={`jp-save-status ${saveState ?? ''}`}>{saveState === 'error' ? '草稿尚未保存' : saveState === 'dirty' ? '正在保存…' : saveState === 'saved' ? '草稿已保存到本机' : '修改随草稿保存'}</span></div>
    {saveError && <div className="jp-save-error" role="alert"><CircleAlert size={15} /><span>{saveError}</span>{focused && <button onClick={() => setFocused(false)}>返回工作区处理</button>}</div>}
    <div className="jp-source" id={`${instanceId}-source`} role="tabpanel" aria-labelledby={`${instanceId}-source-tab`} hidden={mode !== 'source'}>
      <div className="jp-editor-toolbar"><button aria-pressed={outlineOpen} onClick={() => setOutlineOpen(!outlineOpen)}><ListTree size={14} />参数目录</button><i /><button onClick={() => editor?.search()} disabled={!editor}><Search size={14} />搜索 / 替换</button><button onClick={() => editor?.format()} disabled={!editor}>格式化</button><button onClick={() => editor?.foldAll()} disabled={!editor}><ChevronsDownUp size={14} />折叠</button><button onClick={() => editor?.unfoldAll()} disabled={!editor}><ChevronsUpDown size={14} />展开</button><div className="jp-toolbar-spacer"/><button aria-label="撤销 JSON 修改" title="撤销 · ⌘/Ctrl Z" onClick={() => editor?.undo()} disabled={!editor}><Undo2 size={15} /></button><button aria-label="重做 JSON 修改" title="重做 · ⌘/Ctrl Shift Z" onClick={() => editor?.redo()} disabled={!editor}><Redo2 size={15} /></button><button aria-label="导出当前组 JSON" title="导出当前组源码原文" onClick={download}><Download size={15} /></button></div>
      <div className={`jp-edit-layout ${outlineOpen ? '' : 'without-outline'}`}>
        {outlineOpen && <aside className="jp-outline" aria-label="JSON 参数目录"><label className="jp-outline-search"><Search size={14}/><input aria-label="搜索参数路径或值" placeholder="搜索字段、路径或值" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="jp-outline-filters"><select aria-label="参数目录应用筛选" value={serviceId} onChange={event => { setServiceId(event.target.value); setTagId(''); }}><option value="">全部应用</option>{services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}{serviceId && !services.some(s => s.id === serviceId) && <option value={serviceId}>当前组无此应用参数</option>}</select>{serviceId && tags.length > 0 && <select aria-label="参数目录应用标签筛选" value={tagId} onChange={event => setTagId(event.target.value)}><option value="">全部标签</option>{tags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select>}</div><div className="jp-outline-meta"><span>{query.trim() ? `${filteredNodes.length} 个匹配字段` : `${keys.length} 个顶层参数`}</span><button onClick={() => setExpanded(new Set())}>收起目录</button></div><div className="jp-outline-list">{filteredNodes.slice(0, outlineLimit).map(node => <div key={`${node.path}:${node.from}`} className={`jp-outline-item ${activePath === node.path ? 'active' : ''}`} style={{ paddingLeft: query ? 0 : Math.min(node.depth, 5) * 12 }}><button className="jp-tree-toggle" disabled={!['object', 'array'].includes(node.type)} aria-label={`${expanded.has(node.path) ? '收起' : '展开'}字段 ${node.path}`} aria-expanded={['object', 'array'].includes(node.type) ? expanded.has(node.path) : undefined} onClick={() => setExpanded(previous => { const next = new Set(previous); next.has(node.path) ? next.delete(node.path) : next.add(node.path); return next; })}>{['object', 'array'].includes(node.type) ? expanded.has(node.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="jp-leaf-dot"/>}</button><button className="jp-outline-link" aria-label={`定位参数 ${node.path}，第 ${node.line} 行`} title={`${node.path}\n${node.preview}`} onClick={() => navigate(node.from, node.from, node.path)}><span><code>{node.key}</code><small>{node.type === 'object' ? '{}' : node.type === 'array' ? '[]' : node.type === 'number' ? '#' : node.type === 'boolean' ? 'T/F' : 'Aa'}</small></span>{query.trim() && <small>{node.path}</small>}</button></div>)}{!filteredNodes.length && <p className="jp-empty-outline">{analysis.nodes.length ? '没有匹配字段，调整搜索或筛选。' : '粘贴或输入 JSON 后，参数目录会显示在这里。'}</p>}{filteredNodes.length > outlineLimit && <button className="jp-more" onClick={() => setOutlineLimit(v => v + 100)}>继续显示 {Math.min(100, filteredNodes.length - outlineLimit)} 个字段</button>}{analysis.truncated && <p className="jp-empty-outline">目录仅显示前 5,000 个节点，完整内容仍可在源码中搜索。</p>}</div></aside>}
        <div className="jp-code-column"><div className="jp-path"><Code2 size={12}/><code title={activeNode?.path}>{activeNode?.path ?? '完整 JSON'}</code>{activeNode && <span>{getParameterService(activeNode.topLevelKey, topology)?.name ?? '待归属应用'}</span>}</div><div className="jp-code-pane"><Suspense fallback={<textarea className="jp-loading-editor" aria-label={`${selected.name} 参数 JSON（编辑器加载中）`} value={selected.value} onChange={event => onChange(event.target.value)} spellCheck={false}/>}><JsonCodeEditor ref={setEditor} documentId={selected.id} value={selected.value} onChange={value => { setMessage(''); onChange(value); }} label={`${selected.name || '未命名分组'} 参数 JSON`} diagnostics={analysis.diagnostics} onCursor={setCursor} onFormatError={setMessage} /></Suspense></div></div>
      </div>
      {showProblems && analysis.diagnostics.length > 0 && <div className="jp-problems" aria-label="JSON 问题列表">{analysis.diagnostics.map((problem, index) => { const at = locationOf(selected.value, problem.from); return <button key={`${problem.from}-${index}`} onClick={() => navigate(problem.from, problem.to)}><CircleAlert size={13}/><strong>第 {at.line} 行，第 {at.column} 列</strong><span>{problem.message}</span><ArrowUpRight size={13}/></button>; })}</div>}
      <div className="jp-statusbar"><button className={analysis.valid ? 'valid' : 'invalid'} onClick={() => { if (!analysis.valid) setShowProblems(!showProblems); }} aria-expanded={!analysis.valid ? showProblems : undefined}>{analysis.valid ? <Check size={13} /> : <CircleAlert size={13} />}{analysis.valid ? 'JSON 有效' : `${analysis.diagnostics.length} 个 JSON 问题`}</button><span>第 {cursor.line} 行，第 {cursor.column} 列</span><span>{selected.value.split('\n').length} 行 · {keys.length} 个参数</span></div>
      {error && <p className="jp-business-error" role="alert">{error}</p>}
    </div>
    <div className="jp-diff" id={`${instanceId}-diff`} role="tabpanel" aria-labelledby={`${instanceId}-diff-tab`} hidden={mode !== 'diff'}><div className="jp-diff-toolbar"><label>比较基准<select aria-label="选择差异比较分组" value={reference?.id ?? ''} onChange={event => setReferenceId(event.target.value)}>{variants.filter(v => v.id !== selected.id).map(v => <option key={v.id} value={v.id}>{v.name} · {v.role === 'control' ? '对照组' : '实验组'}</option>)}</select></label><ArrowUpRight size={16}/><div><small>当前分组</small><strong>{selected.name}</strong></div><span>{difference?.valid ? `${difference.changes.length} 处变化` : '待修正 JSON'}</span></div><p className="jp-diff-caption">只比较参数值，忽略缩进和对象字段顺序。数组按整体比较，重排也会标记为修改；此处不修改任何分组。</p><div className="jp-diff-list">{difference && !difference.valid ? <div className="jp-diff-empty"><CircleAlert size={27}/><h4>暂时无法比较</h4><p>{difference.error ?? '请先修正两组 JSON。'}</p><button className="btn" onClick={() => setMode('source')}>返回源码编辑</button></div> : difference?.changes.length === 0 ? <div className="jp-diff-empty"><Check size={28}/><h4>两组参数值相同</h4><p>格式或字段顺序变化不计入配置差异。</p></div> : difference?.changes.slice(0, diffLimit).map(change => <article className={`jp-change ${change.kind}`} key={change.path}><header><span>{change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '修改'}</span><code>{change.path || '/'}</code>{change.from !== undefined && <button onClick={() => navigate(change.from!, change.from!, change.path)}>定位源码<ArrowUpRight size={13}/></button>}</header><div className="jp-change-values"><div><span>{reference?.name} · 修改前</span><pre>{valueText(change.before)}</pre></div><div><span>{selected.name} · 修改后</span><pre>{valueText(change.after)}</pre></div></div></article>)}{difference?.valid && difference.changes.length > diffLimit && <button className="jp-more" onClick={() => setDiffLimit(v => v + 50)}>继续显示变化（剩余 {difference.changes.length - diffLimit} 处）</button>}</div></div>
    {message && <div className="jp-message" role="status">{message}<button aria-label="关闭编辑提示" onClick={() => setMessage('')}>×</button></div>}
  </div>;
}
