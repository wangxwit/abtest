import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, BarChart3, Check, CircleAlert, Code2, Copy, FileChartColumn, FlaskConical, Layers3, LockKeyhole, Search, Server, ShieldCheck, SlidersHorizontal, Users, X } from 'lucide-react';
import { downloadCSV, metrics, num, statusLabels } from '../data';
import type { Experiment } from '../data';
import TrafficDomains from './TrafficDomains';
import ApplicationManagement from './ApplicationManagement';
import AudienceCenter from './AudienceCenter';
import { experimentServices } from '../service-catalog';
import { getTopology } from '../traffic';

type Props = { page: string; experiments: Experiment[]; onOpen: (experiment: Experiment) => void; notify: (message: string) => void };
type Metric = typeof metrics[number];
type Language = 'javascript' | 'go' | 'python';

const metricDefinitions: Record<string, { dedupe: string; window: string; analysis: string }> = {
  order_conversion_rate: { dedupe: 'user_id；同一用户只计一次转化', window: '分配后的预登记观察窗口', analysis: '用户级二元转化；按随机化单元估计比例差异。' },
  clicks_per_user: { dedupe: 'event_id 去重点击；user_id 去重分母', window: '实验观察窗口内的有效点击', analysis: '先按用户聚合点击数，再比较人均值；重复点击不是独立用户样本。' },
  search_ctr: { dedupe: 'event_id 去重；保留 request_id 与 user_id', window: '同一搜索请求关联曝光与点击', analysis: '点击／曝光比率；方差估计保留随机化单元内相关性。' },
  payment_success_rate: { dedupe: 'order_id；保留实验随机化单元', window: '支付发起后的预登记支付完成窗口', analysis: '订单成功／发起的比率；用户分组时须按用户处理聚类相关性。' },
  day_1_retention: { dedupe: 'user_id；统一业务时区与自然日边界', window: '首次活跃的下一自然日，等待完整窗口', analysis: '成熟用户群体的二元留存；未成熟样本不能当作未留存。' },
  average_order_value: { dedupe: 'order_id；金额口径需定义退款与币种', window: '实验观察窗口及约定迟到窗口', analysis: '金额／订单数比率；按随机化单元估计不确定性，预先约定异常值规则。' },
  api_latency_p95: { dedupe: 'request_id；按随机化单元保留关联', window: '实际请求发生窗口；区分超时和缺失', analysis: '请求耗时分位数；需验证分位数区间估计，不能直接使用均值检验。' },
  membership_conversion: { dedupe: 'user_id；同一用户只计一次有效开通', window: '分配后的预登记会员开通窗口', analysis: '用户级二元转化；按随机化单元估计比例差异。' },
};

const codeSamples: Record<Language, string> = {
  javascript: `// JavaScript · 接入契约伪代码，尚无可安装 SDK
// 由可信 BFF 决策；浏览器只接收允许公开的配置
const { decision, publicPayload } = await bff.bootstrap({
  experimentKey: 'homepage_recommend_v3'
});
renderRecommendation(publicPayload);

// 在真实渲染／触达时记录曝光，读取配置本身不计曝光
onRecommendationVisible(() => events.exposure({
  decisionId: decision.id,
  experimentId: decision.experimentId,
  variantId: decision.variantId,
  allocationEpoch: decision.allocationEpoch,
  revision: decision.revision,
  trigger: 'homepage_recommendation_visible'
}));`,
  go: `// Go · 接入契约伪代码，尚无可安装 SDK
// 入口移除外部伪造上下文，只接受内部可信决策
decision, err := trustedContext.ReadAndVerify(request)
if err != nil {
    return serveBaselineAndRecordFallback(request)
}

// 下游沿用同一分组，不使用另一份快照重新分桶
result, err := executeBoundVariant(decision, request)
if err != nil {
    recordFallback(decision, err)
    return serveBaseline(request)
}
recordExecution(decision, result.ActualVersion)
return result`,
  python: `# Python 3 · 接入契约伪代码，尚无可安装 SDK
# 决策由可信入口生成，绑定不可变模型与参数包
decision = trusted_context.verify(request)
binding = config_snapshot.binding_for(decision)
validate_schema(binding.parameters)

try:
    model = model_registry.load(binding.model_version)
    result = model.rank(candidates, binding.parameters)
    record_execution(decision, binding.model_version)
except ModelUnavailable:
    result = stable_model.rank(candidates)
    record_fallback(decision, actual_version=stable_model.version)

# shadow 结果不影响用户，不能记作实际处理曝光
return result`,
};

