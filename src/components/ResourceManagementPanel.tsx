import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarClock, Check, Pencil } from 'lucide-react';
import type { Experiment } from '../data';
import { getTopology, saveTopology, type TrafficDomain, type TrafficLayer } from '../traffic';
import { defaultResourceManagement, localDateString, planResourceManagementUpdate, resourceDueStatus, validateResourceManagement, type ResourceManagement } from '../resource-management';
import ResourceManagementFields from './ResourceManagementFields';
import './resource-management.css';

export default function ResourceManagementPanel({ kind, node, experiments }: {
  kind: 'domain' | 'layer'; node: TrafficDomain | TrafficLayer; experiments: Experiment[];
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<ResourceManagement>(() => ({ ...(node.management ?? defaultResourceManagement()) }));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [today, setToday] = useState(localDateString);
  const formRef = useRef<HTMLFormElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const due = resourceDueStatus(node.management, today);
  const temporary = node.management?.usageType === 'temporary';
  const idPrefix = `resource-${kind}-${node.id}`;

  useEffect(() => {
    const refreshDate = () => setToday(localDateString());
    const timer = window.setInterval(refreshDate, 60_000);
    window.addEventListener('focus', refreshDate);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refreshDate); };
  }, []);
  useEffect(() => { if (editing) formRef.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [editing]);

  const finishEdit = () => {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const planned = planResourceManagementUpdate(kind, node.id, value, getTopology());
    if (!planned.topology) {
      setError(planned.error ?? '管理信息保存失败，请检查后重试。');
      formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    const invalid = saveTopology(planned.topology, experiments);
    if (invalid) { setError(invalid); return; }
    setError(''); setSaved(true); finishEdit();
  };

  return <section className="card rm-panel" aria-labelledby={`${idPrefix}-title`}>
    <header className="rm-panel-header"><h3 id={`${idPrefix}-title`}>管理信息</h3>
      {!editing && <button className="btn btn-small" ref={editButtonRef} aria-label={`编辑${node.name}的管理信息`} onClick={() => {
        setValue({ ...(node.management ?? defaultResourceManagement()) }); setError(''); setSaved(false); setEditing(true);
      }}><Pencil size={12} />{node.management ? '编辑' : '补充信息'}</button>}
    </header>
    {editing ? <form ref={formRef} onSubmit={submit} noValidate>
      <ResourceManagementFields value={value} onChange={next => { setValue(next); setError(''); }} idPrefix={idPrefix} showErrors hideLegend />
      {error && error !== validateResourceManagement(value) && <p className="rm-error" role="alert">{error}</p>}
      <div className="rm-actions"><button className="btn btn-small" type="button" onClick={() => { setError(''); finishEdit(); }}>取消</button><button className="btn btn-primary btn-small" type="submit">保存管理信息</button></div>
    </form> : <>
      <dl className="rm-summary"><div><dt>负责人</dt><dd>{node.management?.owner || <span className="rm-unset">未设置</span>}</dd></div><div><dt>使用期限</dt><dd>{node.management ? temporary ? '临时' : '长期' : <span className="rm-unset">未设置</span>}</dd></div><div><dt>预计结束日期</dt><dd>{temporary ? node.management?.expectedEndDate : '—'}{(due === 'overdue' || due === 'due-today') && <span className={`rm-due-badge ${due}`}><CalendarClock size={12} />{due === 'overdue' ? '已超期' : '今日到期'}</span>}</dd></div></dl>
      {temporary && <p className="rm-helper">{due === 'overdue' ? '已超过预计结束日期，可根据实际进展调整。' : '预计结束日期用于管理提醒。'}到期不影响实验运行或流量分配。</p>}
      {saved && <p className="rm-saved" role="status"><Check size={13} />管理信息已保存</p>}
    </>}
  </section>;
}
