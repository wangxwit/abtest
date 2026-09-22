# 设计依据与取舍

研究起始：2026-09-06；表述整理：2026-09-23。

本文区分论文事实、平台工程选择和待验证假设。现行实现契约见[服务端方案](../服务端技术方案/README.md)，原型状态见[使用手册](../平台文档/03-平台使用手册.md)。

## 1. Google 论文对应关系

来源：Tang、Agarwal、O’Brien、Meyer，*Overlapping Experiment Infrastructure: More, Better, Faster Experimentation*，KDD 2010。[论文页面](https://research.google/pubs/overlapping-experiment-infrastructure-more-better-faster-experimentation/) · [官方 PDF](https://research.google.com/pubs/archive/36500.pdf)。下表页码按 PDF 从首页起计算。

| 论文内容 | 定位 | 对本平台的含义 |
| --- | --- | --- |
| Domain 划分流量，Layer 对应参数子集，Experiment 覆盖参数值 | 第 3 页 §4 | 域、层、参数、实验是不同对象 |
| 域包含层，层可包含实验或子域 | 第 3–4 页 §4 | 支持交替递归，不能只做平铺层 |
| 非重叠域用一个完整参数层 | 第 4 页 Figure 2b | 可验证跨多个常规参数分区的联合方案 |
| 重叠域内多层并行，各层至多命中一个实验 | 第 4 页 Figure 2a/b | 各层共享域流量，不把层占用比例相加 |
| 不同域可以采用不同参数分区 | 第 3–4 页 Figure 2d | 参数唯一归层限定在同域内 |
| 分流函数包含 layer 标识 | 第 4 页 §4 | 分层应独立随机化，不能共用一个无层标识的 hash |
| 改变域份额会改变其他域的可用流量 | 第 4 页 10%→15% 示例 | 域扩量要评估已有实验，不能随意迁移用户 |
| Launch layer 提供替代默认值，普通实验覆盖优先 | 第 4 页 Figure 2c/d | 发布层不是另一个互斥域；首期未实现完整语义 |
| 支持多种 diversion，并按约定顺序执行 | 第 5–6 页 Figure 3 | 首期只做稳定 user_id 是明确裁剪 |
| 已分到某段但条件不满足的流量不继续补给后续类型 | 第 5–6 页 Figure 3 | 筛剩流量不一定是随机样本，不自动补量 |
| control 可作为 experiment，并可共享 | 第 3 页 §3、第 6 页 §5.2.1 | 本平台把多个组封装成一个实验是自己的产品设计 |
| Figure 4 讲标准误，Figure 5 讲规模趋势 | 第 7、9 页 | 层域结构的主要图证据是 Figure 2–3 |

示例：子域占父层 20%，实验占子域 50%，实验组占实验 50%，则该组占父层名义流量 5%。真实合格样本仍取决于受众条件与访问情况。

## 2. 本平台的工程选择

| 选择 | 原因与边界 |
| --- | --- |
| Namespace → 环境 | 隔离资源和授权；承接旧“项目”，不是租户，也不自动互斥业务用户 |
| 全局账号、多空间成员、资源范围授权 | 支持团队协作；参数引用不能传播维护权限 |
| 根域唯一路由层 | 集中治理业务域入口，避免任意根层扩张 |
| 每层 10,000 固定桶，允许多段 | 0.01% 粒度；利用碎片，不移动已有分配 |
| 固定资格证明后允许复用桶 | 适用于可证明互斥的人群；未知按可能冲突处理 |
| 实验包含 2–20 个组 | 方便统一配置和分析；唯一对照组，稳定分组 ID |
| 顶层参数 Key 为归层原子单位 | 嵌套 JSON 内部路径不分别分层 |
| 网关决策并跨服务透传 | 避免各服务重复分组和版本漂移 |
| hash v2 与跨语言向量 | 固定字节协议；Namespace 改名保留旧 ID 值，不重新分桶 |
| 固定周期统计 | 首期便于复现；序贯检验、CUPED 和市场干扰方法另行设计 |

这些选择不应表述为 Google 论文要求。共享对照、发布层完整语义、混合 diversion、组织级随机化、Bandit 和长期 holdout 均不属于当前已实现能力。

## 3. 决策与接入依据

| 问题 | 本平台做法 | 参考 |
| --- | --- | --- |
| 公开端与服务端如何接入 | 公开端经 BFF 取最终值；可信 SDK 可本地评估签名规则 | [LaunchDarkly SDK 执行方式](https://launchdarkly.com/docs/sdk/concepts/client-side-server-side) |
| 业务代码如何传入上下文 | 稳定 targeting key、受信属性与请求上下文；实验专有字段自行扩展 | [OpenFeature Evaluation Context](https://openfeature.dev/specification/sections/evaluation-context/) |
| 服务间如何传播 | 签名或受控引用的决策上下文；下游不重新分组 | [SDK 契约](../服务端技术方案/03-SDK与分流协议.md) |
| Baggage 能否作为授权凭据 | 不能；不放密钥、完整画像或敏感参数 | [W3C Baggage](https://www.w3.org/TR/baggage/) |
| 配置如何计算摘要 | 约定规范化 JSON、UTF-8 和版本 | [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) |
| 资源权限如何继承 | 归属树上的 allow 合并；引用关系不继承；父级权限不能被子级窄授权收回 | [Google Cloud IAM](https://docs.cloud.google.com/iam/docs/resource-hierarchy-access-control) |

接入模式不能替代一致性检查：同一次请求使用同一快照和决策，缓存区分实际处理版本，故障回退保留原分配身份。

## 4. 指标可信度依据

```text
分配 → 处理前资格 → 实际执行 / 曝光 → 业务事件 → 单位级事实 → 版本化分析
```

| 原则 | 原因 / 参考 |
| --- | --- |
| 配置查询不等于曝光 | 读取后可能未执行，shadow 也不是实际处理 |
| 主分析保留入组后失败或回退的用户 | 避免按处理结果删样本；使用预定义 ITT 口径 |
| 触发条件在处理前定义，两组一致 | 不能只分析点击新按钮的人；[Microsoft 触发分析](https://www.microsoft.com/en-us/research/articles/patterns-of-trustworthy-experimentation-post-experiment-stage) |
| SRM 是数据质量门槛 | 严重异常时不宣布胜出；[Microsoft SRM](https://www.microsoft.com/en-us/research/articles/diagnosing-sample-ratio-mismatch-in-a-b-testing/) |
| 按随机化单元计算方差 | 多次点击不是多个独立用户；[集群与比率统计](https://docs.statsig.com/metrics/different-id) |
| 多组比较预先定义比较族 | 首期采用 Holm；临时切片仅作探索 |
| 固定周期检验不随时宣布胜出 | 提前决策需要专门方法；[序贯检验](https://docs.statsig.com/experiments/advanced-setup/sequential-testing) |
| CUPED 只使用处理前协变量 | 降低方差，不修复埋点或 SRM；[Microsoft 方差降低](https://www.microsoft.com/en-us/research/group/experimentation-platform-exp/articles/deep-dive-into-variance-reduction/) |
| 分配独立不保证效果独立 | 同一用户的策略交互、共享训练与岗位／房源竞争需另评估 |

当前正式方法、事件定义和 SQL 以[指标生产与分析](../服务端技术方案/04-指标生产与分析.md)为准；旧研究草稿中的接口名和状态词不作为现行协议。

## 5. 仍需业务定值

- 登录／匿名身份策略、资格快照期限和存储设施。
- 日活、决策 QPS、延迟预算、参数与快照大小。
- 模型发布、缓存分区、训练数据反馈和共享供给影响。
- 数据仓库、事件保留期、指标归因窗及迟到处理。
- Namespace 边界、团队可委派权限和生产审批职责。

这些问题决定容量与实施细节，不改变已确认的 Namespace、层域和参数归属规则。
