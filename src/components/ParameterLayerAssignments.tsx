import { GitBranch, Layers3, LockKeyhole } from 'lucide-react';
import type { RegistrationAssignment } from '../parameter-registration';
import './register-parameter.css';

type Props = {
  rows: RegistrationAssignment[];
  onChange: (domainId: string, layerId: string) => void;
  idPrefix: string;
};

export default function ParameterLayerAssignments({ rows, onChange, idPrefix }: Props) {
  return <div className="rp-assignment-list">
    {rows.map(row => <div key={row.domainId} className={`rp-assignment ${row.automatic || row.forced ? 'is-automatic' : ''}`}>
      <div className="rp-assignment-domain"><GitBranch size={15} /><div><strong>{row.domainName}</strong><small>{row.path}</small></div>{(row.automatic || row.forced) && <span className="rp-auto-badge"><LockKeyhole size={10} />{row.forced ? '新层路径' : '唯一层'}</span>}</div>
      {row.automatic || row.forced ? <div className="rp-automatic-layer"><Layers3 size={13} /><span>{row.layerName}</span></div> : <label className="rp-layer-field" htmlFor={`${idPrefix}-${row.domainId}`}><span>归属层 <span className="ef-required">*</span></span><select id={`${idPrefix}-${row.domainId}`} aria-label={`参数在${row.domainName}的归属层`} value={row.layerId ?? ''} onChange={event => onChange(row.domainId, event.target.value)} required><option value="">请选择本域中的一个层</option>{row.options.map(layer => <option key={layer.id} value={layer.id}>{layer.name}{!layer.parameterKeys.length ? ' · 待配置' : ''}</option>)}</select></label>}
    </div>)}
  </div>;
}
