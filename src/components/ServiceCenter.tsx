import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Activity, ArrowLeft, ArrowRight, ArrowUpRight, Box, Check, CircleAlert, Clock3, Code2, FlaskConical, GitBranch, Globe, Info, Network, Plus, Search, Server, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import type { Experiment } from '../data';
import { statusLabels } from '../data';
import { getParameterDefinition, getTopology, registeredParameters, saveTopology } from '../traffic';
import { getCatalog, getParameterBinding, planParameterService, planServiceEnvironment, planServiceRegistration } from '../service-catalog';
import type { ServiceDefinition, ServiceEnvironment } from '../service-catalog';
import ParameterCenter from './ParameterCenter';
import { APPLICATION_ROUTE_CHANGE_EVENT, canonicalApplicationRoute, parameterHref, serviceHref } from '../application-routes';
import './service-center.css';

type Props = { experiments: Experiment[]; onOpen: (experiment: Experiment) => void; embedded?: boolean };
type ServiceType = ServiceDefinition['type'];
type DetailTab = 'overview' | 'parameters' | 'integration' | 'observations' | 'experiments';
const serviceTypes: { value: ServiceType; label: string; icon: typeof Server; note: string }[] = [
  { value: 'frontend', label: '前端应用', icon: Globe, note: '页面、交互与客户端配置' },
  { value: 'backend', label: '后端服务', icon: Server, note: '接口、交易与基础服务配置' },
  { value: 'strategy', label: '策略服务', icon: SlidersHorizontal, note: '推荐、定价与模型策略配置' },
  { value: 'gateway', label: '网关 / BFF', icon: Network, note: '统一决策与实验上下文传递' },
];
const environmentNames: Record<ServiceEnvironment['name'], string> = { development: '开发', staging: '测试', production: '生产' };
const detailTabs: { id: DetailTab; label: string; icon: typeof Server }[] = [
  { id: 'overview', label: '概览', icon: Box }, { id: 'parameters', label: '参数', icon: Code2 },
  { id: 'integration', label: '接入配置', icon: GitBranch }, { id: 'observations', label: '运行观测', icon: Activity },
  { id: 'experiments', label: '关联实验', icon: FlaskConical },
];
function readServiceRoute() {
  const parts = canonicalApplicationRoute(window.location.hash).split('/');
  const decode = (value = '') => { try { return decodeURIComponent(value); } catch { return ''; } };
  const selectedId = parts[1] === 'services' ? decode(parts[2]) : '';
  const tab: DetailTab = detailTabs.find(item => item.id === parts[3])?.id ?? 'overview';
  const claimKey = parts[1] === 'unassigned' ? decode(parts[2]) : '';
  return { selectedId, tab, claimKey };
}
const typeInfo = (type: ServiceType) => serviceTypes.find(item => item.value === type)!;

