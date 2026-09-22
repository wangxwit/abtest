import { newExperimentHref } from '../experiment-draft-routes';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronDown, ChevronRight, CircleAlert, Code2, Expand, FlaskConical, GitBranch, Info, Layers3, Plus, Route, Users } from 'lucide-react';
import { statusLabels, typeLabels } from '../data';
import type { Experiment } from '../data';
import { formatPercent } from '../format-percent';
import { childDomains, domainGlobalTraffic, domainScope, domains, getTopology, globalTraffic, layerCreationBlock, layers, layerScope, maxConcurrent, nodePath, reserveStatuses, validateAllocation } from '../traffic';
import type { TrafficDomain, TrafficLayer } from '../traffic';
import { BUCKET_COUNT, bucketCount, formatBucketRanges, getBucketRanges, unionBucketRanges, type BucketRange } from '../bucket-ranges';
import NestedDomainEditor from './NestedDomainEditor';
import CreateLayer from './CreateLayer';
import ApplicationParameterBrowser from './ApplicationParameterBrowser';
import { audienceSummary, describeExpression, getAudienceExpression, domainEffectiveAudience, experimentEffectiveAudience, getAudience } from '../audiences';
import TrafficEstimate from './TrafficEstimate';
import { parseAudienceReferenceContext, parseTrafficDestination, resolveAudienceReference } from '../audience-reference-routes';
import AudienceReferenceContext, { useAudienceReferenceHash } from './AudienceReferenceContext';
import AllocationSimulator from './AllocationSimulator';
import ResourceManagementPanel from './ResourceManagementPanel';
import { parseTrafficValidationRoute, trafficValidationHref, type TrafficFocus } from '../traffic-validation';
import './traffic-domains.css';
import './traffic-management-tabs.css';

type Props = { experiments: Experiment[]; onOpen: (experiment: Experiment) => void };
type Selection = TrafficFocus;
const configurationHref = (node: Selection) => `#traffic/${node.kind}/${encodeURIComponent(node.id)}`;
function readTrafficSelection(): Selection {
  const validation = parseTrafficValidationRoute(location.hash);
  if (validation.isValidation) return validation.focus ?? { kind: 'layer', id: 'presentation' };
  const route = parseTrafficDestination(location.hash);
  if (route.kind && route.id) return { kind: route.kind, id: route.id };
  return route.error ? { kind: 'domain', id: '' } : { kind: 'layer', id: 'presentation' };
}
type TreeProps = { selected: Selection; expanded: Set<string>; traced: Set<string>; onSelect: (node: Selection) => void; onToggle: (key: string) => void };
const paperUrl = 'https://research.google.com/pubs/archive/36500.pdf#page=4';
const percent = (value: number) => `${formatPercent(value)}%`;
const keyOf = (node: Selection) => `${node.kind}:${node.id}`;
const modeLabel = (domain: TrafficDomain) => domain.mode === 'overlapping' ? '重叠域' : '非重叠域';
const allNodeKeys = () => [...domains.map(domain => `domain:${domain.id}`), ...layers.map(layer => `layer:${layer.id}`)];
const shareFormula = (domainId: string) => nodePath('domain', domainId).filter(node => node.kind === 'domain').map(node => percent(domains.find(domain => domain.id === node.id)?.traffic ?? 100)).join(' × ');
const bucketNumber = (value: number) => value.toLocaleString('zh-CN');
function BucketRangeSummary({ ranges }: { ranges: BucketRange[] }) {
  if (!ranges.length) return <div className="nt-range-summary"><span>无桶段</span></div>;
  return <div className="nt-range-summary"><span>{bucketNumber(bucketCount(ranges))} 桶 · {ranges.length} 段</span>{ranges.length > 3 ? <details><summary>查看全部 {ranges.length} 个桶段</summary><code>{formatBucketRanges(ranges)}</code></details> : <code>{formatBucketRanges(ranges)}</code>}</div>;
}
function DomainTree({ domain, depth, ...props }: TreeProps & { domain: TrafficDomain; depth: number }) {
  const node: Selection = { kind: 'domain', id: domain.id };
  const descendants = layers.filter(layer => layer.domainId === domain.id);
  const open = props.expanded.has(keyOf(node));
  return <li className="nt-tree-node">
    <div className={`nt-tree-row ${keyOf(props.selected) === keyOf(node) ? 'is-selected' : ''} ${props.traced.has(domain.id) ? 'is-traced' : ''}`}>
      <button className="nt-tree-toggle" aria-label={`${open ? '折叠' : '展开'}${domain.name}`} aria-expanded={open} onClick={() => props.onToggle(keyOf(node))}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
      <button className="nt-tree-select" aria-current={keyOf(props.selected) === keyOf(node) ? 'true' : undefined} onClick={() => props.onSelect(node)} title={`${domain.name} · 全局 ${percent(domainGlobalTraffic(domain.id))}`}><GitBranch size={13} /><span className="nt-tree-label">{domain.name}</span><span className="nt-tree-kind">域</span><span className="nt-tree-percent">{percent(domainGlobalTraffic(domain.id))}</span></button>
    </div>
    {open && depth < 40 && <ul className="nt-tree-children">{descendants.map(layer => <LayerTree key={layer.id} layer={layer} depth={depth + 1} {...props} />)}</ul>}
  </li>;
}

