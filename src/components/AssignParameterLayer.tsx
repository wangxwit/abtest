import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, CircleAlert, Info, Layers3, X } from 'lucide-react';
import type { Experiment } from '../data';
import { planParameterLayerAssignment, registrationAssignments } from '../parameter-registration';
import { getParameterDefinition, getTopology, isParameterPending, saveTopology } from '../traffic';
import { getParameterService } from '../service-catalog';
import ParameterLayerAssignments from './ParameterLayerAssignments';
import './experiment-flow.css';
import './register-parameter.css';

type Props = { parameterKey: string; experiments: Experiment[]; onClose: () => void; onAssigned: () => void };

export default function AssignParameterLayer({ parameterKey, experiments, onClose, onAssigned }: Props) {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const dialog = useRef<HTMLFormElement>(null);
  const errorBox = useRef<HTMLParagraphElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const topology = getTopology();
  const definition = getParameterDefinition(parameterKey, topology);
  const service = getParameterService(parameterKey, topology);
  const assignments = registrationAssignments(selections, topology);
  const complete = assignments.length > 0 && assignments.every(row => row.layerId);
  const preview = complete ? planParameterLayerAssignment(parameterKey, selections, experiments, topology) : null;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (dialog.current?.querySelector<HTMLElement>('select') ?? dialog.current)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { if (error) errorBox.current?.focus(); }, [error]);

  function choose(domainId: string, layerId: string) {
    const updated = { ...selections, [domainId]: layerId };
    const visible = new Set(registrationAssignments(updated, getTopology()).map(row => row.domainId));
    setSelections(Object.fromEntries(Object.entries(updated).filter(([id]) => visible.has(id))));
    setError('');
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const planned = planParameterLayerAssignment(parameterKey, selections, experiments, getTopology());
    if (planned.error || !planned.topology) { setError(planned.error ?? '无法分配参数，请检查归属层。'); return; }
    const invalid = saveTopology(planned.topology, experiments);
    if (invalid) { setError(invalid); return; }
    onAssigned();
  }

  return <div className="ef-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="ef-modal rp-modal" ref={dialog} tabIndex={-1} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="assign-parameter-title" aria-describedby="assign-parameter-subtitle" noValidate>
      <div className="ef-modal-head"><span className="ef-heading-icon"><Layers3 size={22} /></span><div><h2 id="assign-parameter-title">分配到层</h2><p id="assign-parameter-subtitle">{service?.name ?? '所属应用'} · {definition?.name ?? parameterKey}</p></div><button type="button" className="ef-icon-button" aria-label="关闭参数归层" onClick={onClose}><X size={19} /></button></div>
      <div className="ef-modal-body">
        <div className="ef-inline-note"><Info size={16} /><span><code>{parameterKey}</code> 已登记。为每个继承此参数的域选择一个层，全部分配会一次保存。</span></div>
        <section className="rp-assignments" aria-label="首次参数归层"><div className="rp-section-heading"><h3>层域归属</h3><small>{assignments.filter(row => row.layerId).length} / {assignments.length} 个域已选择</small></div><p className="rp-assignment-hint">同一域内只归属一个层。选择有子域的层后，继续设置下级归属；互斥分支分别配置。尚未建层时，可先前往层域管理创建一个待配置层。</p><ParameterLayerAssignments rows={assignments} onChange={choose} idPrefix="assign-parameter-layer" /></section>
        {(error || preview?.error) && <p ref={errorBox} tabIndex={-1} className="rp-warning" role="alert"><CircleAlert size={16} /><span>{error || preview?.error}</span></p>}
        <div className="ef-inline-note"><Info size={16} /><span>完成归层后，参数可用于对应层的新实验。已有实验的参数值及分桶保持不变。</span></div>
      </div>
      <div className="ef-modal-footer rp-footer"><span>{complete ? '所有继承分支已选择' : '请补齐各域的归属层'}</span><div><button type="button" className="btn" onClick={onClose}>取消</button><button type="submit" className="btn btn-primary" disabled={!complete || !isParameterPending(parameterKey, topology) || Boolean(preview?.error)}>保存归层 <ArrowRight size={14} /></button></div></div>
    </form>
  </div>;
}
