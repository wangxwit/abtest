import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { ArrowUpRight, CircleAlert, Crosshair, GitBranch, Info, Route, Users, X } from 'lucide-react';
import type { Experiment } from '../data';
import { getVariantId, getVariantLabel, getVariantRole } from '../experiment-variants';
import { formatPercent } from '../format-percent';
import { getTopology, simulateAllocation, subscribeTopology } from '../traffic';
import type { AllocationSimulation } from '../traffic';
import { BUCKET_COUNT, bucketCount, formatBucketRanges, getBucketRanges, type BucketRange } from '../bucket-ranges';
import type { AudienceProfile } from '../audiences';
import { getProfileAttributes, getProfileAttribute, isSafeProfileKey, profileValueIsValid } from '../profile-attributes';
import { explainTrafficFocus, type TrafficFocus } from '../traffic-validation';
import { ProfileInputs, parseProfileInputs, type ProfileInputDraft } from './AudienceRuleBuilder';
import './allocation-simulator.css';

type Props = {
  experiments: Experiment[];
  onOpen: (experiment: Experiment) => void;
  onSelect: (node: TrafficFocus) => void;
  onTrace: (ids: string[]) => void;
  focus: TrafficFocus | null;
  onClearFocus: () => void;
  active: boolean;
};
type DemoPreset = { domainId: string; label: string; unitId: string | null; allocation: AllocationSimulation | null; unavailableReason: string };
const percent = (value: number) => `${formatPercent(value)}%`;
const bucketIndex = (percentValue: number) => Math.round(percentValue * BUCKET_COUNT / 100);
function SimulationBucketRanges({ ranges, label }: { ranges: BucketRange[]; label: string }) {
  return <div className="as-trace-ranges"><span>{label} · {bucketCount(ranges).toLocaleString('zh-CN')} 桶 / {ranges.length} 段</span>{ranges.length > 3 ? <details><summary>查看全部桶段</summary><code>{formatBucketRanges(ranges)}</code></details> : <code>{ranges.length ? formatBucketRanges(ranges) : '无桶段'}</code>}</div>;
}
type ProfileDraft = ProfileInputDraft;
type ProfileSnapshot = { profile: AudienceProfile; createdAt: string };
const snapshotStorageKey = 'explab-simulation-profile-snapshots-v1';
const emptyProfileDraft = (): ProfileDraft => ({});
function profileDraft(profile: AudienceProfile): ProfileDraft {
  return Object.fromEntries(Object.entries(profile).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, String(value)]));
}
function parseProfile(draft: ProfileDraft): { profile: AudienceProfile; error?: string } {
  return parseProfileInputs(draft, getProfileAttributes(getTopology()));
}
function readProfileSnapshots(): { snapshots: Map<string, ProfileSnapshot>; error: string } {
  try {
    const rows = JSON.parse(localStorage.getItem(snapshotStorageKey) ?? '[]');
    if (!Array.isArray(rows)) throw new Error('format');
    const snapshots = new Map<string, ProfileSnapshot>();
    for (const row of rows) {
      if (!row || typeof row.unitId !== 'string' || !row.unitId.trim() || row.unitId !== row.unitId.trim() || row.unitId.length > 128 || snapshots.has(row.unitId) || !row.profile || typeof row.profile !== 'object' || Array.isArray(row.profile) || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) throw new Error('format');
      for (const [key, value] of Object.entries(row.profile)) {
        const attribute = isSafeProfileKey(key) ? getProfileAttribute(key, getTopology()) : undefined;
        if (!attribute || !profileValueIsValid(attribute, value) || (typeof value === 'string' && value !== value.trim())) throw new Error('profile');
      }
      snapshots.set(row.unitId, { profile: structuredClone(row.profile) as AudienceProfile, createdAt: row.createdAt });
    }
    return { snapshots, error: '' };
  } catch { return { snapshots: new Map(), error: '无法完整读取已保存的画像快照。为避免重置旧用户资格，本次已停止模拟，原存储保持不变。请先恢复有效快照或浏览器存储访问。' }; }
}

