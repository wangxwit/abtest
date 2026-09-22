import { normalizeExperiments, getDomain } from './traffic.ts';
import type { Coordination, ParameterRule } from './coordination';
import type { BucketRange } from './bucket-ranges';
export type ExperimentType = 'frontend' | 'backend' | 'strategy';
export type ExperimentStatus = 'running' | 'paused' | 'draft' | 'review' | 'completed';
export type VariantRole = 'control' | 'treatment';
export type Variant = { id?: string; role?: VariantRole; name: string; weight: number; value: string };
export type ExperimentVariant = Variant;
export type Activity = { title: string; time: string; person: string };
export type Experiment = {
  id: string; key: string; name: string; description: string; type: ExperimentType;
  status: ExperimentStatus; owner: string; team: string; traffic: number;
  participants: number; lift: number | null; significant: boolean; metric: string;
  date: string; duration: number; layer: string; audience: string; unit: string;
  domainId: string; layerId: string; parameterKeys: string[]; bucketStart: number;
  bucketRanges?: BucketRange[];
  variants: Variant[]; activities: Activity[]; health: 'healthy' | 'warning';
  guardrails?: string[]; hypothesis?: string; audienceId?: string;
  sourceDraftId?: string;
  coordination?: Coordination;
  parameterRules?: ParameterRule[];
};
export const typeLabels: Record<ExperimentType, string> = { frontend: '前端实验', backend: '后端实验', strategy: '策略实验' };
export const statusLabels: Record<ExperimentStatus, string> = { running: '运行中', paused: '已暂停', draft: '草稿', review: '待审核', completed: '已结束' };
const seeds: Array<[string,string,ExperimentType,ExperimentStatus,string,string,number,number,number|null,boolean,string,number]> = [
  ['首页推荐算法升级','homepage_recommend_v3','strategy','running','林晓','推荐算法',20,186420,5.24,true,'人均点击次数',12],
  ['商品详情页布局优化','product_detail_layout','frontend','running','陈思远','用户体验',30,124806,3.68,true,'下单转化率',9],
  ['搜索排序模型迭代','search_rank_v2','strategy','running','周明','搜索算法',10,98352,1.82,false,'搜索点击率',7],
  ['结算服务缓存策略','checkout_cache','backend','running','王子涵','交易研发',15,76518,-0.42,false,'支付成功率',6],
  ['新用户引导流程简化','onboarding_flow','frontend','review','李可','用户增长',10,0,null,false,'次日留存率',0],
  ['优惠券智能发放策略','coupon_smart_assign','strategy','paused','张予','商业策略',10,62480,2.16,false,'下单转化率',14],
  ['购物车凑单推荐','cart_recommend','frontend','running','陈思远','用户体验',20,84360,4.12,true,'客单价',8],
  ['接口并行聚合优化','api_parallel','backend','running','王子涵','交易研发',10,145600,0.86,false,'支付成功率',11],
  ['会员权益入口改版','membership_entry','frontend','completed','李可','用户增长',0,212850,6.32,true,'会员开通率',21],
  ['召回模型多样性优化','recall_diversity','strategy','completed','林晓','推荐算法',0,248910,3.48,true,'人均点击次数',28],
  ['库存预占机制优化','inventory_reserve','backend','completed','周明','交易研发',0,156230,-0.18,false,'下单转化率',14],
  ['内容卡片样式探索','content_card_style','frontend','draft','陈思远','用户体验',10,0,null,false,'人均点击次数',0],
  ['长尾内容召回策略','longtail_recall','strategy','draft','林晓','推荐算法',5,0,null,false,'人均点击次数',0],
];
export const initialExperiments: Experiment[] = normalizeExperiments(seeds.map((s, i) => ({
  domainId:'',layerId:'',parameterKeys:[],bucketStart:Number.NaN,
  id: `EXP-${String(1028-i).padStart(4,'0')}`, key:s[1], name:s[0], type:s[2], status:s[3], owner:s[4], team:s[5], traffic:s[6], participants:s[7], lift:s[8], significant:s[9], metric:s[10], duration:s[11],
  description: ['通过优化个性化推荐排序，提高内容与用户兴趣的匹配度，验证新版方案对核心业务指标的影响。','调整信息层级与核心操作位置，减少用户决策成本，验证新版布局能否提升转化。','优化服务处理方式，在保护稳定性指标的前提下，验证方案对用户体验的改善。'][s[2]==='strategy'?0:s[2]==='frontend'?1:2],
  date: s[11] ? `2026-08-${String(31-Math.min(s[11],28)+6).padStart(2,'0')}` : '2026-09-06',
  layer: s[2]==='strategy'?'推荐策略层':s[2]==='frontend'?'用户体验层':'服务架构层', audience: '全部活跃用户', unit: 'user_id',
  variants:[{name:'对照组 A',weight:50,value:'baseline'},{name:'实验组 B',weight:50,value:'treatment_v2'}],
  activities:[{title:'创建实验',time:'2026-08-24 10:30',person:s[4]},...(s[7]>0?[{title:'审核通过并启动实验',time:'2026-08-25 14:20',person:'赵敏 · 审核人'}]:[])],
  health: i===3?'warning':'healthy'
})));
initialExperiments.push(
 {id:'EXP-1101',key:'checkout_fullstack_v1',name:'交易链路整体重构',description:'同时调整页面布局、推荐模型和交易并行处理，使用非重叠域避免与其他普通实验叠加。',type:'backend',status:'running',owner:'王子涵',team:'交易研发',traffic:50,participants:62480,lift:2.16,significant:false,metric:'下单转化率',date:'2026-08-29',duration:8,layer:'全参数隔离层',domainId:'exclusive',layerId:'full',parameterKeys:['ui.layout','ranking.model','checkout.parallel'],bucketStart:0,audience:'全部活跃用户',unit:'user_id',variants:[{name:'对照组 A',weight:50,value:JSON.stringify({'ui.layout':'classic','ranking.model':'baseline','checkout.parallel':false})},{name:'实验组 B',weight:50,value:JSON.stringify({'ui.layout':'compact','ranking.model':'rank_v2','checkout.parallel':true})}],activities:[{title:'创建全链路实验，分配非重叠域',time:'2026-08-29 10:00',person:'王子涵'},{title:'审核通过并启动实验',time:'2026-08-29 15:00',person:'赵敏 · 审核人'}],health:'healthy'},
 {id:'EXP-1102',key:'membership_fullstack_v1',name:'会员权益与优惠联动',description:'跨展示与定价参数的整体改动，独立验证会员权益入口与优惠规则。',type:'strategy',status:'draft',owner:'张予',team:'商业策略',traffic:20,participants:0,lift:null,significant:false,metric:'会员开通率',date:'2026-09-06',duration:0,layer:'全参数隔离层',domainId:'exclusive',layerId:'full',parameterKeys:['ui.membership','pricing.coupon'],bucketStart:50,audience:'全部活跃用户',unit:'user_id',variants:[{name:'对照组 A',weight:50,value:JSON.stringify({'ui.membership':'classic','pricing.coupon':'standard'})},{name:'实验组 B',weight:50,value:JSON.stringify({'ui.membership':'prominent','pricing.coupon':'member_v2'})}],activities:[{title:'创建实验草稿',time:'2026-09-06 11:00',person:'张予'}],health:'healthy'}
);
// Demonstration allocations in nested branches; no measured outcomes are claimed.
const nestedSeeds: Array<[string,string,string,string,string,string,number,string[]]> = [
 ['EXP-1201','nested_navigation','导航入口组合探索','ui-mobile','ui-navigation','导航与入口子层',40,['ui.layout','ui.onboarding']],
 ['EXP-1202','nested_content','内容交互轻量化','ui-mobile','ui-content','内容交互子层',40,['ui.content_card']],
 ['EXP-1203','nested_ui_isolation','界面参数整体联动','ui-isolation','ui-full','展示全参数子层',50,['ui.layout','ui.content_card','ui.cart']],
 ['EXP-1204','nested_card_depth','深层卡片信息密度','card-depth','card-layout','卡片样式孙层',50,['ui.content_card']],
 ['EXP-1205','nested_cart_depth','深层购物车交互','card-depth','ui-cart','购物车交互孙层',40,['ui.cart']]
];
for (const [id,key,name,domainId,layerId,layer,traffic,parameterKeys] of nestedSeeds) { if (!getDomain({domainId})) continue; initialExperiments.push({
 id,key,name,domainId,layerId,layer,traffic,parameterKeys,bucketStart:0,type:'frontend',status:'running',
 owner:'陈思远',team:'用户体验',participants:0,lift:null,significant:false,metric:'下单转化率',date:'2026-09-06',duration:0,
 description:'层域递归分流示例：继承父层流量及参数范围，与本层直接实验或其他子域保持互斥。',
 audience:'全部活跃用户',unit:'user_id',health:'healthy',
 variants:[{name:'对照组 A',weight:50,value:JSON.stringify(Object.fromEntries(parameterKeys.map(k=>[k,'baseline'])))},{name:'实验组 B',weight:50,value:JSON.stringify(Object.fromEntries(parameterKeys.map(k=>[k,'treatment']))) }],
 activities:[{title:'载入嵌套分流演示配置（无真实曝光数据）',time:'2026-09-06 14:00',person:'演示系统'}]
});}
export const metrics = [
 {name:'下单转化率',key:'order_conversion_rate',category:'转化指标',unit:'%',description:'完成下单的用户数 / 符合条件的活跃用户数',owner:'交易数据组',used:12,value:'4.82%',direction:'越高越好'},
 {name:'人均点击次数',key:'clicks_per_user',category:'参与指标',unit:'次/人',description:'符合条件的总点击次数 / 去重活跃用户数',owner:'推荐数据组',used:8,value:'8.64',direction:'越高越好'},
 {name:'搜索点击率',key:'search_ctr',category:'转化指标',unit:'%',description:'搜索结果点击次数 / 搜索结果曝光次数',owner:'搜索数据组',used:6,value:'23.16%',direction:'越高越好'},
 {name:'支付成功率',key:'payment_success_rate',category:'护栏指标',unit:'%',description:'成功支付订单数 / 发起支付订单数',owner:'交易数据组',used:10,value:'99.62%',direction:'越高越好'},
 {name:'次日留存率',key:'day_1_retention',category:'留存指标',unit:'%',description:'首次活跃次日再次活跃的用户比例',owner:'增长数据组',used:5,value:'36.28%',direction:'越高越好'},
 {name:'客单价',key:'average_order_value',category:'收入指标',unit:'元',description:'成功支付总金额 / 成功支付订单数',owner:'商业数据组',used:4,value:'128.50',direction:'越高越好'},
 {name:'P95 接口耗时',key:'api_latency_p95',category:'护栏指标',unit:'ms',description:'请求耗时分布的第 95 百分位',owner:'基础架构组',used:9,value:'142 ms',direction:'越低越好'},
 {name:'会员开通率',key:'membership_conversion',category:'转化指标',unit:'%',description:'完成会员开通的用户数 / 符合条件的活跃用户数',owner:'增长数据组',used:3,value:'2.41%',direction:'越高越好'}
];
export const audiences = [
 {name:'全部活跃用户',count:'128.6 万',description:'最近 30 天至少访问一次的用户',rule:'last_active_days ≤ 30',color:'green'},
 {name:'新注册用户',count:'16.8 万',description:'注册时间在 7 天以内的用户',rule:'registration_days ≤ 7',color:'blue'},
 {name:'高价值会员',count:'8.2 万',description:'有效会员且近 30 天累计消费 ≥ 500 元',rule:'is_member = true AND spend_30d ≥ 500',color:'purple'},
 {name:'移动端用户',count:'96.4 万',description:'通过 iOS 或 Android 应用访问',rule:'platform IN [iOS, Android]',color:'orange'}
];
export const num = (n: number) => n >= 10000 ? `${(n/10000).toFixed(1)} 万` : n.toLocaleString('zh-CN');
export function downloadCSV(filename: string, rows: (string|number)[][]) {
 const content='\uFEFF'+rows.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');
 const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8;'}));
 const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function validTransition(from:ExperimentStatus,to:ExperimentStatus) {
 const allowed:Record<ExperimentStatus,ExperimentStatus[]>={draft:['review'],review:['draft','running'],running:['paused','completed'],paused:['running','completed'],completed:[]};
 return allowed[from].includes(to);
}