function LayerTree({ layer, depth, ...props }: TreeProps & { layer: TrafficLayer; depth: number }) {
  const node: Selection = { kind: 'layer', id: layer.id };
  const descendants = childDomains(layer.id);
  const pending = layer.role !== 'routing' && layerScope(layer.id).length === 0;
  const open = props.expanded.has(keyOf(node));
  return <li className="nt-tree-node">
    <div className={`nt-tree-row ${keyOf(props.selected) === keyOf(node) ? 'is-selected' : ''} ${props.traced.has(layer.id) ? 'is-traced' : ''}`}>
      {descendants.length ? <button className="nt-tree-toggle" aria-label={`${open ? '折叠' : '展开'}${layer.name}`} aria-expanded={open} onClick={() => props.onToggle(keyOf(node))}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="nt-tree-toggle" />}
      <button className="nt-tree-select" aria-current={keyOf(props.selected) === keyOf(node) ? 'true' : undefined} onClick={() => props.onSelect(node)} title={`${layer.name} · ${pending ? '待配置，请先分配参数' : `${layerScope(layer.id).length} 个继承参数`}`}><Layers3 size={13} /><span className="nt-tree-label">{layer.name}</span><span className={`nt-tree-kind ${pending ? 'nt-layer-pending' : ''}`}>{pending ? '待配置' : '层'}</span></button>
    </div>
    {open && depth < 40 && descendants.length > 0 && <ul className="nt-tree-children">{descendants.map(domain => <DomainTree key={domain.id} domain={domain} depth={depth + 1} {...props} />)}</ul>}
  </li>;
}

