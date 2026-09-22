import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleAlert, Clock3, Code2, FlaskConical, GitBranch, Info, Layers3, LockKeyhole, Plus, Search, Server, Tag, SlidersHorizontal } from 'lucide-react';
import { statusLabels } from '../data';
import type { Experiment } from '../data';
import { domains, getTopology, getParameterDefinition, registeredParameters, layers, layerScope, saveTopology, isParameterPending } from '../traffic';
import { getParameterRelationships } from '../parameter-relations';
import RegisterParameter from './RegisterParameter';
import AssignParameterLayer from './AssignParameterLayer';
import ParameterMetadata from './ParameterMetadata';
import { getCatalog, getParameterService, getParameterTags, getServiceTags, planParameterTags } from '../service-catalog';
import { parameterHref, canonicalApplicationRoute, APPLICATION_ROUTE_CHANGE_EVENT } from '../application-routes';
import './parameter-center.css';

type Props = { serviceId: string; experiments: Experiment[]; onOpen: (experiment: Experiment) => void; embedded?: boolean };
const percent = (value: number) => `${Number(value.toFixed(2))}%`;
const parameterGroup = (key: string) => ({ ui: '展示参数', ranking: '排序参数', checkout: '交易参数', pricing: '定价参数' }[key.split('.')[0]] ?? '业务参数');
function keyFromHash() {
  let parts = canonicalApplicationRoute(window.location.hash).split('/');
  if (parts[0] !== '#applications' || parts[1] !== 'services' || parts[3] !== 'parameters') {
    // Keep an unavailable explicit key visible as an error until the parent completes route normalization.
    const original = window.location.hash.split('/');
    if (original[0] !== '#applications' || original[1] !== 'services' || original[3] !== 'parameters') return '';
    parts = original;
  }
  try { return decodeURIComponent(parts[4] ?? ''); } catch { return parts[4] ?? ''; }
}
function valueLabel(value: unknown) {
  if (value === undefined) return '未配置此参数';
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

export default function ParameterCenter({ serviceId, experiments, onOpen, embedded=false }: Props) {
  const topology = getTopology();
  const catalog = getCatalog(topology);
  const serviceTags = getServiceTags(serviceId, topology);
  const service = catalog.services.find(item => item.id === serviceId);
  const serviceKeys = registeredParameters.filter(key => getParameterService(key, topology)?.id === serviceId);
  const serviceListHref = `#applications/services/${encodeURIComponent(serviceId)}/parameters`;
  const internalNavigation = useRef<string | null>(null);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [layerFilter, setLayerFilter] = useState('all');
  const [assignmentFilter, setAssignmentFilter] = useState<'all' | 'pending' | 'assigned'>('all');
  const [groupBy, setGroupBy] = useState<'flat' | 'tag'>('flat');
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const [batchTag, setBatchTag] = useState('');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState(() => keyFromHash() || serviceKeys[0] || '');
  const [domainFilter, setDomainFilter] = useState('all');
  const [registering, setRegistering] = useState(false);
  const [assigningKey, setAssigningKey] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const relationships = useMemo(() => serviceKeys.map(key => getParameterRelationships(key, experiments, topology)), [experiments, topology, serviceId]);
  const visible = relationships.filter(item => {
    const service = getParameterService(item.key, topology), tags = getParameterTags(item.key, topology);
    return (assignmentFilter === 'all' || isParameterPending(item.key, topology) === (assignmentFilter === 'pending'))
      && (!tagFilters.length || tags.some(tag => tagFilters.includes(tag.id)))
      && (layerFilter === 'all' || layerScope(layerFilter, topology).includes(item.key))
      && `${item.key} ${parameterGroup(item.key)} ${getParameterDefinition(item.key, topology)?.name ?? ''} ${service?.name ?? '待归属'} ${tags.map(tag => tag.name).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  const groups = groupBy === 'flat'
    ? [{ id: 'all-service-parameters', name: '本服务参数', items: visible }]
    : [...serviceTags.filter(tag=>!tagFilters.length||tagFilters.includes(tag.id)).map(tag => ({id:tag.id,name:tag.name,items:visible.filter(item=>getParameterTags(item.key,topology).some(t=>t.id===tag.id))})), {id:'untagged',name:'未设置标签',items:visible.filter(item=>!getParameterTags(item.key,topology).length)}];
  function applyBatch(mode:'add'|'remove') {
    const latest = getTopology();
    if (!checkedKeys.length || checkedKeys.some(key => getParameterService(key, latest)?.id !== serviceId)) { setNotice('所选参数的服务归属已变化，请重新选择本服务参数。'); setCheckedKeys([]); return; }
    if (!getServiceTags(serviceId, latest).some(tag => tag.id === batchTag)) { setNotice('请选择当前应用的标签。'); setBatchTag(''); return; }
    const plan = planParameterTags(checkedKeys,[batchTag],mode,latest);
    if(plan.error||!plan.topology){setNotice(plan.error??'无法更新标签');return;}
    const error=saveTopology(plan.topology,experiments);
    setNotice(error??`已为 ${checkedKeys.length} 个参数${mode==='add'?'添加':'移除'}标签；实验参数集合和分桶保持不变。`);
    if(!error){setCheckedKeys([]);setBatchTag('');}
  }
  function resetFilters(){setQuery('');setTagFilters([]);setLayerFilter('all');setAssignmentFilter('all');setCheckedKeys([]);setBatchTag('');}

  const requestedKey = keyFromHash();
  const unavailableParameter = Boolean(requestedKey && !serviceKeys.includes(requestedKey));
  const selected = unavailableParameter ? undefined : visible.find(item => item.key === selectedKey) ?? visible[0];
  const selectedPending = selected ? isParameterPending(selected.key, topology) : false;
  const definition = selected ? getParameterDefinition(selected.key, topology) : undefined;
  const owners = selectedPending ? [] : selected?.owners.filter(owner => domainFilter === 'all' || owner.domainId === domainFilter) ?? [];
  const references = selected?.references.filter(reference => domainFilter === 'all' || reference.experiment.domainId === domainFilter) ?? [];
  useEffect(() => {
    setSelectedKey(keyFromHash() || registeredParameters.find(key => getParameterService(key, getTopology())?.id === serviceId) || '');
    resetFilters(); setDomainFilter('all'); setRegistering(false); setAssigningKey(null); setNotice(''); internalNavigation.current = null;
  }, [serviceId]);
  useEffect(() => {
    const readSelection = () => {
      const route = canonicalApplicationRoute(window.location.hash);
      if (internalNavigation.current === route) return;
      internalNavigation.current = null;
      const parts = route.split('/');
      let requestedService = ''; try { requestedService = decodeURIComponent(parts[2] ?? ''); } catch { return; }
      if (parts[0] !== '#applications' || parts[1] !== 'services' || parts[3] !== 'parameters' || requestedService !== serviceId) return;
      const key = keyFromHash();
      setSelectedKey(key || registeredParameters.find(item => getParameterService(item, getTopology())?.id === serviceId) || ''); resetFilters(); setDomainFilter('all');
    };
    window.addEventListener('hashchange', readSelection);
    window.addEventListener(APPLICATION_ROUTE_CHANGE_EVENT, readSelection);
    return () => { window.removeEventListener('hashchange', readSelection); window.removeEventListener(APPLICATION_ROUTE_CHANGE_EVENT, readSelection); };
  }, [serviceId]);
  const selectParameter = (key: string) => {
    if (getParameterService(key, getTopology())?.id !== serviceId) { setNotice('该参数不属于当前服务，无法在此处维护。'); return; }
    setSelectedKey(key); const href = parameterHref(key);
    if (window.location.hash !== href) { internalNavigation.current = href; window.location.hash = href; }
  };

  const beginAssignment = (key: string) => {
    const latest = getTopology();
    if (getParameterService(key, latest)?.id !== serviceId || !isParameterPending(key, latest)) { setNotice('仅可为当前应用的待归层参数分配层。已归层参数请使用现有转移管理。'); return; }
    setAssigningKey(key); setNotice('');
  };

  return <div className="management-page pc-page">
    <div className={embedded ? "pc-embedded-heading" : "page-heading simple"}><div>{embedded ? <h2>参数管理</h2> : <h1>参数管理</h1>}<p>{service?.name ?? '当前服务'}的参数、层归属与实验引用；所有操作限于本服务。</p></div><div className="heading-actions"><a className="btn" href="#traffic"><Layers3 size={15} />管理层域<ArrowUpRight size={13} /></a><button className="btn btn-primary" disabled={!service} onClick={() => { setNotice(''); setRegistering(true); }}><Plus size={16} />注册参数</button></div></div>
    {notice && <p className="pc-registration-notice" role="status"><Check size={16} />{notice}</p>}
    {!embedded && <section className="pc-rule-strip" aria-label="关系控制规则"><div><span><Server size={17}/></span><p><strong>服务唯一归属</strong><small>本页仅维护当前服务持有的参数</small></p></div><div><span><Tag size={17}/></span><p><strong>标签组织参数</strong><small>标签仅属于当前应用，不参与分流</small></p></div><div><span><Layers3 size={17}/></span><p><strong>域内唯一归层</strong><small>实验只使用本层参数，同层实验互斥</small></p></div></section>}
    <section className="card pc-filters" aria-label="参数目录筛选"><div className="pc-filter-row"><label>归层状态<select aria-label="筛选参数归层状态" value={assignmentFilter} onChange={event=>{setAssignmentFilter(event.target.value as 'all' | 'pending' | 'assigned');setCheckedKeys([]);}}><option value="all">全部状态</option><option value="pending">待归层</option><option value="assigned">已归层</option></select></label><label>域 / 参数层<select aria-label="筛选参数所属层" value={layerFilter} onChange={e=>{setLayerFilter(e.target.value);setCheckedKeys([]);}}><option value="all">全部层域</option>{layers.filter(layer=>layer.role!=='routing').map(layer=><option key={layer.id} value={layer.id}>{domains.find(domain=>domain.id===layer.domainId)?.name} / {layer.name}</option>)}</select></label><button className="btn btn-small" onClick={resetFilters}>重置筛选</button><span>{visible.length} 个参数 · 去重统计</span></div><div className="pc-filter-tags"><span><Tag size={13}/>本应用标签</span>{serviceTags.map(tag=><button key={tag.id} className={`pt-chip pt-${tag.color} ${tagFilters.includes(tag.id)?'is-selected':''}`} aria-pressed={tagFilters.includes(tag.id)} onClick={()=>{setTagFilters(ids=>ids.includes(tag.id)?ids.filter(id=>id!==tag.id):[...ids,tag.id]);setCheckedKeys([]);}}>{tag.name}</button>)}{!serviceTags.length&&<span className="pc-private-tag-empty">当前应用暂无标签，可在参数详情或注册时创建。</span>}<small>多标签任一匹配，与其他筛选同时满足</small></div></section>
    <div className="pc-workspace">
      <aside className="card pc-catalog"><header><div><h2>参数目录</h2><span>{visible.length} 项</span></div><label className="pc-search"><Search size={15} /><input aria-label="搜索参数名" placeholder="搜索参数名、Key 或标签" value={query} onChange={event => { setQuery(event.target.value); setCheckedKeys([]); }} /></label><div className="pc-group-switch"><button className={groupBy==='flat'?'active':''} onClick={()=>setGroupBy('flat')}><Code2 size={12}/>平铺列表</button><button className={groupBy==='tag'?'active':''} onClick={()=>setGroupBy('tag')}><Tag size={12}/>按标签</button></div></header>
        <div className="pc-batch"><label><input type="checkbox" aria-label="选择全部筛选参数" checked={visible.length>0&&visible.every(item=>checkedKeys.includes(item.key))} onChange={event=>setCheckedKeys(event.target.checked?visible.map(item=>item.key):[])}/>已选 {checkedKeys.length} 项</label><select aria-label="批量操作标签" value={batchTag} onChange={event=>setBatchTag(event.target.value)}><option value="">选择本应用标签</option>{serviceTags.map(tag=><option key={tag.id} value={tag.id}>{tag.name}</option>)}</select><div><button disabled={!checkedKeys.length||!batchTag} onClick={()=>applyBatch('add')}>添加标签</button><button disabled={!checkedKeys.length||!batchTag} onClick={()=>applyBatch('remove')}>移除标签</button></div></div>
        <nav aria-label="注册参数列表">{groups.filter(group=>group.items.length).map(group=><div className="pc-param-group" key={group.id}><h3>{group.name}<span>{group.items.length}</span></h3>{group.items.map(item=><div className={`pc-param-row ${selected?.key===item.key?'is-selected':''}`} key={item.key}><input type="checkbox" aria-label={`选择参数 ${item.key}`} checked={checkedKeys.includes(item.key)} onChange={event=>setCheckedKeys(keys=>event.target.checked?[...new Set([...keys,item.key])]:keys.filter(key=>key!==item.key))}/><button className={`pc-parameter-item ${selected?.key === item.key ? 'is-selected' : ''}`} aria-pressed={selected?.key === item.key} onClick={() => selectParameter(item.key)}><span className="pc-parameter-icon"><Code2 size={15} /></span><span><strong>{item.key}</strong><small><span className={`pc-assignment-state ${isParameterPending(item.key,topology)?'is-pending':''}`}>{isParameterPending(item.key,topology)?'待归层':'已归层'}</span> · {item.references.length} 个实验</small><span className="pc-row-tags">{getParameterTags(item.key,topology).map(tag=><span key={tag.id}>{tag.name}</span>)}</span></span>{item.issues.length > 0 ? <CircleAlert size={14} className="pc-warning-icon" aria-label="关系校验存在问题" /> : <ArrowRight size={13} />}</button></div>)}</div>)}</nav>
        {visible.length === 0 && <div className="pc-empty pc-search-empty"><Search size={24} /><strong>没有匹配的参数</strong><p>调整标签、参数层或搜索条件；可在当前服务下注册新参数。</p><button className="btn btn-small" onClick={resetFilters}>重置筛选</button></div>}
        <footer>分组仅使用当前应用的私有标签，多标签参数可出现在多个分组中。批量操作按参数去重，不影响已保存实验的参数集合。</footer>
      </aside>
      <div className="pc-detail">
        {!selected ? <section className="card pc-empty pc-detail-empty"><Code2 size={28} /><strong>{unavailableParameter ? '参数不在当前服务中' : service ? '选择一个注册参数' : '未找到当前服务'}</strong><p>{unavailableParameter ? `参数 ${requestedKey} 尚未注册或不属于「${service?.name ?? serviceId}」，此处不展示其他服务的参数。` : '在本服务参数列表中选择一项，查看完整归属与实验引用。'}</p>{unavailableParameter && <a className="btn btn-small" href={serviceListHref} onClick={resetFilters}>返回本服务参数</a>}</section> : <>
          <section className="card pc-detail-hero"><div className="pc-hero-heading"><div><span className="pc-overline">PARAMETER RELATIONSHIPS</span><h2>{selected.key}</h2><p>{getParameterService(selected.key,topology)?.name??'待归属服务'} · {parameterGroup(selected.key)}<span className={`pc-assignment-state ${selectedPending?'is-pending':''}`}>{selectedPending?'待归层':'已归层'}</span></p></div><span className="pc-hero-icon"><SlidersHorizontal size={23} /></span></div>
            {selectedPending && <div className="pc-pending-banner"><Clock3 size={19}/><div><strong>已登记，等待分配到层</strong><p>参数定义与应用归属已保存。完成层分配后，才能在实验中选择此参数。</p></div><button type="button" className="btn btn-primary" onClick={() => beginAssignment(selected.key)}><Layers3 size={15}/>分配到层</button></div>}
            <div className="pc-stat-grid"><div><span>使用此参数的实验</span><strong>{selected.references.length}<small> 项</small></strong></div><div><span>有归属层的域</span><strong>{selectedPending ? 0 : new Set(selected.owners.map(owner => owner.domainId)).size}<small> 个</small></strong></div><div><span>未结束实验引用</span><strong>{selected.references.filter(reference => reference.experiment.status !== 'completed').length}<small> 项</small></strong></div></div>
            <ParameterMetadata key={`${selected.key}:${getParameterService(selected.key,topology)?.id??'unassigned'}:${getParameterTags(selected.key,topology).map(tag=>tag.id).join(',')}`} parameterKey={selected.key} experiments={experiments} onSaved={setNotice}/>
            {definition && <div className="pc-definition" aria-label="注册参数定义"><dl><div><dt>参数名称</dt><dd>{definition.name}</dd></div><div><dt>类型</dt><dd><code>{definition.type}</code></dd></div><div><dt>负责人</dt><dd>{definition.owner}</dd></div><div><dt>注册时间</dt><dd>{new Date(definition.createdAt).toLocaleString('zh-CN')}</dd></div></dl><p>{definition.description || '暂无参数说明。'}</p><div className="pc-default-value"><span>注册默认值</span><pre><code>{valueLabel(definition.defaultValue)}</code></pre></div></div>}
            <div className="pc-schema-note"><Info size={14} /><p>{definition ? '此参数已启用类型校验，默认值用于新实验初始配置。下方值来自实验版本；数值范围、对象字段 schema 和生产 SDK 默认值下发尚未实现。' : '此项为内置演示参数，未登记类型与默认值，按参数名和作用域校验。新注册参数会校验类型，并保存默认值与负责人。'}</p></div>
          </section>
          <div className="pc-detail-toolbar"><div><GitBranch size={15} /><strong>归属与引用关系</strong></div><label>按所属域查看<select aria-label="筛选参数归属域" value={domainFilter} onChange={event => setDomainFilter(event.target.value)}><option value="all">全部域</option>{domains.map(domain => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label></div>
          <section className="card pc-owners"><header className="pc-section-heading"><div><h3>在哪一层管理</h3><p>{selectedPending ? '参数登记与层分配是两个独立操作，当前尚未进入层域范围。' : '归属唯一性以域为边界；子域中的参数来自父层继承。'}</p></div><span>{owners.length} 处归属</span></header>
            {owners.length === 0 ? <div className="pc-empty"><Layers3 size={23} /><strong>{selectedPending ? '尚未分配到参数层' : '此范围内没有归属层'}</strong><p>{selectedPending ? '请使用上方“分配到层”完成归层。待归层是正常登记状态，此参数暂不可用于实验。' : domainFilter === 'all' ? '请在层域管理中检查参数划分。' : '此域未持有该参数，或参数尚未划分给本域的层。'}</p>{!selectedPending && domainFilter !== 'all' && <button className="btn btn-small" onClick={() => setDomainFilter('all')}>查看全部域</button>}</div> : <div className="pc-owner-list">{owners.map(owner => <article className="pc-owner" key={`${owner.domainId}:${owner.layerId}`}>
              <div className="pc-owner-heading"><div><a href={`#traffic/domain/${encodeURIComponent(owner.domainId)}`}><GitBranch size={14} />{owner.domainName}<ArrowUpRight size={12} /></a><span className="pc-mode">{owner.mode === 'overlapping' ? '重叠域' : '非重叠域'}</span></div><span className="pc-traffic">全局名义流量 <strong>{percent(owner.globalTraffic)}</strong></span></div>
              <div className="pc-owner-body"><div className="pc-owner-location"><a className="pc-layer-name" href={`#traffic/layer/${encodeURIComponent(owner.layerId)}`}><Layers3 size={16} />{owner.layerName}<ArrowUpRight size={13} /></a><p className="pc-owner-path">{owner.path}</p><span className="pc-reference-count"><FlaskConical size={12} />{owner.referenceExperimentIds.length} 个实验引用</span></div><div className={`pc-transfer-state ${owner.transferBlockedReason ? 'is-protected' : ''}`}><span>{owner.transferBlockedReason ? <LockKeyhole size={14} /> : <Check size={14} />}{owner.transferBlockedReason ? '转移受保护' : '可在建层时转移'}</span><p>{owner.transferBlockedReason ?? '可在本域新建层时分配此参数，提交时将再次校验依赖。'}</p><a href={`#traffic/domain/${encodeURIComponent(owner.domainId)}`}>管理归属<ArrowRight size={12} /></a></div></div>
            </article>)}</div>}
            <footer className="pc-section-foot"><Info size={13} /><span>{selectedPending ? '待归层参数不会被层自动继承，也不会参与实验分流。' : '父层与继承子域中的归属可同时显示；这表示作用域逐级细分，不代表并行层重复拥有参数。'}</span></footer>
          </section>
          <section className="card pc-experiments"><header className="pc-section-heading"><div><h3>哪些实验在使用</h3><p>比较同一参数在各实验版本中的配置，点击实验查看完整配置。</p></div><span>{references.length} 个实验</span></header>
            {references.length === 0 ? <div className="pc-empty"><FlaskConical size={23} /><strong>此范围内暂无实验引用</strong><p>在所属层创建实验后，引用关系和版本值会显示在这里。</p></div> : <div className="pc-reference-list">{references.map(reference => <article className="pc-experiment" key={reference.experiment.id}><div className="pc-experiment-heading"><div><button onClick={() => onOpen(reference.experiment)}>{reference.experiment.name}<ArrowUpRight size={14} /></button><p><code>{reference.experiment.id}</code><span>·</span><span>{reference.experiment.owner}</span></p></div><span className={`status-badge ${reference.experiment.status}`}><i />{statusLabels[reference.experiment.status]}</span></div>
              <div className="pc-reference-location"><Layers3 size={12} /><a href={`#traffic/layer/${encodeURIComponent(reference.experiment.layerId)}`}>{reference.experiment.layer}<ArrowUpRight size={11} /></a>{reference.experiment.status === 'completed' ? <span className="pc-history-label">已结束 · 历史引用</span> : !reference.currentOwner ? <span className="pc-invalid-label">当前归属需检查</span> : <span>引用本层允许参数</span>}</div>
              <div className="pc-variant-values">{reference.values.map((item, index) => <div key={`${item.variant}:${index}`} className={item.error ? 'has-value-error' : ''}><span>{item.variant}</span>{item.error ? <p className="pc-value-error"><CircleAlert size={13} />{item.error}</p> : <pre><code>{valueLabel(item.value)}</code></pre>}</div>)}</div>
              {reference.experiment.status === 'completed' && !reference.currentOwner && <p className="pc-history-note">保留结束时的参数引用与版本值；参数当前归属已变化，不以历史引用阻止转移。</p>}
            </article>)}</div>}
          </section>
          {selectedPending ? <section className="pc-validation is-pending" aria-label="参数待归层状态"><span><Clock3 size={19}/></span><div><h3>待归层 · 尚不可用于实验</h3><p>这是正常的参数登记状态。分配到层时将校验层域范围与参数归属；此处不会将待归层视为配置错误。</p>{selected.issues.length > 0 && <ul>{selected.issues.map((issue,index)=><li key={`${index}:${issue}`}>{issue}</li>)}</ul>}</div></section> : <section className={`pc-validation ${selected.issues.length ? 'has-issues' : ''}`} aria-label="当前参数关系校验"><span>{selected.issues.length ? <CircleAlert size={19} /> : <Check size={19} />}</span><div><h3>{selected.issues.length ? `发现 ${selected.issues.length} 项关系问题` : '当前参数关系校验通过'}</h3>{selected.issues.length ? <ul>{selected.issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}</ul> : <p>当前参数的归属及未结束实验引用未发现作用域冲突。所有关系均按当前本地配置检查。</p>}<small>校验覆盖此参数的全部域，不受上方域筛选影响。</small></div></section>}

        </>}
      </div>
    </div>
    {assigningKey && isParameterPending(assigningKey, topology) && getParameterService(assigningKey, topology)?.id === serviceId && <AssignParameterLayer parameterKey={assigningKey} experiments={experiments} onClose={() => setAssigningKey(null)} onAssigned={() => { const key = assigningKey; setAssigningKey(null); resetFilters(); setDomainFilter('all'); selectParameter(key); setNotice(`参数 ${key} 已完成归层，可在所属层的实验中选择。`); }} />}
    {registering && service && <RegisterParameter lockedServiceId={serviceId} experiments={experiments} onClose={() => setRegistering(false)} onRegistered={key => { setRegistering(false); resetFilters(); setDomainFilter('all'); selectParameter(key); setNotice(`参数 ${key} 已登记，待分配到层后可用于实验。`); }} />}
  </div>;
}