function ServiceRegistration({ experiments, onClose, onSaved }: { experiments: Experiment[]; onClose: () => void; onSaved: (id: string) => void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [type, setType] = useState<ServiceType>('backend');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLFormElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLInputElement>('#service-registration-id')?.focus();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);
  function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!id.trim() || !name.trim() || !owner.trim()) { setError('请填写应用标识、应用名称和负责人。'); return; }
    const plan = planServiceRegistration({ id: id.trim(), name: name.trim(), owner: owner.trim(), type, description: description.trim() }, getTopology());
    if (plan.error || !plan.topology) { setError(plan.error ?? '应用登记失败，请检查输入。'); return; }
    const invalid = saveTopology(plan.topology, experiments);
    if (invalid) { setError(invalid); return; }
    onSaved(id.trim());
  }
  return <div className="sc-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={dialog} className="sc-dialog" role="dialog" aria-modal="true" aria-labelledby="service-registration-title" onSubmit={submit} noValidate>
      <header><span className="sc-icon"><Server size={21} /></span><div><h2 id="service-registration-title">登记应用</h2><p>建立应用 / 服务档案，再注册参数与配置各环境的决策方式。</p></div><button type="button" className="sc-icon-button" aria-label="关闭登记应用" onClick={onClose}><X size={19} /></button></header>
      <div className="sc-dialog-body"><div className="sc-form-grid">
        <label className="sc-field">应用标识 <span className="sc-required">*</span><input id="service-registration-id" value={id} onChange={event => { setId(event.target.value); setError(''); }} placeholder="如 search-service" autoComplete="off" maxLength={64} required /><small>2–64 个字符，小写字母开头，可包含数字、连字符与下划线。</small></label>
        <label className="sc-field">应用名称 <span className="sc-required">*</span><input value={name} onChange={event => { setName(event.target.value); setError(''); }} placeholder="如 搜索排序服务" maxLength={60} required /></label>
        <label className="sc-field">应用类型<select value={type} onChange={event => setType(event.target.value as ServiceType)}>{serviceTypes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label className="sc-field">负责人 <span className="sc-required">*</span><input value={owner} onChange={event => { setOwner(event.target.value); setError(''); }} placeholder="团队或负责人" maxLength={60} required /></label>
        <label className="sc-field sc-full-width">应用说明<textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} maxLength={300} placeholder="描述应用 / 服务负责的业务能力和实验配置范围" /></label>
      </div><div className="sc-note"><Info size={15} /><p>登记会创建开发、测试、生产三个独立的接入配置，初始为直接决策。接入状态均为待验证，登记不代表应用已连接。</p></div>{error && <p ref={alert} tabIndex={-1} className="sc-error" role="alert"><CircleAlert size={16} />{error}</p>}</div>
      <footer><span>配置保存到当前浏览器</span><div><button type="button" className="btn" onClick={onClose}>取消</button><button type="submit" className="btn btn-primary">登记应用<ArrowRight size={14} /></button></div></footer>
    </form>
  </div>;
}

