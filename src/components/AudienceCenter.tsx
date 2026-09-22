import { useEffect, useState } from 'react';
import { Check, CircleAlert, CopyPlus, Database, Filter, GitBranch, Layers3, LockKeyhole, Plus, Search, Users } from 'lucide-react';
import type { Experiment } from '../data';
import { audienceCondition, audienceRuleCount, audienceSummary, getAudiences } from '../audiences';
import type { AudienceDefinition } from '../audiences';
import { getTopology } from '../traffic';
import { audienceUsage, parseAudienceRoute } from '../audience-management';
import AudienceEditor from './AudienceEditor';
import ProfileAttributeCenter from './ProfileAttributeCenter';
import AudienceReferenceList from './AudienceReferenceList';
import './experiment-flow.css';
import './audience-management.css';

type Props = { experiments: Experiment[]; onOpen: (experiment: Experiment) => void };
export default function AudienceCenter({ experiments }: Props) {
  const topology = getTopology(), catalog = getAudiences(topology);
  const [route, setRoute] = useState(() => parseAudienceRoute(location.hash));
  const [selectedId, setSelectedId] = useState('new-users-v1');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<'new' | AudienceDefinition | null>(null);
  const [creatingAttribute, setCreatingAttribute] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const update = () => setRoute(parseAudienceRoute(location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (route.tab === 'audiences' && route.id && catalog.some(item => item.id === route.id)) setSelectedId(route.id);
  }, [route, catalog]);
  const requestedId = route.tab === 'audiences' ? route.id : null;
  const selected = requestedId ? catalog.find(item => item.id === requestedId) : catalog.find(item => item.id === selectedId) ?? catalog[0];
  const summary = (audience: AudienceDefinition) => audienceSummary(audienceCondition(audience, topology));
  const visible = catalog.filter(item => `${item.name} ${item.owner} ${item.description} ${summary(item)}`.toLowerCase().includes(query.toLowerCase().trim()));
  const usage = selected ? audienceUsage(selected.id,topology,experiments) : null;
  const choose = (id:string) => { setSelectedId(id); location.hash = `audiences/${encodeURIComponent(id)}`; };

  return <div className="management-page aud-page">
    <div className="page-heading simple"><div><h1>受众管理</h1><p>维护画像属性，组合人群条件，按固定版本用于域与实验。</p></div><button className="btn btn-primary" onClick={() => route.tab === 'attributes' ? setCreatingAttribute(true) : setEditor('new')}><Plus size={16}/>{route.tab === 'attributes' ? '登记画像属性' : '新建受众'}</button></div>
    <nav className="aud-page-tabs" aria-label="受众管理子页面"><a className={route.tab === 'audiences' ? 'active' : ''} aria-current={route.tab === 'audiences' ? 'page' : undefined} href="#audiences"><Users size={15}/>受众列表<span>{catalog.length}</span></a><a className={route.tab === 'attributes' ? 'active' : ''} aria-current={route.tab === 'attributes' ? 'page' : undefined} href="#audiences/attributes"><Database size={15}/>画像属性</a></nav>
    {route.invalid && <div className="aud-not-found" role="alert"><CircleAlert size={19}/><div><strong>受众管理地址无效</strong><p>请从上方页签返回列表。</p></div></div>}
    <div hidden={route.tab !== 'audiences' || route.invalid}>
      <div className="aud-model-strip"><div><GitBranch size={18}/><div><strong>域 · 隔离与复用</strong><p>划分随机流量，可限制共同的准入人群。</p></div></div><div><Filter size={18}/><div><strong>受众 · 条件组合</strong><p>支持全部／任一满足，与祖先域条件取交集。</p></div></div><div><Layers3 size={18}/><div><strong>同桶复用 · 证明互斥</strong><p>人群允许重叠；共享桶时须证明完整条件互斥。</p></div></div></div>
      {notice && <p className="aud-notice" role="status"><Check size={15}/>{notice}</p>}
      <div className="aud-toolbar"><label className="search-field"><Search size={14}/><input aria-label="搜索受众规则" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、负责人或条件…"/></label><span>{catalog.length} 个固定版本 · 规模数据未接入</span></div>
      <div className="aud-workbench"><section className="card aud-directory"><header><strong>受众规则</strong><small>{visible.length} 个版本</small></header><nav aria-label="受众版本列表">{visible.map(audience => <button key={audience.id} className={`aud-item ${selected?.id === audience.id ? 'is-selected' : ''}`} aria-pressed={selected?.id === audience.id} onClick={() => choose(audience.id)}><Users size={16}/><span><strong>{audience.name}</strong><small>{audienceRuleCount(audience) ? `${audienceRuleCount(audience)} 条条件` : '继承基础资格'} · {audience.owner}</small></span><b>v{audience.version}</b></button>)}</nav>{!visible.length && <p className="empty-state">暂无匹配的受众规则</p>}</section>
        {selected && usage ? <div className="aud-detail"><section className="card aud-hero"><div className="aud-hero-head"><div><span className="aud-overline">AUDIENCE · FIXED VERSION</span><h2>{selected.name}</h2><p>{selected.description || '暂无说明'}</p></div><button className="btn btn-small" onClick={() => setEditor(selected)}><CopyPlus size={13}/>创建新版本</button></div><div className="aud-hero-meta"><span>版本 v{selected.version}</span><span>负责人 {selected.owner}</span><span>{new Date(selected.createdAt).toLocaleDateString('zh-CN')}</span></div><div className="aud-expression-summary"><Filter size={15}/><p>{summary(selected)}</p></div><p>条件组按括号关系计算；符合资格后，还需命中域和实验的桶段。</p><div className="aud-version-note"><LockKeyhole size={13}/><span>引用固定到 v{selected.version}。创建新版本不会修改已有引用；资格使用同一用户的首次入组画像。</span></div></section>
          <section className="card"><h3>当前版本的引用</h3><p>查看引用实验将打开实验列表，并按当前固定版本筛选，包含祖先域继承。域引用可查看具体条件；新版本不会替换已有引用。</p><AudienceReferenceList domains={usage.domains} experiments={usage.experiments} topology={topology} context={{audienceId:selected.id}}/></section>
        </div> : <div className="card aud-not-found" role="status"><CircleAlert size={19}/><div><strong>未找到受众版本</strong><p>此地址的版本不存在。请选择左侧已有受众。</p></div></div>}
      </div>
    </div>
    <div hidden={route.tab !== 'attributes' || route.invalid}><ProfileAttributeCenter experiments={experiments} routeId={route.tab === 'attributes' ? route.id : null} creating={creatingAttribute} onCloseCreate={() => setCreatingAttribute(false)}/></div>
    {editor && <AudienceEditor source={editor === 'new' ? undefined : editor} experiments={experiments} onClose={() => setEditor(null)} onSaved={id => { setEditor(null); setQuery(''); choose(id); setNotice('受众版本已保存，可在创建域或实验时选择。'); }}/>} 
  </div>;
}