function findDemoUnits(experiments: Experiment[], topology: ReturnType<typeof getTopology>): DemoPreset[] {
  const targets = [{ domainId: 'card-depth', label: '孙域路径', preferred: 'user_219' }, { domainId: 'ui-isolation', label: '分支隔离', preferred: 'user_98' }, { domainId: 'exclusive', label: '全链路隔离', preferred: 'user_5' }];
  const cached = new Map<string, AllocationSimulation>();
  const evaluate = (unitId: string) => { let result = cached.get(unitId); if (!result) { result = simulateAllocation(unitId, experiments, topology); cached.set(unitId, result); } return result; };
  const presets: DemoPreset[] = targets.map(target => {
    const exists = topology.domains.some(domain => domain.id === target.domainId);
    const result = exists ? evaluate(target.preferred) : null;
    const valid = result && !result.error && result.enteredDomains.includes(target.domainId);
    return { domainId: target.domainId, label: target.label, unitId: valid ? target.preferred : null, allocation: valid ? result : null, unavailableReason: exists ? '当前配置未找到可用示例' : '该分支未配置' };
  });
  const missing = () => presets.filter(preset => !preset.allocation && topology.domains.some(domain => domain.id === preset.domainId));
  for (let index = 0; index < 2000 && missing().length > 0; index++) {
    const unitId = `user_${index}`;
    const result = evaluate(unitId);
    if (result.error) continue;
    for (const preset of missing()) if (result.enteredDomains.includes(preset.domainId)) { preset.unitId = unitId; preset.allocation = result; }
  }
  return presets;
}