function EnvironmentConfiguration({ service, environment, services, experiments, onSaved }: { service: ServiceDefinition; environment: ServiceEnvironment; services: ServiceDefinition[]; experiments: Experiment[]; onSaved: () => void }) {
  const [mode, setMode] = useState(environment.mode);
  const [decisionServiceId, setDecisionServiceId] = useState(environment.decisionServiceId ?? '');
  const [error, setError] = useState('');
  const alert = useRef<HTMLParagraphElement>(null);
  const gateways = services.filter(item => item.id !== service.id && item.type === 'gateway');
  useEffect(() => { setMode(environment.mode); setDecisionServiceId(environment.decisionServiceId ?? ''); setError(''); }, [service.id, environment.name, environment.mode, environment.decisionServiceId]);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);
  function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (mode === 'delegated' && !decisionServiceId) { setError('请选择负责当前环境决策的网关 / BFF。'); return; }
    const next: ServiceEnvironment = mode === 'direct' ? { name: environment.name, mode } : { name: environment.name, mode, decisionServiceId };
    const plan = planServiceEnvironment(service.id, next, getTopology());
    if (plan.error || !plan.topology) { setError(plan.error ?? '接入配置无法保存。'); return; }
    const invalid = saveTopology(plan.topology, experiments);
    if (invalid) { setError(invalid); return; }
    onSaved();
  }
  const decisionService = services.find(item => item.id === decisionServiceId);
  const pseudo = mode === 'direct'
    ? `// 伪代码：真实 SDK 与协议尚未接入\nconfig = 获取已发布配置(${JSON.stringify(environment.name)})\ndecision = 按统一身份决策(config, user_id)\n应用所属参数(${JSON.stringify(service.id)}, decision)\n记录实际生效曝光(decision)`
    : `// 伪代码：由网关 / BFF 统一决策\ncontext = 请求决策上下文(${JSON.stringify(decisionServiceId || '<网关 / BFF 应用标识>')}, user_id)\n校验上下文身份与配置版本(context)\n应用所属参数(${JSON.stringify(service.id)}, context)\n记录本服务实际生效曝光(context)`;
  return <div className="sc-integration-grid"><form className="card sc-configuration" onSubmit={submit}>
    <header className="sc-section-heading"><div><h3>{environmentNames[environment.name]}环境接入配置</h3><p>只保存当前环境；其他环境使用各自的配置。</p></div><span className="sc-pending"><Clock3 size={12} />待验证</span></header>
    <div className="sc-section-body"><fieldset className="sc-mode-options"><legend>决策方式</legend>
      <label className={mode === 'direct' ? 'is-selected' : ''}><input type="radio" name="service-decision-mode" checked={mode === 'direct'} onChange={() => { setMode('direct'); setError(''); }} /><span><strong>应用直接决策</strong><small>本应用获取配置并执行分流，应用自己负责的参数。</small></span><Server size={19} /></label>
      <label className={mode === 'delegated' ? 'is-selected' : ''}><input type="radio" name="service-decision-mode" checked={mode === 'delegated'} onChange={() => { setMode('delegated'); setError(''); }} /><span><strong>委托网关 / BFF 决策</strong><small>上游统一生成实验上下文，本应用按上下文应用参数。</small></span><Network size={19} /></label>
    </fieldset>
    {mode === 'delegated' && <label className="sc-field sc-decision-field">决策服务<select aria-label="选择决策服务" value={decisionServiceId} onChange={event => { setDecisionServiceId(event.target.value); setError(''); }}><option value="">选择网关 / BFF</option>{gateways.map(item => <option value={item.id} key={item.id}>{item.name} · {item.id}</option>)}</select><small>{gateways.length ? '仅可选择已登记的网关 / BFF；不能委托自己，也不能形成循环。' : '还没有其他网关 / BFF，请先返回应用目录登记 gateway 类型的应用。'}</small></label>}
    <div className="sc-note"><GitBranch size={15} /><p>委托只改变决策位置。参数仍归属「{service.name}」，层归属和流量分配保持独立管理。</p></div>
    <div className="sc-credential-note"><ShieldCheck size={16} /><div><strong>生产凭证与 SDK 尚未接入</strong><p>此处仅保存接入设计，不生成真实凭证，也不验证网络连接。</p></div></div>
    {error && <p ref={alert} tabIndex={-1} className="sc-error" role="alert"><CircleAlert size={16} />{error}</p>}
    <button type="submit" className="btn btn-primary sc-save-environment">保存{environmentNames[environment.name]}环境配置<Check size={14} /></button></div>
  </form><aside className="card sc-guide"><header className="sc-section-heading"><div><h3>接入指引</h3><p>{mode === 'direct' ? '直接决策的责任边界' : `委托入口：${decisionService?.name ?? '待选择'}`}</p></div><Code2 size={17} /></header><div className="sc-section-body"><ol><li>统一用户标识与随机化单元。</li><li>{mode === 'direct' ? '读取已发布配置，在固定版本上完成决策。' : '从决策入口传递带版本的实验上下文。'}</li><li>应用本服务负责的参数并记录实际曝光。</li><li>验证回退行为、配置版本和事件链路。</li></ol><span className="sc-code-caption">流程伪代码 · 非可调用 API</span><pre><code>{pseudo}</code></pre><p className="sc-guide-foot">接入状态需要真实 SDK、配置拉取与曝光事件验证；保存表单不会将服务标记为已连接。</p></div></aside></div>;
}

