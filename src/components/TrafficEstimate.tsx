import { useState } from 'react';
import { Calculator, ChevronDown } from 'lucide-react';
import { formatPercent } from '../format-percent';
import './audience-management.css';

export default function TrafficEstimate({ nominalPercent, audienceLabel }: { nominalPercent: number; audienceLabel?: string }) {
  const [base, setBase] = useState('1000000');
  const [rate, setRate] = useState('');
  const baseValue = Number(base), rateValue = Number(rate);
  const validBase = base.trim() !== '' && Number.isSafeInteger(baseValue) && baseValue >= 0 && baseValue <= 1e12;
  const validRate = rate.trim() !== '' && Number.isFinite(rateValue) && rateValue >= 0 && rateValue <= 100;
  const nominal = validBase ? baseValue * nominalPercent / 100 : null;
  const eligible = nominal !== null && validRate ? nominal * rateValue / 100 : null;
  const format = (n: number | null) => n === null ? '待填写假设' : Math.round(n).toLocaleString('zh-CN');
  return <details className="aud-estimate"><summary><Calculator size={14} /><span>合格人数场景估算</span><small>手动假设 · 非实测</small><ChevronDown size={13} /></summary><div className="aud-estimate-body">
    <p>名义桶占比不等于实际覆盖。填写评估期内的工作空间用户基数，以及桶内满足全部继承条件和实验受众的比例。</p>
    {audienceLabel && <div className="aud-condition-text">完整资格：{audienceLabel}</div>}
    <div className="aud-estimate-fields"><label>工作空间用户基数（假设）<input aria-label="估算用户基数" type="number" min="0" max="1000000000000" step="1" value={base} onChange={event => setBase(event.target.value)} /></label><label>桶内合格比例（假设 %）<input aria-label="估算桶内合格比例" type="number" min="0" max="100" step="0.1" value={rate} placeholder="例如 20" onChange={event => setRate(event.target.value)} /></label></div>
    {(!validBase || (rate !== '' && !validRate)) && <p role="alert" className="aud-error">基数须为 0–10¹² 的整数，合格比例须在 0–100% 之间。</p>}
    <div className="aud-estimate-results"><div><span>名义分配人数</span><strong>{format(nominal)}</strong><small>基数 × {formatPercent(nominalPercent)}%</small></div><div><span>预计合格人数</span><strong>{format(eligible)}</strong><small>{eligible === null ? '填写合格比例后计算' : `名义人数 × ${rateValue}%`}</small></div><div><span>实际曝光人数</span><strong>未接入</strong><small>需实际触发与曝光回传</small></div></div>
    <p className="aud-estimate-note">这里只计算输入假设，不使用示例受众规模推断真实流量；重复条件按交集计算，不重复乘比例。</p>
  </div></details>;
}
