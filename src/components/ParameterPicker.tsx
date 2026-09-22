import { useState } from 'react';
import { Check, Plus, Search, Tags } from 'lucide-react';
import type { Experiment } from '../data';
import { getParameterDefinition, getTopology, registeredParameters, saveTopology, isParameterPending } from '../traffic';
import { getCatalog, getParameterService, getParameterTags, getServiceTags, planParameterService } from '../service-catalog';
import './parameter-picker.css';

type Props = { allowedKeys: string[]; selectedKeys: string[]; onAdd: (keys: string[]) => boolean; existing: Experiment[] };

export default function ParameterPicker({ allowedKeys, selectedKeys, onAdd, existing }: Props) {
  const [query, setQuery] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  const [claimKey, setClaimKey] = useState<string | null>(null);
  const [claimServiceId, setClaimServiceId] = useState('');
  const [claimError, setClaimError] = useState('');
  const [claimNotice, setClaimNotice] = useState('');
  const topology = getTopology();
  const catalog = getCatalog(topology);
  const activeService = catalog.services.find(service => service.id === serviceId);
  const serviceTags = activeService ? getServiceTags(activeService.id, topology) : [];
  const activeTagIds = tagIds.filter(id => serviceTags.some(tag => tag.id === id));
  const candidates = registeredParameters.map(key => ({ key, awaitingLayer: isParameterPending(key, topology), definition: getParameterDefinition(key), service: getParameterService(key, topology), tags: getParameterTags(key, topology) }));
  const matching = candidates.filter(item => {
    if (query.trim() && !`${item.key} ${item.definition?.name ?? ''} ${item.service?.name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (serviceId === '__unassigned' ? Boolean(item.service) : serviceId && item.service?.id !== serviceId) return false;
    return !activeTagIds.length || item.tags.some(tag => activeTagIds.includes(tag.id));
  });
  const eligible = (item: typeof candidates[number]) => !item.awaitingLayer && allowedKeys.includes(item.key) && Boolean(item.service) && !selectedKeys.includes(item.key);
  const visibleEligibleKeys = matching.filter(eligible).map(item => item.key);
  const validPending = pendingKeys.filter(key => candidates.some(item => item.key === key && eligible(item)));
  const allVisibleSelected = visibleEligibleKeys.length > 0 && visibleEligibleKeys.every(key => validPending.includes(key));
  const append = (keys: string[]) => { if (keys.length && onAdd(keys)) setPendingKeys(old => old.filter(key => !keys.includes(key))); };
  const openClaim = (key: string) => {
    setClaimKey(old => old === key ? null : key);
    setClaimServiceId(''); setClaimError(''); setClaimNotice('');
  };
  const confirmClaim = (key: string) => {
    if (!claimServiceId) { setClaimError('请选择已登记的所属服务。'); return; }
    const planned = planParameterService(key, claimServiceId, getTopology());
    if (planned.error || !planned.topology) { setClaimError(planned.error ?? '服务归属配置无效。'); return; }
    const error = saveTopology(planned.topology, existing);
    if (error) { setClaimError(error); return; }
    setClaimNotice(`${key} 已归属「${getParameterService(key, getTopology())?.name ?? claimServiceId}」。仅更新参数目录，未增删实验参数或修改各分组参数值。`);
    setClaimKey(null); setClaimServiceId(''); setClaimError('');
  };
  return <section className="pp-picker" aria-label="选择实验参数">
    <div className="pp-heading"><div><h3>选择实验参数</h3><p>按应用与标签查找，批量加入当前层允许的参数。</p></div><span>{selectedKeys.length} 个已加入</span></div>
    <div className="pp-filters"><label className="pp-search"><Search size={14} /><input aria-label="搜索实验参数" placeholder="搜索 Key、参数名或服务" value={query} onChange={event => setQuery(event.target.value)} /></label><select className="select" aria-label="按应用筛选参数" value={serviceId} onChange={event => { setServiceId(event.target.value); setTagIds([]); setClaimKey(null); setClaimServiceId(''); setClaimError(''); }}><option value="">全部应用</option>{catalog.services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}<option value="__unassigned">待归属服务</option></select></div>
    <div className="pp-tag-filter" aria-label="当前应用标签筛选"><span><Tags size={12} />{activeService ? `${activeService.name}的标签` : '应用标签'}</span>{activeService ? <><button type="button" aria-pressed={activeTagIds.length === 0} className={!activeTagIds.length ? 'active' : ''} onClick={() => setTagIds([])}>全部</button>{serviceTags.map(tag => <button key={tag.id} type="button" className={activeTagIds.includes(tag.id) ? 'active' : ''} aria-pressed={activeTagIds.includes(tag.id)} onClick={() => setTagIds(old => old.includes(tag.id) ? old.filter(id => id !== tag.id) : [...old, tag.id])}>{tag.name}</button>)}{!serviceTags.length && <small>当前应用尚未创建标签</small>}</> : <small>{serviceId === '__unassigned' ? '先补齐参数所属应用，再维护该应用的标签。' : '选择一个应用后，查看和筛选该应用的标签。'}</small>}</div>
    {claimNotice && <p className="pp-claim-notice" role="status"><Check size={13} />{claimNotice}</p>}
    <div className="pp-list-meta"><span>{matching.length} 个结果 · 应用内多标签满足任一</span><button type="button" disabled={!visibleEligibleKeys.length} onClick={() => setPendingKeys(old => allVisibleSelected ? old.filter(key => !visibleEligibleKeys.includes(key)) : [...new Set([...old, ...visibleEligibleKeys])])}>{allVisibleSelected ? '取消选择当前结果' : '选择当前可加入项'}</button></div>
    <div className="pp-results">{matching.length ? matching.map(item => {
      const added = selectedKeys.includes(item.key);
      const inLayer = allowedKeys.includes(item.key);
      const canSelect = eligible(item);
      const reason = item.awaitingLayer ? '待归层，分配后可用于实验' : added ? '已加入实验' : !inLayer ? '超出当前层参数范围' : !item.service ? '待补充服务归属' : '';
      return <div key={item.key} className={`pp-result ${added ? 'is-added' : !canSelect ? 'is-disabled' : ''}`}>
        <div className="pp-result-main">
        <label className="pp-select-row"><input type="checkbox" aria-label={`选择参数 ${item.key}`} checked={added || validPending.includes(item.key)} disabled={!canSelect} onChange={event => setPendingKeys(old => event.target.checked ? [...new Set([...old, item.key])] : old.filter(key => key !== item.key))} /><span className="pp-parameter-info"><span><code>{item.key}</code>{item.definition?.name && <small>{item.definition.name}</small>}</span><span className="pp-parameter-meta">{item.service ? `${item.service.name} · ${item.service.owner}` : '待归属服务'}{activeService && item.service?.id === activeService.id && item.tags.map(tag => <i key={tag.id}>{tag.name}</i>)}</span></span></label>
        <div className="pp-row-state">{item.awaitingLayer ? <small className="pp-awaiting-layer">{reason}</small> : added ? <span><Check size={12} />已加入</span> : reason && <small>{reason}</small>}{!item.service && <button type="button" aria-label={`补充 ${item.key} 的服务归属`} aria-expanded={claimKey === item.key} aria-controls={`pp-claim-${item.key}`} onClick={() => openClaim(item.key)}>{claimKey === item.key ? '收起' : '补充服务归属'}</button>}</div>
        </div>
        {!item.service && claimKey === item.key && <div className="pp-claim-form" id={`pp-claim-${item.key}`} role="group" aria-label={`${item.key} 服务归属`}>
          <label>所属服务<select className="select" aria-label={`为 ${item.key} 选择所属服务`} value={claimServiceId} onChange={event => { setClaimServiceId(event.target.value); setClaimError(''); }}><option value="">请选择已登记服务</option>{catalog.services.map(service => <option key={service.id} value={service.id}>{service.name} · {service.owner}</option>)}</select></label>
          <div className="pp-claim-actions"><button type="button" className="btn" onClick={() => { setClaimKey(null); setClaimError(''); }}>取消</button><button type="button" className="btn btn-primary" onClick={() => confirmClaim(item.key)}>确认服务归属</button></div>
          <p>仅补齐历史参数的服务归属。确认后可在本页继续选择参数，不会自动加入实验。</p>
          {claimError && <span className="pp-claim-error" role="alert">{claimError}</span>}
        </div>}
      </div>;
    }) : <div className="pp-empty">没有符合当前条件的参数。<button type="button" onClick={() => { setQuery(''); setServiceId(''); setTagIds([]); }}>清除筛选</button></div>}</div>
    <div className="pp-footer"><span>{validPending.length ? `已选择 ${validPending.length} 个待加入参数 · ${new Set(candidates.filter(item => validPending.includes(item.key)).map(item => item.service?.id)).size} 个应用` : '仅可选取当前层内、已归层且已归属服务的参数'}</span><button type="button" className="btn btn-primary" disabled={!validPending.length} onClick={() => append(validPending)}><Plus size={14} />批量加入{validPending.length ? ` ${validPending.length} 个参数` : ''}</button></div>
    <p className="pp-note">可依次切换应用选择参数，待加入项会保留；标签只在所属应用内生效。加入时按登记默认值补入所有分组并保留已填写值，实验保存固定参数 Key。</p>
  </section>;
}
