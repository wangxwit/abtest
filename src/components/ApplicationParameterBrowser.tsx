import { useId, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight, Search, Server, Tags } from 'lucide-react';
import { getParameterDefinition, getTopology, isParameterPending, subscribeTopology } from '../traffic';
import { getCatalog, getParameterService, getParameterTags, getServiceTags } from '../service-catalog';
import { parameterHref, serviceHref } from '../application-routes';
import './application-parameter-browser.css';

type Props = {
  parameterKeys: string[];
  label: string;
  selection?: {
    selectedKeys: string[];
    onChange: (key: string, checked: boolean) => void;
    disabledReason?: (key: string) => string | null | undefined;
  };
  renderState?: (key: string) => ReactNode;
  emptyMessage?: string;
  allowNavigation?: boolean;
};

/** Browses only the supplied layer/domain scope; filters never change its keys or ownership. */
export default function ApplicationParameterBrowser({ parameterKeys, label, selection, renderState, emptyMessage, allowNavigation = true }: Props) {
  const topology = useSyncExternalStore(subscribeTopology, getTopology, getTopology);
  const id = useId();
  const [query, setQuery] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const catalog = getCatalog(topology);
  const service = catalog.services.find(item => item.id === serviceId);
  const serviceTags = service ? getServiceTags(service.id, topology) : [];
  const activeTagIds = tagIds.filter(tagId => serviceTags.some(tag => tag.id === tagId));
  const candidates = [...new Set(parameterKeys)].map(key => ({
    key, definition: getParameterDefinition(key, topology), service: getParameterService(key, topology),
    tags: getParameterTags(key, topology), pending: isParameterPending(key, topology),
  }));
  const matching = candidates.filter(item => {
    if (serviceId === '__unassigned' ? Boolean(item.service) : serviceId && item.service?.id !== serviceId) return false;
    if (activeTagIds.length && !item.tags.some(tag => activeTagIds.includes(tag.id))) return false;
    return !query.trim() || `${item.key} ${item.definition?.name ?? ''} ${item.service?.name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
  });
  const groups = [...catalog.services.map(item => ({ id: item.id, name: item.name, service: item })), { id: '__unassigned', name: '待归属应用', service: undefined }]
    .map(group => ({ ...group, items: matching.filter(item => (item.service?.id ?? '__unassigned') === group.id) }))
    .filter(group => group.items.length);
  const selectable = selection ? matching.filter(item => !selection.disabledReason?.(item.key)) : [];
  const allSelected = selectable.length > 0 && selectable.every(item => selection?.selectedKeys.includes(item.key));
  const selectedItems = selection ? candidates.filter(item => selection.selectedKeys.includes(item.key)) : [];
  const selectedApps = new Set(selectedItems.flatMap(item => item.service ? [item.service.id] : [])).size;
  const clear = () => { setQuery(''); setServiceId(''); setTagIds([]); };
  return <section className="apb-browser" aria-label={label}>
    <div className="apb-filters">
      <label className="apb-app">应用／服务<select aria-label={`${label}：应用筛选`} value={serviceId} onChange={event => { setServiceId(event.target.value); setTagIds([]); }}>
        <option value="">全部应用</option>
        {catalog.services.map(item => <option key={item.id} value={item.id}>{item.name} · {candidates.filter(candidate => candidate.service?.id === item.id).length}</option>)}
        {candidates.some(item => !item.service) && <option value="__unassigned">待归属应用</option>}
      </select></label>
      <label className="apb-search"><Search size={14} /><input aria-label={`${label}：搜索参数`} placeholder="搜索 Key、参数名或应用" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>
    <div className="apb-tags" aria-label={`${label}：当前应用标签`}><span><Tags size={12} />{service ? `${service.name}的标签` : '应用标签'}</span>
      {service ? <><button type="button" className={!activeTagIds.length ? 'active' : ''} aria-pressed={!activeTagIds.length} onClick={() => setTagIds([])}>全部标签</button>{serviceTags.map(tag => <button type="button" key={tag.id} className={activeTagIds.includes(tag.id) ? 'active' : ''} aria-pressed={activeTagIds.includes(tag.id)} onClick={() => setTagIds(old => old.includes(tag.id) ? old.filter(value => value !== tag.id) : [...old, tag.id])}>{tag.name}</button>)}{!serviceTags.length && <small>当前应用暂无标签</small>}</> : <small>{serviceId === '__unassigned' ? '历史参数尚未归属应用，可在应用管理补齐。' : '选择应用后，可使用该应用的标签筛选。'}</small>}
    </div>
    <div className="apb-result-summary"><span>当前范围 {candidates.length} 项 · 筛选结果 {matching.length} 项{activeTagIds.length > 0 && ' · 标签满足任一'}</span>{selection && <button type="button" disabled={!selectable.length} onClick={() => selectable.forEach(item => selection.onChange(item.key, !allSelected))}>{allSelected ? '取消选择当前可选项' : '选择当前可选项'}</button>}</div>
    <div className="apb-results">{groups.map(group => <div className="apb-group" key={group.id}>
      <div className="apb-group-heading"><Server size={13} />{group.service && !selection && allowNavigation ? <a href={serviceHref(group.id, 'parameters')}>{group.name}<ArrowUpRight size={11} /></a> : <strong>{group.name}</strong>}<span>{group.items.length} 个参数</span></div>
      {group.items.map(item => {
        const reason = selection?.disabledReason?.(item.key);
        const reasonId = `${id}-${item.key}-reason`;
        const identity = <span className="apb-identity"><code>{item.key}</code><span>{item.definition?.name ?? '内置演示参数'}{item.definition && <small>{item.definition.type}</small>}</span></span>;
        return <div key={item.key} className={`apb-row ${reason ? 'is-disabled' : ''} ${selection?.selectedKeys.includes(item.key) ? 'is-selected' : ''}`}>
          <div className="apb-parameter">
            {selection ? <label><input type="checkbox" aria-label={`选择参数 ${item.key}`} aria-describedby={reason ? reasonId : undefined} disabled={Boolean(reason)} checked={selection.selectedKeys.includes(item.key)} onChange={event => selection.onChange(item.key, event.target.checked)} />{identity}</label> : allowNavigation ? <a href={parameterHref(item.key, topology)} aria-label={`在${item.service?.name ?? '待归属应用'}中查看参数 ${item.key}`}>{identity}<ArrowUpRight size={12} /></a> : <div className="apb-readonly">{identity}</div>}
            {service && item.service?.id === service.id && item.tags.length > 0 && <div className="apb-row-tags">{item.tags.map(tag => <span key={tag.id}>{tag.name}</span>)}</div>}
          </div>
          <div className="apb-state">{renderState ? renderState(item.key) : <span>{item.pending ? '待归层' : '已归层'}</span>}{reason && <small id={reasonId}>{reason}</small>}</div>
        </div>;
      })}
    </div>)}</div>
    {!matching.length && <div className="apb-empty" role="status"><span>{candidates.length ? '当前范围内没有符合筛选条件的参数。' : emptyMessage ?? '当前范围尚未关联参数。'}</span>{(query || serviceId || activeTagIds.length > 0) && <button type="button" onClick={clear}>清除筛选</button>}</div>}
    {selection && <div className="apb-selection-summary">已选择 {selectedItems.length} 个参数 · {selectedApps} 个应用{selectedItems.some(item => !item.service) && ' · 含历史待归属参数'}<span>切换应用和标签保留已选参数。</span></div>}
  </section>;
}