function DomainDetails({ domain, experiments, onSelect, onCreateLayer, onValidate, referenceHash }: { domain: TrafficDomain; experiments: Experiment[]; referenceHash: string; onValidate: (node: Selection) => void; onSelect: (node: Selection) => void; onCreateLayer: (domainId: string) => void }) {
  const ownLayers = layers.filter(layer => layer.domainId === domain.id);
  const referenceResolution = resolveAudienceReference('domain', domain.id, parseAudienceReferenceContext(referenceHash), getTopology(), []);
  const parameters = domainScope(domain.id);
  const parent = layers.find(layer => layer.id === domain.parentLayerId);
  const creationBlock = layerCreationBlock(domain.id);
  const ownAudience = domain.audienceId ? getAudience(domain.audienceId, getTopology()) : undefined;
  const effectiveAudience = audienceSummary(domainEffectiveAudience(domain.id, getTopology()));
  return <>
    <section className="card nt-detail-hero"><div className="nt-detail-hero-header"><div><span className="td-overline">DOMAIN · {domain.id}</span><h2>{domain.name}</h2></div><div className="nt-domain-actions"><span className="td-pill"><GitBranch size={12} />{modeLabel(domain)}</span><button className="btn btn-small nt-validate-btn" onClick={() => onValidate({ kind: 'domain', id: domain.id })}><Route size={13} />验证分流</button><button className="btn btn-primary btn-small nt-create-btn" disabled={Boolean(creationBlock)} aria-describedby={creationBlock ? 'layer-creation-block' : undefined} onClick={() => onCreateLayer(domain.id)}><Plus size={14} />新建层</button></div></div><p>{domain.description}</p>
      {creationBlock && <div className="nt-create-layer-block" id="layer-creation-block"><Info size={14} /><span>{creationBlock}</span></div>}
      <div className="nt-detail-stats"><div><span>全局名义流量</span><strong>{percent(domainGlobalTraffic(domain.id))}</strong><small>{shareFormula(domain.id)}</small></div><div><span>{parent ? '占父层流量' : '全量入口'}</span><strong>{percent(domain.traffic)}</strong><small>{parent ? `${parent.name} · 父层共 ${bucketNumber(BUCKET_COUNT)} 桶` : '默认域包含完整用户流量'}</small><BucketRangeSummary ranges={getBucketRanges(domain)} /></div><div><span>此域子树最多并行</span><strong>{maxConcurrent(domain.id)}<small> 项</small></strong><small>由嵌套结构递归计算</small></div></div>
      <div className="nt-domain-audience"><AudienceReferenceContext kind="domain" targetId={domain.id} hash={referenceHash} resolution={referenceResolution}/><div><span>本域受众版本</span><strong>{ownAudience ? `${ownAudience.name} · v${ownAudience.version}` : domain.audienceId ? `版本不可用 · ${domain.audienceId}` : '继承上级，不追加限制'}</strong>{ownAudience && <small>{describeExpression(getAudienceExpression(ownAudience), getTopology())}</small>}</div><div><span>含祖先的有效条件</span><p>{effectiveAudience}</p></div><small>所有条件须同时满足，使用入组前固定画像；子域不能放宽祖先准入条件。</small></div>
      <TrafficEstimate nominalPercent={domainGlobalTraffic(domain.id)} audienceLabel={effectiveAudience}/>
    </section>
    <ResourceManagementPanel key={`domain:${domain.id}`} kind="domain" node={domain} experiments={experiments} />
    <section className="card nt-layer-content"><div className="nt-section-heading"><h3>从父层继承的参数范围</h3><span className="td-pill">{parameters.length} 项</span></div><ApplicationParameterBrowser key={`domain-${domain.id}`} parameterKeys={parameters} label="域继承参数" /><p className="td-layer-description">{parent ? `仅能重新划分「${parent.name}」的参数；本域的“全参数”是这组父作用域，不是全局所有参数。` : '根域持有全部已归层参数；待归层参数完成分配后才进入范围，每个子域只能继承所在父层的参数。'}</p></section>
    <div className="nt-section-heading"><h3>域内参数层</h3><span>{ownLayers.length} 个层 · 点击查看实验与子域</span></div>
    <div className="nt-domain-layer-grid">{ownLayers.map(layer => <button className="card nt-layer-link" key={layer.id} onClick={() => onSelect({ kind: 'layer', id: layer.id })}><header><Layers3 size={18} /><strong>{layer.name}</strong><ChevronRight size={15} /></header><p>{layer.description}</p><footer><span>{layer.role !== 'routing' && layerScope(layer.id).length === 0 ? '待配置 · 尚未分配参数' : `${layerScope(layer.id).length} 个参数 · ${childDomains(layer.id).length} 个直属子域`}</span><code>{layer.id}</code></footer></button>)}</div>
    <div className="nt-info-note"><Info size={15} /><p>{domain.mode === 'non-overlapping' ? '非重叠只隔离当前分支。该域继承一个父层的参数；若祖先存在其他并行参数层，其实验仍可同时执行。' : '域中的参数层可并行分配；某层选择子域后只沿该分支继续递归，其他兄弟层仍独立执行。'}</p></div>
  </>;
}

