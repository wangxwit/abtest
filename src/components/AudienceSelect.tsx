import { useState } from 'react';
import { Plus } from 'lucide-react';
import { getAudiences, getAudience, describeExpression, getAudienceExpression, type EffectiveAudience } from '../audiences';
import type { Experiment } from '../data';
import { getTopology } from '../traffic';
import AudienceEditor from './AudienceEditor';
import type { AudienceAllocationContext } from '../audience-preflight';
import './audience-management.css';
import './audience-editor.css';

type Props = { value: string; onChange: (id: string) => void; label?: string; id?: string; inheritedLabel?: string; inheritedCondition?: EffectiveAudience; experiments?: Experiment[]; allocation?: AudienceAllocationContext };

export default function AudienceSelect({ value, onChange, label = '目标受众', id, inheritedLabel, inheritedCondition, experiments, allocation }: Props) {
  const [editing, setEditing] = useState(false);
  const topology = getTopology(), audiences = getAudiences(topology), selected = value ? getAudience(value, topology) : null;
  return <div className="aud-select"><div className="aud-select-editor-row"><label className="ef-field">{label}<select id={id} className="select" aria-label={label} value={value} onChange={event => onChange(event.target.value)}><option value="">继承上级受众，不追加限制</option>{value && !selected && <option value={value}>不可用的受众版本 · {value}</option>}{audiences.map(audience => <option key={audience.id} value={audience.id}>{audience.name} · v{audience.version}</option>)}</select></label>{experiments && <button type="button" className="btn" onClick={() => setEditing(true)}><Plus size={14}/>新建受众</button>}</div><div className="aud-select-summary">{inheritedLabel && <p><span>继承条件</span>{inheritedLabel}</p>}<p><span>追加条件</span>{selected ? describeExpression(getAudienceExpression(selected), topology) : value ? '受众版本不存在，无法分配' : '无额外限制'}</p></div><p className="ef-helper">条件与上级取交集，按固定入组资格快照判断。{experiments ? '可在当前配置中创建受众，保存后自动选择；取消不会改变已填写内容。' : <>受众版本固定；<a href="#audiences">管理受众规则</a>。</>}</p>{editing && experiments && <AudienceEditor experiments={experiments} inheritedCondition={inheritedCondition} allocation={allocation} onClose={() => setEditing(false)} onSaved={id => { onChange(id); setEditing(false); }}/>}</div>;
}