function PageHeading({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading simple"><div><h1>{title}</h1><p>{description}</p></div>{action && <div className="heading-actions">{action}</div>}</div>;
}

function DefinitionDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="definition-modal" aria-label={title} style={{ maxWidth: 'calc(100vw - 32px)' }} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}><header><h2>{title}</h2><button className="icon-btn" autoFocus aria-label="关闭详情" onClick={onClose}><X size={19} /></button></header>{children}</dialog>;
}

function MetricDetail({ metric, onClose }: { metric: Metric; onClose: () => void }) {
  const definition = metricDefinitions[metric.key];
  return <DefinitionDialog title={metric.name} onClose={onClose}><p>{metric.description}</p><dl>
    <div><dt>指标标识</dt><dd><code>{metric.key}</code></dd></div>
    <div><dt>口径版本</dt><dd>示例 v1 · 尚未连接数据源</dd></div>
    <div><dt>负责人</dt><dd>{metric.owner}</dd></div>
    <div><dt>去重与单元</dt><dd>{definition.dedupe}</dd></div>
    <div><dt>观察窗口</dt><dd>{definition.window}</dd></div>
    <div><dt>方向与单位</dt><dd>{metric.direction} · {metric.unit}</dd></div>
    <div><dt>分析约束</dt><dd>{definition.analysis}</dd></div>
    <div><dt>作为护栏</dt><dd>启动前约定可接受退化幅度；“未显著变差”不等于已经证明安全。{metric.direction === '越低越好' ? '耗时上升属于风险方向。' : '指标下降属于风险方向。'}</dd></div>
  </dl><p>本页展示指标契约设计，正式分析方法、窗口和阈值须在实验启动前登记。</p></DefinitionDialog>;
}