function LayerDetails({ layer, experiments, onOpen, onSelect, onCreate, onValidate }: Props & { layer: TrafficLayer; onValidate: (node: Selection) => void; onSelect: (node: Selection) => void; onCreate: (layerId: string) => void }) {
  const parentDomain = domains.find(domain => domain.id === layer.domainId)!;
  const parameters = layerScope(layer.id);
  const pending = layer.role !== 'routing' && parameters.length === 0;
  const direct = experiments.filter(experiment => experiment.layerId === layer.id && reserveStatuses.includes(experiment.status));
  const running = direct.filter(experiment => experiment.status === 'running');
  const reserved = direct.filter(experiment => experiment.status !== 'running');
  const children = childDomains(layer.id);
  const error = direct.map(experiment => validateAllocation(experiment, experiments)).find(Boolean);
  const occupants = [
    ...direct.map(experiment => ({ kind: 'experiment' as const, id: experiment.id, name: experiment.name, ranges: getBucketRanges(experiment), traffic: experiment.traffic, experiment })),
    ...children.map(domain => ({ kind: 'domain' as const, id: domain.id, name: domain.name, ranges: getBucketRanges(domain), traffic: domain.traffic, domain })),
  ].sort((a, b) => (a.ranges[0]?.start ?? BUCKET_COUNT) - (b.ranges[0]?.start ?? BUCKET_COUNT));
  const usedBuckets = bucketCount(unionBucketRanges(occupants.flatMap(item => item.ranges)));
  const freeBuckets = Math.max(0, BUCKET_COUNT - usedBuckets);
  const categories = [
    { label: '本层总桶数', count: BUCKET_COUNT, detail: `固定坐标 [0, ${BUCKET_COUNT})` },
    { label: '运行实验占用', count: bucketCount(unionBucketRanges(running.flatMap(getBucketRanges))), detail: `${running.length} 项运行实验` },
    { label: '暂停／待审预留', count: bucketCount(unionBucketRanges(reserved.flatMap(getBucketRanges))), detail: `${reserved.filter(item => item.status === 'paused').length} 项暂停 · ${reserved.filter(item => item.status === 'review').length} 项待审` },
    { label: '直属子域占用', count: bucketCount(unionBucketRanges(children.flatMap(getBucketRanges))), detail: `${children.length} 个子域` },
  ];
  const lanes: typeof occupants[] = [];
  for (const item of occupants) {
    const lane = lanes.find(row => row.every(other => item.ranges.every(range => other.ranges.every(occupied => range.start >= occupied.end || range.end <= occupied.start))));
    if (lane) lane.push(item); else lanes.push([item]);
  }
  const nominalTotal = occupants.reduce((sum, item) => sum + bucketCount(item.ranges), 0);
  const openOccupant = (item: typeof occupants[number]) => item.kind === 'domain' ? onSelect({ kind: 'domain', id: item.id }) : onOpen(item.experiment);
  return <>
    <section className="card nt-detail-hero"><div className="nt-detail-hero-header"><div><span className="td-overline">LAYER · {layer.id}</span><h2>{layer.name}</h2></div><div className="nt-domain-actions"><button className="btn btn-small nt-validate-btn" onClick={() => onValidate({ kind: 'layer', id: layer.id })}><Route size={13} />验证分流</button>{!pending && layer.role !== 'routing' && <a className="btn btn-small" href={newExperimentHref({layerId:layer.id})}><Plus size={14}/>创建实验</a>}{pending && <span className="td-pill nt-layer-pending">待配置</span>}<button className="btn btn-primary btn-small nt-create-btn" disabled={pending} aria-describedby={pending ? 'empty-layer-guidance' : undefined} onClick={() => { if (!pending) onCreate(layer.id); }}><Plus size={14} />新建子域</button></div></div><p>{layer.description}</p>
      <div className="nt-layer-audience"><Users size={14}/><span>所属域有效条件：{audienceSummary(domainEffectiveAudience(layer.domainId,getTopology()))}</span></div>
      {pending && <div className="nt-empty-layer-guidance" id="empty-layer-guidance"><Info size={16} /><div><strong>先为本层分配参数</strong><p>进入所属应用的参数管理，选择待归层参数并分配到本层；也可以先登记新参数。</p></div><a className="btn btn-small" href="#applications">选择应用与参数<ArrowUpRight size={13} /></a></div>}
      <div className="nt-detail-stats"><div><span>此层全局名义流量</span><strong>{percent(domainGlobalTraffic(layer.domainId))}</strong><small>{shareFormula(layer.domainId)}</small></div><div><span>联合占用桶数</span><strong>{bucketNumber(usedBuckets)}<small> 桶</small></strong><small>{percent(usedBuckets / 100)} · 实验、预留与子域去重后的并集</small></div><div><span>未占用桶数</span><strong>{bucketNumber(freeBuckets)}<small> 桶</small></strong><small>{percent(freeBuckets / 100)} · {bucketNumber(BUCKET_COUNT)} 总桶 − 联合占用{pending ? '；分配参数后才可使用' : ''}</small></div></div>
    </section>
    <ResourceManagementPanel key={`layer:${layer.id}`} kind="layer" node={layer} experiments={experiments} />
    <section className="card nt-layer-content"><div className="nt-section-heading"><h3>本层参数边界</h3><span className="td-pill"><Code2 size={11} />{parameters.length} 项</span></div>{pending ? <p className="nt-empty-layer-scope">尚未分配参数 · 可从应用下的待归层参数进行首次分配。</p> : <ApplicationParameterBrowser key={`layer-${layer.id}`} parameterKeys={parameters} label="层关联参数" />}<p className="td-layer-description">{pending ? '完成分配前，本层不可用于实验，也不能继续创建子域。' : '参数在所属应用内维护，本层可关联多个应用的参数；子域只能继续划分当前参数范围。'}</p></section>
    <section className="card nt-layer-content"><div className="nt-section-heading"><h3>直接实验与子域共用流量桶</h3><span>{bucketNumber(usedBuckets)} / {bucketNumber(BUCKET_COUNT)} 桶联合占用</span></div>
      <div className="nt-bucket-accounting">{categories.map(category => <div key={category.label}><span>{category.label}</span><strong>{bucketNumber(category.count)}<small> 桶</small></strong><small>{category.detail}</small></div>)}</div>
      <p className="nt-bucket-accounting-note">各类占用分别去重；不同受众可复用桶，分类数值不能直接相加。未占用量须同时扣除实验、暂停／待审预留和子域的联合占用，不能只看子域比例。新配置可组合离散空闲桶；受众可证明互斥时还可复用已有坐标，实际可分配量由创建时的有效受众校验确定。</p>
      <div className="nt-bucket-legend"><span className="nt-legend-chip"><i />运行实验</span><span className="nt-legend-chip domain"><i />嵌套子域</span><span className="nt-legend-chip reserved"><i />暂停／待审</span></div>
      <div className="td-bucket-axis" aria-hidden="true">{[0, 2500, 5000, 7500, BUCKET_COUNT].map(tick => <span key={tick}>{bucketNumber(tick)}</span>)}</div>
      <div className="nt-bucket-lanes" aria-label={`${layer.name}的直接实验与子域共享10000个固定桶，整数右开区间`}>{(lanes.length ? lanes : [[]]).map((row, index) => <div key={index} className="nt-bucket-lane"><span className="nt-bucket-lane-label">坐标行 {index + 1}</span><div className="td-bucket-track nt-nested-buckets">{row.flatMap(item => item.ranges.map(range => <button key={`${item.kind}-${item.id}-${range.start}-${range.end}`} className={item.kind === 'domain' ? 'nt-child-domain' : ''} data-state={item.kind === 'experiment' ? item.experiment.status : 'domain'} style={{ left: percent(range.start / 100), width: percent((range.end - range.start) / 100), ...(item.kind === 'experiment' && item.experiment.status === 'running' ? { background: ['#b7d29b', '#d7e6c3', '#91b97d'][running.findIndex(experiment => experiment.id === item.id) % 3] } : {}) }} title={`${item.name} · ${formatBucketRanges([range])} · 本段 ${bucketNumber(range.end - range.start)} 桶；配置共 ${bucketNumber(bucketCount(item.ranges))} 桶 / ${item.ranges.length} 段`} aria-label={`${item.kind === 'domain' ? '下钻子域' : '查看实验'}${item.name}，桶段${formatBucketRanges([range])}`} onClick={() => openOccupant(item)}>{range.end - range.start >= 2200 && <small>{item.name.slice(0, 7)}</small>}{range.end - range.start >= 1000 && <strong>{bucketNumber(range.end - range.start)} 桶</strong>}</button>))}{occupants.length === 0 && <span className="td-bucket-empty">暂无直接实验或子域</span>}</div></div>)}</div>
      <div className="td-bucket-caption"><span>各配置桶数合计 {bucketNumber(nominalTotal)}（可能重复）</span><span>未占用 {bucketNumber(freeBuckets)} 桶 · {percent(freeBuckets / 100)}</span></div>
      <p className="nt-bucket-reuse-note"><Info size={14} />图中按实际桶段定位，区间包含起点、不含终点。同一配置可占多个不连续桶段；共享坐标分行显示，已有桶位保持不变。</p>
      {error && <p className="td-capacity-alert" role="alert"><CircleAlert size={15} />{error}</p>}
      <div className="nt-occupancy-list">{occupants.map(item => <article className="nt-occupancy-item" key={`${item.kind}-${item.id}`}><button className="nt-occupancy-row" onClick={() => openOccupant(item)}><span className={`nt-occupancy-icon ${item.kind}`}>{item.kind === 'domain' ? <GitBranch size={17} /> : <FlaskConical size={17} />}</span><div className="nt-occupancy-info"><strong>{item.name}</strong><small>{item.kind === 'domain' ? `子域 · ${modeLabel(item.domain)}` : `${typeLabels[item.experiment.type]} · ${statusLabels[item.experiment.status]}`}</small><span className="nt-occupancy-audience">{audienceSummary(item.kind === 'domain' ? domainEffectiveAudience(item.id, getTopology()) : experimentEffectiveAudience(item.experiment, getTopology()))}</span></div><div className="nt-occupancy-amount"><strong>{bucketNumber(bucketCount(item.ranges))} 桶 · {percent(item.traffic)}</strong><small>{percent(item.kind === 'domain' ? domainGlobalTraffic(item.id) : globalTraffic(item.experiment))} 全局名义</small><small>{percent(domainGlobalTraffic(parentDomain.id))} × {percent(item.traffic)}</small></div><ArrowRight size={13} /></button><BucketRangeSummary ranges={item.ranges} /></article>)}</div>
    </section>
    <div className="nt-info-note"><Info size={15} /><p>同一用户在本层最多选择一个直接实验或一个子域；选中子域后，继续在子域内的参数层分配。子域内还可以递归创建更深子域，隔离范围始终限定在当前父参数分支。</p></div>
  </>;
}