export default function AllocationSimulator({ experiments, onOpen, onSelect, onTrace, focus, onClearFocus, active }: Props) {
  const topology = useSyncExternalStore(subscribeTopology, getTopology, getTopology);
  const [unitId, setUnitId] = useState('');
  const [draft, setDraft] = useState<ProfileDraft>(emptyProfileDraft);
  const [initialSnapshots] = useState(readProfileSnapshots);
  const [snapshots, setSnapshots] = useState<Map<string, ProfileSnapshot>>(initialSnapshots.snapshots);
  const [result, setResult] = useState<AllocationSimulation | null>(null);
  const [simulatedTopology, setSimulatedTopology] = useState<ReturnType<typeof getTopology> | null>(null);
  const [simulatedExperiments, setSimulatedExperiments] = useState(experiments);
  const [inputError, setInputError] = useState(initialSnapshots.error);
  const [presets, setPresets] = useState<DemoPreset[]>([]);
  const presetSource = useRef<{ topology: ReturnType<typeof getTopology>; experiments: Experiment[] } | null>(null);
  useEffect(() => {
    if (!active || (presetSource.current?.topology === topology && presetSource.current?.experiments === experiments)) return;
    setPresets(findDemoUnits(experiments, topology));
    presetSource.current = { topology, experiments };
  }, [active, experiments, topology]);

  const locked = snapshots.get(unitId.trim());
  const displayedDraft = locked ? profileDraft(locked.profile) : draft;
  const run = (value: string) => {
    const id = value.trim();
    if (!id || id.length > 128) { setInputError('请输入 1–128 位的 user_id。'); return; }
    const stored = readProfileSnapshots();
    if (stored.error) { setInputError(stored.error); return; }
    if ([...snapshots].some(([key, known]) => stored.snapshots.has(key) && JSON.stringify(profileDraft(stored.snapshots.get(key)!.profile)) !== JSON.stringify(profileDraft(known.profile)))) { setInputError('已保存画像与本页首次快照不一致，已停止模拟，不能覆盖同一 ID 的资格。'); return; }
    const latest = new Map([...stored.snapshots, ...snapshots]);
    let snapshot = latest.get(id);
    if (!snapshot) {
      const parsed = parseProfile(displayedDraft);
      if (parsed.error) { setInputError(parsed.error); return; }
      snapshot = { profile: parsed.profile, createdAt: new Date().toISOString() };
      latest.set(id, snapshot);
      try { localStorage.setItem(snapshotStorageKey, JSON.stringify([...latest].map(([unitId, row]) => ({ unitId, ...row })))); }
      catch { setInputError('无法保存首次画像，已停止本次模拟。请恢复浏览器存储后重试，避免刷新后丢失固定资格。'); return; }
    }
    setSnapshots(latest); setUnitId(id); setInputError('');
    const currentTopology = getTopology();
    const allocation = simulateAllocation(id, experiments, currentTopology, snapshot.profile);
    setResult(allocation); setSimulatedTopology(currentTopology); setSimulatedExperiments(experiments); onTrace(allocation.visitedNodeIds);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); run(unitId); };
  const executedCount = result?.decisions.filter(decision => decision.experimentId !== null).length ?? 0;
  const stale = Boolean(result && (unitId.trim() !== result.unitId || simulatedTopology !== topology || simulatedExperiments !== experiments));
  const focusResolution = focus && result && simulatedTopology ? explainTrafficFocus(focus, result, simulatedTopology) : null;
  const currentFocusNode = focus ? (focus.kind === 'domain' ? topology.domains : topology.layers).find(node => node.id === focus.id) : undefined;
  const audienceStatusLabels = { match: '受众匹配', 'not-match': '受众未匹配', unknown: '资格未知' };
  const traceExperiments = simulatedExperiments;

  return <section className="as-simulator" aria-label="递归分流模拟器">
    <header className="as-heading"><span><Route size={22}/></span><div><h2>分流验证</h2><p>从默认域开始，完整解释固定画像如何经过每个域、层与实验。</p></div><span className="as-local-badge">本地规则模拟</span></header>
    <div className="as-principle"><Info size={15}/><p>同一 user_id 固定使用首次画像。每层有 10,000 个固定桶，按配置的实际桶段判断准入与受众；未匹配或缺属性不会改投其他桶，其他并行参数层继续执行。</p></div>
    {focus && <section className={`as-focus ${stale ? 'is-stale' : focusResolution ? `is-${focusResolution.status}` : 'is-pending'}`} aria-label="当前关注的层域" aria-live="polite">
      <div className="as-focus-heading"><Crosshair size={17}/><div><span>当前关注 · {focus.kind === 'domain' ? '域' : '层'}</span><h3>{focusResolution?.nodeName || currentFocusNode?.name || focus.id}</h3></div><button type="button" className="as-clear-focus" onClick={onClearFocus}><X size={13}/>清除关注</button></div>
      {focusResolution ? <><strong className="as-focus-status">{stale ? '上次验证：' : ''}{focusResolution.title}</strong><p>{focusResolution.reason}</p>{stale && <p className="as-focus-stale-note">以上仅解释上次验证时的配置。输入或配置已有变化，请重新验证后判断当前路径。</p>}</> : <p>{currentFocusNode ? '模拟后将在完整路径中定位此节点，并解释是否到达。关注节点不会作为分流起点，也不会改变画像与桶位。' : '此关注节点已不在当前配置中；仍可从默认域执行完整验证，或清除关注。'}</p>}
      <div className="as-focus-actions"><button type="button" className="btn btn-small" onClick={() => onSelect(focus)}>返回{focus.kind === 'domain' ? '域' : '层'}配置<ArrowUpRight size={12}/></button>{focusResolution?.blocker && <button type="button" className="btn btn-small" onClick={() => onSelect(focusResolution.blocker!)}>查看阻断位置配置<ArrowUpRight size={12}/></button>}</div>
    </section>}
    <div className="as-workspace">
      <section className="card as-input-card"><div className="as-section-heading"><span>01</span><div><h3>模拟用户与画像</h3><p>先确定用户资格，再执行固定分桶。</p></div></div>
        <form className="as-form" onSubmit={submit} noValidate>
          <label htmlFor="traffic-simulation-user">随机化单元 · user_id</label><div className="as-user-input"><Users size={15}/><input id="traffic-simulation-user" value={unitId} maxLength={128} onChange={event => { setUnitId(event.target.value); setInputError(''); }} placeholder="输入一个模拟 user_id" autoComplete="off" aria-describedby={inputError ? 'traffic-simulation-error' : 'traffic-simulation-hint'}/></div>
          <div className={`as-profile-panel ${locked ? 'is-locked' : ''}`}><div className="as-profile-heading"><strong>入组前画像快照</strong><span>{locked ? '首次画像已固定' : '首次模拟时固定'}</span></div><p>{locked ? '该 ID 的首次画像只读，后续新增属性也不可补填。要验证另一种画像，请输入新的 user_id。' : '填写该用户进入实验前已确定的属性。留空表示缺少属性；这些值不会随模拟中的实验结果改变。'}</p><ProfileInputs attributes={getProfileAttributes(topology)} value={displayedDraft} onChange={value => { setDraft(value); setInputError(''); }} locked={Boolean(locked)} idPrefix="traffic-profile"/>{locked && <small>首次固定：{new Date(locked.createdAt).toLocaleString('zh-CN')}</small>}</div>
          {inputError && <p className="as-input-error" id="traffic-simulation-error" role="alert">{inputError}</p>}
          <button className="btn btn-primary as-run" type="submit"><Route size={14}/>{locked ? '使用固定画像模拟' : '固定画像并模拟'}</button>
          <div className="as-presets">{presets.map(preset => <button key={preset.domainId} type="button" disabled={!preset.unitId} title={preset.unitId ? '示例 ID 按未提供画像时的配置验证；实际路径由当前输入或该 ID 已固定画像决定' : preset.unavailableReason} onClick={() => { if (preset.unitId) run(preset.unitId); }}>{preset.label}<code>{preset.unitId ?? (preset.unavailableReason === '该分支未配置' ? '分支未配置' : '暂无可用示例')}</code></button>)}</div>
          <small className="as-hint" id="traffic-simulation-hint">本地规则模拟，不读取真实身份。示例 ID 也遵循首次画像固定规则；刷新后可继续使用已保存快照。</small>
        </form>
      </section>
      <section className={`card as-result-card ${stale ? 'is-stale' : ''}`} aria-label="完整分流验证结果" aria-live={active ? 'polite' : 'off'}>
        <div className="as-section-heading"><span>02</span><div><h3>{stale ? '上次验证结果' : '完整分配路径'}</h3><p>保留全部分支，包含每个并行层的处理结果。</p></div></div>
        {!result ? <div className="as-empty"><GitBranch size={34}/><strong>输入画像，查看完整分配路径</strong><p>结果会展示每次匹配、未匹配或缺属性的原因，以及兄弟参数层独立执行的结果。</p></div> : <>
          {stale && <div className="as-stale-alert" role="alert"><CircleAlert size={17}/><div><strong>输入或配置已更改，请重新验证</strong><p>以下保留上次结果供查看，不能据此判断当前配置。固定画像和已输入内容保持保留。</p></div><button type="button" onClick={() => run(unitId)}>重新模拟</button></div>}
          <div className="as-result-label"><span>{stale ? '上次模拟' : '本次模拟'} · {result.error ? '配置检查未通过' : `执行 ${executedCount} 个实验 · 经过 ${result.enteredDomains.length} 个域`}</span><code title={result.unitId}>{result.unitId}</code></div>
          {result.error ? <div className="as-engine-error" role="alert"><CircleAlert size={17}/><div><strong>配置检查未通过</strong><p>{result.error}</p><small>本次未形成可用的参数合并结果。修复配置后请重新验证。</small></div></div> : <>
            <div className="as-trace">{result.trace.map((step, index) => {
              const target: TrafficFocus | null = step.kind === 'domain' || step.kind === 'layer' ? { kind: step.kind, id: step.id } : null;
              const experiment = step.kind === 'experiment' ? traceExperiments.find(item => item.id === step.id) : undefined;
              const decision = experiment ? result.decisions.find(item => item.experimentId === experiment.id && item.layerId === step.layerId) : undefined;
              const selectedId = step.variantId ?? decision?.variantId;
              const variantMatches = experiment?.variants.map((variant, variantIndex) => ({ variant, variantIndex })).filter(({ variant, variantIndex }) => selectedId ? getVariantId(variant, variantIndex) === selectedId : variant.name === decision?.variant) ?? [];
              const selectedVariant = variantMatches.length === 1 ? variantMatches[0] : null;
              const focused = Boolean(focus && step.kind === focus.kind && step.id === focus.id);
              const allocation = step.kind === 'domain' ? simulatedTopology?.domains.find(domain => domain.id === step.id) : experiment;
              const ranges = allocation ? getBucketRanges(allocation) : null;
              return <div className={`as-trace-step ${step.kind} ${focused ? 'is-focused' : ''}`} key={`${index}-${step.kind}-${step.id}`} data-traffic-focus={focused || undefined} style={{ paddingLeft: `${Math.min(step.depth, 12) * 10}px` }}><div className="as-trace-content"><div className="as-trace-title"><span className="as-trace-kind">{step.kind === 'domain' ? '域' : step.kind === 'layer' ? '层' : step.kind === 'experiment' ? '实验' : '默认'}</span>{target ? <button type="button" onClick={() => onSelect(target)}>{step.name}<ArrowUpRight size={12}/></button> : experiment ? <button type="button" onClick={() => onOpen(experiment)}>{selectedVariant ? experiment.name : step.name}<ArrowUpRight size={12}/></button> : <strong>{step.name}</strong>}{focused && <span className="as-focused-label"><Crosshair size={10}/>关注</span>}{step.audienceStatus && <span className={`as-audience-status ${step.audienceStatus}`}>{audienceStatusLabels[step.audienceStatus]}</span>}<span className="as-trace-bucket">{step.bucket !== undefined ? `${step.kind === 'experiment' ? '版本桶' : '本层桶'} ${bucketIndex(step.bucket)} / ${BUCKET_COUNT}` : step.globalTraffic !== undefined ? `全局 ${percent(step.globalTraffic)}` : ''}</span></div><p>{step.reason}</p>{selectedVariant && <div className="as-selected-group" aria-label="最终实验分组"><span className={`as-group-role ${getVariantRole(selectedVariant.variant, selectedVariant.variantIndex)}`}>{getVariantLabel(selectedVariant.variant, selectedVariant.variantIndex)}</span><strong>{selectedVariant.variant.name}</strong><code>{getVariantId(selectedVariant.variant, selectedVariant.variantIndex)}</code><span>{percent(selectedVariant.variant.weight)} 组内权重</span></div>}{ranges && <SimulationBucketRanges ranges={ranges} label={step.kind === 'domain' ? step.id === 'root' ? '默认域入口桶段' : '父层准入桶段' : '层内实验桶段'} />}</div></div>;
            })}</div>
            <details className="as-merged"><summary>查看合并后的参数覆盖 <span>{Object.keys(result.mergedParameters).length} 项</span></summary><pre><code>{JSON.stringify(result.mergedParameters, null, 2)}</code></pre><p>只合并运行中且实际执行的实验参数；未列出的参数沿用默认值。父作用域之外的参数不会被子域覆盖。</p></details>
          </>}
        </>}
      </section>
    </div>
    <p className="as-foot"><Info size={14}/>暂停、待审保留桶坐标。同桶候选通过固定画像判断资格；无合格项时使用默认值，不转投其他桶。非重叠子域不停止祖先的其他并行参数层。</p>
  </section>;
}