function ParameterClaim({ parameterKey, experiments, onClaimed }: { parameterKey: string; experiments: Experiment[]; onClaimed: (key: string) => void }) {
  const [serviceId, setServiceId] = useState('');
  const [error, setError] = useState('');
  const topology = getTopology();
  const definition = getParameterDefinition(parameterKey, topology);
  function submit(event: FormEvent) {
    event.preventDefault();
    const plan = planParameterService(parameterKey, serviceId, getTopology());
    if (plan.error || !plan.topology) { setError(plan.error ?? '无法保存服务归属。'); return; }
    const invalid = saveTopology(plan.topology, experiments);
    if (invalid) { setError(invalid); return; }
    onClaimed(parameterKey);
  }
  return <form className="sc-claim-row" onSubmit={submit}>
    <div><strong>{definition?.name ?? parameterKey}</strong><code>{parameterKey}</code></div>
    <label className="sc-field">所属应用 / 服务<select aria-label={`认领 ${parameterKey} 的所属服务`} value={serviceId} onChange={event => { setServiceId(event.target.value); setError(''); }} required><option value="">选择所属服务</option>{getCatalog(topology).services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>
    <button className="btn btn-small" type="submit" disabled={!serviceId}><Check size={13} />确认归属并管理</button>
    {error && <p className="sc-error" role="alert">{error}</p>}
  </form>;
}

function UnassignedParameters({ requestedKey, experiments, onClaimed }: { requestedKey: string; experiments: Experiment[]; onClaimed: (key: string) => void }) {
  const topology = getTopology();
  const unassigned = registeredParameters.filter(key => !getParameterBinding(key, topology)?.serviceId);
  if (requestedKey && !registeredParameters.includes(requestedKey)) return <section className="card sc-empty sc-unassigned" role="status"><CircleAlert size={27} /><h3>未找到参数</h3><p>参数 {requestedKey} 尚未注册或链接已失效。</p><a href="#applications" className="btn btn-small">返回应用目录</a></section>;
  if (!unassigned.length) return null;
  return <details className="card sc-unassigned" open={requestedKey ? true : undefined}>
    <summary><span><Code2 size={16} />历史参数待归属</span><span>{unassigned.length} 项 · 补齐所属服务</span></summary>
    <p>这些历史参数尚未指定所属服务。确认归属后，进入对应服务维护参数和标签。</p>
    {(requestedKey ? unassigned.filter(key => key === requestedKey) : unassigned).map(key => <ParameterClaim key={key} parameterKey={key} experiments={experiments} onClaimed={onClaimed} />)}
    {requestedKey && unassigned.length > 1 && <a className="sc-text-button" href="#applications">返回目录处理其他待归属参数<ArrowRight size={13} /></a>}
  </details>;
}

export default function ServiceCenter({ experiments, onOpen, embedded = false }: Props) {
  const [{ selectedId, tab, claimKey }, setRoute] = useState(readServiceRoute);
  const [environment, setEnvironment] = useState<ServiceEnvironment['name']>('development');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<ServiceType | 'all'>('all');
  const [registering, setRegistering] = useState(false);
  const [notice, setNotice] = useState('');
  const [, setRevision] = useState(0);
  const topology = getTopology();
  const catalog = getCatalog(topology);
  const selected = catalog.services.find(service => service.id === selectedId);
  const parameterKeys = (serviceId: string) => registeredParameters.filter(key => getParameterBinding(key, topology)?.serviceId === serviceId);
  const serviceExperiments = (keys: string[]) => experiments.filter(experiment => experiment.parameterKeys.some(key => keys.includes(key)));
  const keys = selected ? parameterKeys(selected.id) : [];
  const related = serviceExperiments(keys);
  const selectedEnvironment = selected?.environments.find(item => item.name === environment);
  const visible = catalog.services.filter(service => (typeFilter === 'all' || service.type === typeFilter) && `${service.id} ${service.name} ${service.owner} ${service.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    const read = () => { setRoute(readServiceRoute()); setNotice(''); };
    window.addEventListener('hashchange', read);
    window.addEventListener(APPLICATION_ROUTE_CHANGE_EVENT, read);
    return () => { window.removeEventListener('hashchange', read); window.removeEventListener(APPLICATION_ROUTE_CHANGE_EVENT, read); };
  }, []);
  const choose = (id: string) => { setRoute({ selectedId: id, tab: 'overview', claimKey: '' }); setNotice(''); window.location.hash = serviceHref(id); };
  const setTab = (next: DetailTab) => { setRoute({ selectedId, tab: next, claimKey: '' }); setNotice(''); window.location.hash = serviceHref(selectedId, next); };
  const refresh = (message: string) => { setRevision(value => value + 1); setNotice(message); };
  const tabKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % detailTabs.length;
    else if (event.key === 'ArrowLeft') next = (index + detailTabs.length - 1) % detailTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = detailTabs.length - 1;
    else return;
    event.preventDefault(); setTab(detailTabs[next].id); document.getElementById(`service-tab-${detailTabs[next].id}`)?.focus();
  };
  return <div className={`management-page sc-page ${embedded ? 'sc-embedded' : ''}`}>
    {!embedded && <div className="page-heading simple"><div><h1>应用管理</h1><p>统一管理应用 / 服务、所属参数与各环境接入配置。</p></div><div className="heading-actions"><button className="btn btn-primary" onClick={() => setRegistering(true)}><Plus size={16} />登记应用</button></div></div>}
    {embedded && selectedId && <div className="sc-embedded-toolbar"><a className="sc-back" href="#applications"><ArrowLeft size={14} />应用目录</a><button className="btn btn-primary btn-small" onClick={() => setRegistering(true)}><Plus size={14} />登记应用</button></div>}
    {notice && <p className="sc-notice" role="status"><Check size={16} />{notice}</p>}
    {!selectedId ? <>
      <section className="sc-summary" aria-label="应用目录概览"><div><Server size={19} /><span>已登记应用<strong>{catalog.services.length}<small> 个</small></strong></span></div><div><Code2 size={19} /><span>已绑定参数<strong>{registeredParameters.filter(key => getParameterBinding(key, topology)?.serviceId).length}<small> 个</small></strong></span></div><div><Clock3 size={19} /><span>接入验证<strong>待验证</strong></span></div><p>应用 / 服务归属定义参数由谁负责；层域定义参数在哪些流量中参与实验。两种关系分别管理。</p></section>
      {claimKey && <div className="sc-requested-parameter"><UnassignedParameters key={claimKey} requestedKey={claimKey} experiments={experiments} onClaimed={key => { setRevision(value => value + 1); window.location.hash = parameterHref(key); }} /></div>}
      <section className="card sc-catalog"><div className="sc-catalog-toolbar"><div><h2>应用目录</h2><span>{visible.length} 个应用 / 服务</span>{embedded && <button className="btn btn-primary btn-small sc-catalog-register" onClick={() => setRegistering(true)}><Plus size={14} />登记应用</button>}</div><div><label className="sc-search"><Search size={15} /><input aria-label="搜索应用" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索应用、标识或负责人" /></label><select aria-label="筛选应用类型" value={typeFilter} onChange={event => setTypeFilter(event.target.value as ServiceType | 'all')}><option value="all">全部类型</option>{serviceTypes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div></div>
        <div className="sc-service-grid">{visible.map(service => { const info = typeInfo(service.type), Icon = info.icon, serviceKeys = parameterKeys(service.id); return <button key={service.id} className="sc-service-card" onClick={() => choose(service.id)}><div className="sc-service-card-head"><span className={`sc-icon ${service.type}`}><Icon size={21} /></span><span className="sc-type-label">{info.label}</span><ArrowUpRight size={15} /></div><h3>{service.name}</h3><code>{service.id}</code><p>{service.description || info.note}</p><div className="sc-service-card-meta"><span>负责人 <strong>{service.owner}</strong></span><span><strong>{serviceKeys.length}</strong> 参数 · <strong>{serviceExperiments(serviceKeys).length}</strong> 实验</span></div><div className="sc-environment-pills">{service.environments.map(item => <span key={item.name}><i />{environmentNames[item.name]} · 待验证</span>)}</div></button>; })}</div>
        {!visible.length && <div className="sc-empty"><Search size={28} /><h3>没有匹配的应用</h3><p>调整关键词或类型筛选，也可以登记一个新应用。</p><button className="btn btn-small" onClick={() => { setQuery(''); setTypeFilter('all'); }}>清空筛选</button></div>}
      </section>
      {!claimKey && <UnassignedParameters requestedKey="" experiments={experiments} onClaimed={key => { setRevision(value => value + 1); window.location.hash = parameterHref(key); }} />}
      <div className="sc-note sc-catalog-note"><Info size={15} /><p>目录和接入模式均为本地配置。运行观测尚未接入真实服务，所有环境显示待验证。</p></div>
    </> : !selected ? <section className="card sc-empty"><Server size={30} /><h3>未找到该应用</h3><p>此应用标识未登记，或当前浏览器没有对应配置。</p><a className="btn" href="#applications"><ArrowLeft size={14} />返回应用目录</a></section> : <>
      {!embedded && <a className="sc-back" href="#applications"><ArrowLeft size={14} />应用目录</a>}
      <section className={`card sc-service-hero ${tab === 'parameters' ? 'sc-parameter-context' : ''}`}><div className="sc-hero-main"><span className={`sc-icon ${selected.type}`}>{(() => { const Icon = typeInfo(selected.type).icon; return <Icon size={25} />; })()}</span><div><div className="sc-hero-title"><h2>{selected.name}</h2><span className="sc-type-label">{typeInfo(selected.type).label}</span></div><code>{selected.id}</code><p>{selected.description || typeInfo(selected.type).note}</p></div><span className="sc-pending"><Clock3 size={13} />接入待验证</span></div><div className="sc-hero-meta"><span>负责人 <strong>{selected.owner}</strong></span><span>所属参数 <strong>{keys.length} 个</strong></span><span>关联实验 <strong>{related.length} 个</strong></span><span>环境 <strong>{selected.environments.length} 个</strong></span></div></section>
      <div className="sc-tabs" role="tablist" aria-label="应用详情">{detailTabs.map((item, index) => <button key={item.id} id={`service-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls="service-detail-panel" tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => tabKeyboard(event, index)}><item.icon size={15} />{item.label}{item.id === 'parameters' && <span>{keys.length}</span>}{item.id === 'experiments' && <span>{related.length}</span>}</button>)}</div>
      <div id="service-detail-panel" role="tabpanel" aria-labelledby={`service-tab-${tab}`}>
      {tab === 'overview' && <div className="sc-overview-grid"><section className="card"><header className="sc-section-heading"><div><h3>环境接入概览</h3><p>不同环境可以选择不同的决策方式。</p></div><button className="sc-text-button" onClick={() => setTab('integration')}>配置接入<ArrowRight size={13} /></button></header><div className="sc-environment-list">{selected.environments.map(item => <div key={item.name}><span className="sc-environment-symbol">{environmentNames[item.name][0]}</span><div><strong>{environmentNames[item.name]}环境</strong><p>{item.mode === 'direct' ? '应用直接决策' : `委托：${catalog.services.find(service => service.id === item.decisionServiceId)?.name ?? '决策服务未找到'}`}</p></div><span className="sc-pending"><Clock3 size={12} />待验证</span><button className="sc-icon-button" aria-label={`配置${environmentNames[item.name]}环境`} onClick={() => { setEnvironment(item.name); setTab('integration'); }}><ArrowUpRight size={15} /></button></div>)}</div></section><section className="card sc-boundaries"><header className="sc-section-heading"><div><h3>应用与实验的关系</h3><p>从参数引用推导关联，避免重复维护。</p></div><GitBranch size={18} /></header><div className="sc-section-body"><div className="sc-relationship-chain"><span><Server size={15} />服务</span><ArrowRight size={13} /><span><Code2 size={15} />参数</span><ArrowRight size={13} /><span><FlaskConical size={15} />实验</span></div><p>每个参数指定一个所属应用 / 服务，可添加多个标签；一个实验可引用多个应用 / 服务的参数，但仍须满足所属层的参数范围。</p><p>网关统一决策不会接管其他服务的参数所有权。层与域继续控制参数作用域和互斥流量。</p><button className="btn btn-small" onClick={() => setTab('parameters')}>查看本应用参数<ArrowRight size={13} /></button></div></section></div>}
      {tab === 'parameters' && <ParameterCenter key={selected.id} embedded serviceId={selected.id} experiments={experiments} onOpen={onOpen} />}
      {tab === 'integration' && <><div className="sc-environment-switch" aria-label="配置环境">{selected.environments.map(item => <button key={item.name} className={environment === item.name ? 'is-selected' : ''} aria-pressed={environment === item.name} onClick={() => { setEnvironment(item.name); setNotice(''); }}>{environmentNames[item.name]}环境<span>待验证</span></button>)}</div>{selectedEnvironment ? <EnvironmentConfiguration service={selected} environment={selectedEnvironment} services={catalog.services} experiments={experiments} onSaved={() => refresh(`${environmentNames[environment]}环境接入配置已保存；连接与运行状态仍待真实 SDK 验证。`)} /> : <div className="card sc-empty"><CircleAlert size={28} /><h3>未找到此环境配置</h3><p>请选择其他环境，或检查服务配置。</p></div>}</>}
      {tab === 'observations' && <section className="card sc-observations"><header className="sc-section-heading"><div><h3>运行观测</h3><p>以真实配置拉取、决策上下文和曝光事件确认接入完整性。</p></div><span className="sc-pending"><Clock3 size={12} />全部环境待验证</span></header><div className="sc-observation-metrics">{['最近配置同步', '决策请求量', '实际生效曝光', '错误与回退率'].map(label => <div key={label}><span>{label}</span><strong>—</strong><small>暂无真实数据</small></div>)}</div><div className="sc-empty"><Activity size={33} /><h3>尚未接收运行数据</h3><p>登记应用和保存接入配置不会产生连接记录。完成 SDK 接入后，才可确认以下链路。</p></div><div className="sc-validation-steps">{[{ title: '配置就绪', text: '已发布配置版本成功拉取或传递' }, { title: '决策一致', text: '统一身份与分流上下文经过校验' }, { title: '参数生效', text: '业务代码实际读取并应用参数' }, { title: '曝光可追踪', text: '曝光事件关联决策及配置版本' }].map((item, index) => <div key={item.title}><span>{index + 1}</span><div><strong>{item.title}</strong><p>{item.text}</p><small>待 SDK 验证</small></div></div>)}</div><footer>生产链路尚未接入；原型不提供手动设为“已连接”的操作。</footer></section>}
      {tab === 'experiments' && <section className="card"><header className="sc-section-heading"><div><h3>关联实验</h3><p>按实验引用的参数与本应用参数取交集，自动获得关联关系。</p></div><span className="sc-count">{related.length} 个实验</span></header>{!related.length ? <div className="sc-empty"><FlaskConical size={29} /><h3>暂无关联实验</h3><p>实验引用本服务的参数后，会自动出现在这里。</p></div> : <div className="sc-experiment-list">{related.map(experiment => <article key={experiment.id}><div><button className="sc-experiment-name" onClick={() => onOpen(experiment)}>{experiment.name}<ArrowUpRight size={14} /></button><p><code>{experiment.id}</code><span>负责人 · {experiment.owner}</span></p><div className="sc-experiment-keys">{experiment.parameterKeys.filter(key => keys.includes(key)).map(key => <a href={parameterHref(key, topology)} key={key}>{key}</a>)}</div></div><span className={`status-badge ${experiment.status}`}><i />{statusLabels[experiment.status]}</span></article>)}</div>}</section>}
      </div>
    </>}
    {registering && <ServiceRegistration experiments={experiments} onClose={() => setRegistering(false)} onSaved={id => { setRegistering(false); setRevision(value => value + 1); choose(id); }} />}
  </div>;
}