export default function TrafficDomains({ experiments, onOpen }: Props) {
  const hash = useAudienceReferenceHash();
  const validationRoute = parseTrafficValidationRoute(hash);
  const validationActive = validationRoute.isValidation;
  const [selected, setSelected] = useState<Selection>(readTrafficSelection);
  const [configHash, setConfigHash] = useState(() => parseTrafficValidationRoute(location.hash).isValidation ? configurationHref(readTrafficSelection()) : location.hash);
  const [validationHash, setValidationHash] = useState(() => parseTrafficValidationRoute(location.hash).isValidation ? location.hash : trafficValidationHref());
  const [expanded, setExpanded] = useState(() => new Set(allNodeKeys()));
  const [traced, setTraced] = useState<Set<string>>(new Set());
  const [editorLayerId, setEditorLayerId] = useState<string | null>(null);
  const [editorDomainId, setEditorDomainId] = useState<string | null>(null);
  const [creationNotice, setCreationNotice] = useState('');
  const tabNavigation = useRef<HTMLElement>(null);
  const previousValidationActive = useRef(validationActive);
  useEffect(() => {
    if (validationRoute.isValidation) {
      if (!validationRoute.error) setValidationHash(hash);
    } else {
      const node = readTrafficSelection();
      setSelected(node); setConfigHash(hash);
      setExpanded(previous => new Set([...previous, ...nodePath(node.kind, node.id).map(keyOf)]));
    }
    if (previousValidationActive.current !== validationActive) {
      previousValidationActive.current = validationActive;
      const frame = requestAnimationFrame(() => tabNavigation.current?.scrollIntoView({ block: 'start', behavior: 'instant' }));
      return () => cancelAnimationFrame(frame);
    }
  }, [hash, validationActive]);
  const select = (node: Selection) => {
    const destination = configurationHref(node);
    setSelected(node); setConfigHash(destination); setCreationNotice('');
    setExpanded(previous => new Set([...previous, ...nodePath(node.kind, node.id).map(keyOf)]));
    location.hash = destination;
  };
  const validate = (node: Selection) => {
    const destination = trafficValidationHref(node);
    setValidationHash(destination); location.hash = destination;
  };
  const toggle = (key: string) => setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const domain = selected.kind === 'domain' ? domains.find(item => item.id === selected.id) : undefined;
  const layer = selected.kind === 'layer' ? layers.find(item => item.id === selected.id) : undefined;
  const path = nodePath(selected.kind, selected.id);
  const configurationDestination = parseTrafficDestination(configHash);
  const focus = validationActive ? validationRoute.focus : parseTrafficValidationRoute(validationHash).focus;
  return <div className="management-page td-page">
    <div className="page-heading simple"><div><h1>层域管理</h1><p>配置流量与参数范围，验证用户的完整分流路径。</p></div><a className="td-paper-link" href={paperUrl} target="_blank" rel="noreferrer">Google 论文 · 递归层域模型 <ArrowUpRight size={14} /></a></div>
    <nav className="nt-page-tabs" ref={tabNavigation} aria-label="层域管理子页面"><a href={configHash || '#traffic'} aria-current={!validationActive ? 'page' : undefined}><Layers3 size={15} />层域配置</a><a href={validationHash} aria-current={validationActive ? 'page' : undefined}><Route size={15} />分流验证</a></nav>
    <section className="nt-page-panel" hidden={validationActive} aria-label="层域配置">
    <div className="nt-workspace">
      <aside className="card nt-tree-panel"><div className="nt-tree-header"><div><h2>层域结构</h2><p>域 → 层 → 子域 → 子层</p></div><button className="icon-btn" title="展开全部层级" aria-label="展开全部层级" onClick={() => setExpanded(new Set(allNodeKeys()))}><Expand size={16} /></button></div><nav aria-label="可递归层域树"><ul className="nt-tree">{domains.filter(item => item.parentLayerId === null).map(root => <DomainTree key={root.id} domain={root} depth={0} selected={selected} expanded={expanded} traced={traced} onSelect={select} onToggle={toggle} />)}</ul></nav><p className="nt-tree-foot">右侧比例为全局名义流量。点击节点查看配置，选择「验证分流」关注该节点的到达情况。</p></aside>
      <div className="nt-detail-panel"><nav className="nt-breadcrumb" aria-label="当前层域路径">{path.map((node, index) => <span key={keyOf(node)}>{index > 0 && <ChevronRight size={11} />}<button aria-current={index === path.length - 1 ? 'location' : undefined} onClick={() => select(node)}>{node.name}</button></span>)}</nav>
        {creationNotice && <div className="nt-info-note nt-create-layer-success" role="status"><Layers3 size={15} /><p>{creationNotice}</p></div>}
        {domain && <DomainDetails domain={domain} experiments={experiments} referenceHash={configHash} onSelect={select} onCreateLayer={setEditorDomainId} onValidate={validate} />}
        {layer && <LayerDetails layer={layer} experiments={experiments} onOpen={onOpen} onSelect={select} onCreate={setEditorLayerId} onValidate={validate} />}
        {!domain && !layer && <section className="card aud-not-found" role="alert"><CircleAlert size={22}/><div><h2>{configurationDestination.error ? '层域地址无效' : '未找到层域节点'}</h2><p>{configurationDestination.error ?? '当前工作空间不存在该节点，没有定位到其他域或层。'}</p><a href="#traffic" className="btn">返回层域管理</a></div></section>}
      </div>
    </div>
    </section>
    <section className="nt-page-panel" hidden={!validationActive} aria-label="分流验证页面">
      {validationRoute.error && <section className="card aud-not-found" role="alert"><CircleAlert size={22}/><div><h2>分流验证地址无效</h2><p>{validationRoute.error}</p><a href={trafficValidationHref()} className="btn">打开完整分流验证</a></div></section>}
      <div className="nt-page-panel" hidden={Boolean(validationRoute.error)}><AllocationSimulator experiments={experiments} onOpen={onOpen} onSelect={select} focus={focus} onClearFocus={() => { setValidationHash(trafficValidationHref()); location.hash = trafficValidationHref(); }} active={validationActive && !validationRoute.error} onTrace={ids => { setTraced(new Set(ids)); setExpanded(new Set(allNodeKeys())); }} /></div>
    </section>
    {editorLayerId && layerScope(editorLayerId).length > 0 && <NestedDomainEditor parentLayerId={editorLayerId} experiments={experiments} onClose={() => setEditorLayerId(null)} onCreated={(domainId: string) => { setEditorLayerId(null); setTraced(new Set()); setExpanded(new Set(allNodeKeys())); select({ kind: 'domain', id: domainId }); setCreationNotice(`已创建「${domains.find(item => item.id === domainId)?.name ?? '新子域'}」，并自动生成承接全部 ${domainScope(domainId).length} 个继承参数的「初始参数层」。`); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.nt-tree-select[aria-current="true"]')?.focus()); }} />}
    {editorDomainId && <CreateLayer domainId={editorDomainId} experiments={experiments} onClose={() => setEditorDomainId(null)} onCreated={layerId => { setEditorDomainId(null); setTraced(new Set()); setExpanded(new Set(allNodeKeys())); select({ kind: 'layer', id: layerId }); const count = layerScope(layerId).length; setCreationNotice(`已创建「${layers.find(item => item.id === layerId)?.name ?? '新参数层'}」，${count ? `已配置 ${count} 个参数，可继续创建实验或子域。` : '当前待配置，请先分配参数后再创建实验或子域。'}`); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.nt-tree-select[aria-current="true"]')?.focus()); }} />}
  </div>;
}
