import { useState } from 'react';
import { validateResourceManagement, type ResourceManagement } from '../resource-management';
import './resource-management.css';

type Props = {
  value: ResourceManagement;
  onChange: (value: ResourceManagement) => void;
  idPrefix: string;
  showErrors?: boolean;
  hideLegend?: boolean;
};

export default function ResourceManagementFields({ value, onChange, idPrefix, showErrors = false, hideLegend = false }: Props) {
  const [touched, setTouched] = useState(false);
  const error = (showErrors || touched) ? validateResourceManagement(value) : null;
  const ownerInvalid = Boolean(error && (!value.owner.trim() || value.owner.trim().length > 40));
  const errorId = `${idPrefix}-management-error`;
  return <fieldset className="rm-fields" aria-describedby={error ? errorId : undefined}>
    <legend className={hideLegend ? 'rm-visually-hidden' : undefined}>管理信息</legend>
    <div className="rm-field-grid">
      <label className="rm-field" htmlFor={`${idPrefix}-owner`}><span>负责人 <small>必填</small></span>
        <input id={`${idPrefix}-owner`} className="input" value={value.owner} maxLength={40} required aria-invalid={ownerInvalid || undefined} aria-describedby={ownerInvalid ? errorId : undefined} placeholder="填写负责人姓名" onBlur={() => setTouched(true)} onChange={event => onChange({ ...value, owner: event.target.value })} />
      </label>
      <label className="rm-field" htmlFor={`${idPrefix}-usage`}><span>使用期限</span>
        <select id={`${idPrefix}-usage`} className="select" value={value.usageType} onChange={event => {
          const usageType = event.target.value as ResourceManagement['usageType'];
          onChange(usageType === 'long-term' ? { owner: value.owner, usageType } : { ...value, usageType });
        }}><option value="long-term">长期</option><option value="temporary">临时</option></select>
      </label>
      {value.usageType === 'temporary' && <label className="rm-field" htmlFor={`${idPrefix}-end-date`}><span>预计结束日期 <small>必填</small></span>
        <input id={`${idPrefix}-end-date`} type="date" className="input" value={value.expectedEndDate ?? ''} required aria-invalid={Boolean(error && !ownerInvalid) || undefined} aria-describedby={error && !ownerInvalid ? errorId : undefined} onBlur={() => setTouched(true)} onChange={event => onChange({ ...value, expectedEndDate: event.target.value })} />
      </label>}
    </div>
    {value.usageType === 'temporary' && <p className="rm-helper">预计结束日期用于管理提醒，到期后仍可正常使用。</p>}
    {error && <p className="rm-error" id={errorId} role="alert">{error}</p>}
  </fieldset>;
}