export default function ManagementPages({ page, experiments, onOpen, notify }: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部指标');
  const [selectedMetric, setSelectedMetric] = useState<Metric | null>(null);
  const [language, setLanguage] = useState<Language>('javascript');
  useEffect(() => { setSelectedMetric(null); }, [page]);
  const completed = experiments.filter(experiment => experiment.status === 'completed');
  const exportReports = () => {
    downloadCSV('EXP-Lab-已结束实验报告.csv', [
      ['数据说明', '交互原型示例数据，未执行真实统计；已结束不代表批准上线'],
      ['实验ID', '实验名称', '类型', '状态', '主指标', '参与人数（示例）', '相对变化(%，示例)', '结果说明'],
      ...completed.map(experiment => [experiment.id, experiment.name, experimentServices(experiment,getTopology()).map(service=>service.name).join('、') || '待归属服务', statusLabels[experiment.status], experiment.metric, experiment.participants, experiment.participants > 0 ? experiment.lift ?? '' : '', experiment.participants === 0 || experiment.lift === null ? '暂无数据' : experiment.significant ? '演示差异，待正式质量与护栏审核' : '演示结果，尚无明确差异']),
    ]);
    notify(`已导出 ${completed.length} 份实验摘要，CSV 内已注明示例数据。`);
  };
  const copyCode = async () => {
    try { await navigator.clipboard.writeText(codeSamples[language]); notify('接入契约伪代码已复制，需按生产架构实现。'); }
    catch { notify('浏览器未允许复制，请选择代码后手动复制。'); }
  };

  if (page === 'applications' || page === 'services' || page === 'parameters') return <ApplicationManagement experiments={experiments} onOpen={onOpen} />;
  if (page === 'traffic') return <TrafficDomains experiments={experiments} onOpen={onOpen} />;

  if (page === 'metrics') {
    const filtered = metrics.filter(metric => (category === '全部指标' || metric.category === category) && `${metric.name} ${metric.key} ${metric.description}`.toLowerCase().includes(query.toLowerCase().trim()));
    return <div className="management-page"><PageHeading title="指标中心" description="统一每一个指标的含义，让团队用同一种语言衡量变化。" />
      <section className="management-intro"><div><h2>从一个指标，追溯到完整定义</h2><p>共同维护口径、方向、去重规则和观察窗口。卡片数值为参考示例，未连接真实数据源。</p></div><Activity size={43} /></section>
      <div className="management-toolbar"><div className="table-filters"><label className="search-field"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索指标名称或标识…" aria-label="搜索指标" />{query && <button aria-label="清空指标搜索" onClick={() => setQuery('')}><X size={14} /></button>}</label><select aria-label="指标分类" value={category} onChange={event => setCategory(event.target.value)}>{['全部指标', ...new Set(metrics.map(metric => metric.category))].map(value => <option key={value}>{value}</option>)}</select></div><span>{filtered.length} 个指标 · 点击查看定义</span></div>
      <div className="metric-grid">{filtered.map(metric => <button className="card metric-card" key={metric.key} onClick={() => setSelectedMetric(metric)}><div className="metric-card-top"><BarChart3 size={20} /><span className="metric-tag">{metric.category}</span></div><h2>{metric.name}</h2><span className="metric-key">{metric.key}</span><div className="metric-number">{metric.value}<small>参考值 · 示例</small></div><p>{metric.description}</p><div className="metric-footer"><span>{metric.owner}</span><span>{experiments.filter(experiment => experiment.metric === metric.name).length} 个主指标引用 <ArrowRight size={11} style={{ verticalAlign: '-2px' }} /></span></div></button>)}</div>
      {filtered.length === 0 && <div className="card empty-state"><Search size={28} /><h3>没有找到匹配指标</h3><p>尝试其他名称，或选择“全部指标”。</p><button className="btn btn-small" onClick={() => { setQuery(''); setCategory('全部指标'); }}>清除筛选</button></div>}
      {selectedMetric && <MetricDetail metric={selectedMetric} onClose={() => setSelectedMetric(null)} />}
    </div>;
  }

  if (page === 'audiences') return <AudienceCenter experiments={experiments} onOpen={onOpen} />;

  if (page === 'reports') return <div className="management-page"><PageHeading title="实验报告" description="把每一次探索，沉淀为下一次决策的依据。" action={<button className="btn" disabled={completed.length === 0} onClick={exportReports}><ArrowDownToLine size={16} />导出报告摘要</button>} />
    <section className="management-intro"><div><h2>结束一次实验，留下可解释的结论</h2><p>已结束不代表已获准上线。正式结论仍需等待数据成熟，检查主指标、护栏及数据质量；以下均为示例结果。</p></div><FileChartColumn size={43} /></section>
    <div className="report-list">{completed.map(experiment => {
      const hasData = experiment.participants > 0 && experiment.lift !== null;
      return <section className="card report-card" key={experiment.id}><span className="report-symbol"><FileChartColumn size={23} /></span><div><h2>{experiment.name}</h2><p>{experiment.id} · {experimentServices(experiment,getTopology()).map(service=>service.name).join('、') || '待归属服务'} · {experiment.duration} 天 · {num(experiment.participants)} 人（示例）</p></div><div className="report-result"><strong style={hasData && experiment.lift! < 0 ? { color: '#ba554c' } : undefined}>{hasData ? `${experiment.lift! >= 0 ? '+' : ''}${experiment.lift!.toFixed(2)}%` : '暂无数据'}</strong><span>{hasData ? `${experiment.metric} · 相对变化示例` : '等待实际采集与正式分析'}</span></div><button className="btn btn-small" onClick={() => onOpen(experiment)}>查看报告<ArrowRight size={13} /></button></section>;
    })}</div>{completed.length === 0 && <div className="card empty-state"><FileChartColumn size={29} /><h3>还没有已结束的实验</h3><p>实验结束后可在这里查看和导出历史记录。</p></div>}
  </div>;

  if (page === 'integrations') {
    const options = [{ id: 'javascript' as const, name: '前端 · JavaScript', icon: Code2, text: '由 BFF 提供公开配置，在实际渲染时记录曝光；避免浏览器获取敏感规则。' }, { id: 'go' as const, name: '后端 · Go', icon: Server, text: '使用可信决策上下文与本地快照，服务调用链保持同一分组，失败时明确回退。' }, { id: 'python' as const, name: '策略 · Python 3', icon: SlidersHorizontal, text: '把实验变体绑定模型与参数包，校验版本兼容，并记录实际执行与回退。' }];
    return <div className="management-page"><PageHeading title="集成与 SDK" description="一种实验协议，连接不同技术栈与执行场景。" />
      <section className="management-intro"><div><h2>统一决策，按运行环境接入</h2><p>接入契约示例，尚未发布。下面的伪代码用于架构讨论，不代表已有可安装 SDK 或已经接通生产服务。</p></div><Code2 size={43} /></section>
      <div className="integration-grid">{options.map(option => <section className="card integration-card" key={option.id}><span className="integration-icon"><option.icon size={24} /></span><h2>{option.name}</h2><p>{option.text}</p><button className={`btn btn-small ${language === option.id ? 'btn-primary' : ''}`} aria-pressed={language === option.id} onClick={() => setLanguage(option.id)}>{language === option.id ? <Check size={14} /> : <Code2 size={14} />}{language === option.id ? '正在查看契约示例' : '查看契约示例'}</button></section>)}</div>
      <section className="card code-panel"><div className="code-panel-header"><div><h2>{options.find(option => option.id === language)?.name} · 接入伪代码</h2><p>接入契约示例，尚未发布</p></div><button className="btn btn-small" onClick={copyCode}><Copy size={14} />复制伪代码</button></div><pre aria-label={`${language} 接入契约伪代码`} tabIndex={0}><code>{codeSamples[language]}</code></pre><p>同一联动实验复用 experiment_id、variant_id、allocation_epoch、revision 与 decision_id。正式接入需实现鉴权、配置校验、真实曝光、幂等去重与默认回退；预览和影子流量应隔离正式分析。</p></section>
    </div>;
  }

  const members = [{ name: '陈思远', team: '用户体验', role: '实验负责人' }, { name: '林晓', team: '推荐算法', role: '接入工程师' }, { name: '周明', team: '搜索算法', role: '接入工程师' }, { name: '王子涵', team: '交易研发', role: '接入工程师' }, { name: '李可', team: '用户增长', role: '实验负责人' }, { name: '张予', team: '商业策略', role: '分析师' }, { name: '赵敏', team: '实验平台', role: '审批者' }];
  const permissions = [['管理员', '管理范围内', '有权限时', '有权限时', '管理范围内'], ['实验负责人', '本人负责', '提交审核', '申请停止', '项目范围'], ['接入工程师', '实施绑定', '—', '有应急权限时', '项目范围'], ['分析师', '指标与分析', '—', '—', '项目范围'], ['审批者', '查看差异', '独立审批', '有应急权限时', '项目范围'], ['只读成员', '—', '—', '—', '授权范围']];
  return <div className="management-page"><PageHeading title="团队与权限" description="明确协作边界，让每一次变更都有迹可循。" />
    <section className="management-intro"><div><h2>星云科技 · 企业工作空间</h2><p>{members.length} 位演示成员 · 下方角色与权限为设计示例。当前原型没有服务端身份校验，不提供真实邀请或权限变更。</p></div><ShieldCheck size={43} /></section>
    <div className="team-layout"><section className="card team-card"><div className="section-title"><h2>团队成员</h2><span className="metric-tag">演示组织</span></div>{members.map(member => <div className="team-row" key={member.name}><span className="team-avatar">{member.name[0]}</span><div><strong>{member.name}{member.name === '陈思远' ? '（当前演示用户）' : ''}</strong><small>{member.team}</small></div><span className="team-role">{member.role}</span></div>)}</section>
      <section className="card team-card"><h2>工作空间与治理</h2><div className="setting-item"><span>当前环境</span><strong>演示 · 浏览器本地</strong></div><div className="setting-item"><span>数据范围</span><strong>当前浏览器保存的实验</strong></div><div className="permission-list"><div><Layers3 size={19} /><div><strong>项目与环境隔离</strong><p>生产规划：组织 → 项目 → 测试／生产环境。数据、配置与服务凭证分别授权。</p></div></div><div><LockKeyhole size={19} /><div><strong>SSO 与企业身份</strong><p>生产规划：对接企业身份源、会话管理和服务身份；此处尚未连接 SSO。</p></div></div><div><ShieldCheck size={19} /><div><strong>版本审批与操作审计</strong><p>生产规划：审批绑定具体配置版本，记录操作者、原因和变更结果；高风险操作按规则分离职责。</p></div></div><div><CircleAlert size={19} /><div><strong>独立应急停止权限</strong><p>生产规划：允许授权人员快速止损，记录影响范围与实际生效覆盖，并补充复盘。</p></div></div></div></section></div>
    <section className="card team-card" style={{ marginTop: 23 }}><div className="section-title"><h2>角色权限矩阵</h2><span className="metric-tag">只读 · 生产设计建议</span></div><div className="table-scroll" style={{ marginTop: 19 }}><table className="experiment-table"><thead><tr>{['角色', '创建／编辑', '生产审批', '停止处理', '查看／导出'].map(title => <th key={title}>{title}</th>)}</tr></thead><tbody>{permissions.map(row => <tr key={row[0]}>{row.map((value, index) => <td key={index}>{value}</td>)}</tr>)}</tbody></table></div><p className="layer-foot">所有权限都受租户、项目和环境范围约束；管理员角色不自动绕过生产审批。正式权限由服务端执行，浏览器隐藏按钮不能替代鉴权。</p></section>
  </div>;
}
