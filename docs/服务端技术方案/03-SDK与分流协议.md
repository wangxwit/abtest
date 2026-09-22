# SDK 与分流协议

设计 v1.3 · 2026-09-23 · [返回总览](./README.md)

本文为待实施 SDK 契约；当前只有浏览器模拟器，没有生产 SDK。HTTP 字段见[接口协议](./02-接口协议.md)，授权见 [Namespace 与权限设计](./05-Namespace与权限设计.md)。

v1.3 控制库限定 30 张表，不改变 SDK 对外身份或分桶字节。experiment_revision、variant_id 和 analysis_plan_version_id 来自 experiment_run 冻结契约；projection/bundle 是 release 对象产物中的固定索引及文件，manifest 是短期签名协议，均不要求同名独立表。事件日志、资格 KV、对象存储与遥测沿用既有数据链路，见 [数据库设计](./01-数据库设计.md)。

## 1. SDK 分工与接入模式

| SDK／组件 | 可以做什么 | 配置与信任边界 |
| --- | --- | --- |
| Java 服务端 SDK，首发 | 本地确定性分流、批量取参数、处理上下文、异步事件 | 仅受控服务，可下载授权范围的签名规则和参数 |
| 决策服务 Client | 调用远程批量决策、缓存同请求结果、上报执行 | 无需嵌入本地分流内核，适合语言长尾 |
| BFF／网关集成 | 建立可信身份与资格、作为一次业务请求的决策 authority | 给下游签发／转发决策上下文，按应用投影参数 |
| 下游消费 SDK | 验证或解析 authority 的上下文，读取本服务参数 | 不对已有上下文再次独立分组 |
| Web／App SDK | 获取允许公开的最终值，报告真实页面／组件触发 | 经 BFF，不能持有服务凭据、画像全量或完整实验规则 |
| 管理模拟器 | 使用候选快照解释整条分流路径 | 仅管理权限，不产生生产分配／曝光数据 |

服务按环境选择 `direct` 或 `delegated`；委托须同 Namespace、同环境、无环，明确 authority 范围。已有上游上下文一律沿用；模式只决定初始决策权。

同一用户可同时进入不同层及不同 Namespace 的实验，Namespace 不提供用户互斥或因果隔离。上下文用 `assignments[]`，先完成业务范围内分配，再投影服务参数；请求 Key 列表不能改变分流。联合控制首页参数的团队使用同一 Namespace，通过资源授权协作。

一个 Decision／上下文只属于一个 Namespace 和环境。业务请求涉及多个 Namespace 时分别建立决策、分别传递上下文，不合并参数归属或跨空间引用实验。

| 操作 | 可信授权边界 |
| --- | --- |
| 建立决策 | 全局机器 principal + 有效 namespace_member + runtime.evaluate；凭证绑定 Namespace／环境／服务与 business_scope |
| 解析已有上下文 | runtime.context.resolve；同 Namespace／环境，按当前服务参数投影，不换组 |
| 读取配置、ACK、撤销栅栏 | runtime.config.read；服务投影与最小依赖包，公开客户端无全规则下载权 |
| 事件 | event.ingest；scope、producer、类型均匹配可信凭证 |
| 模拟／强制分组／诊断 | 额外 runtime.debug 与相关资源 read；仅沙箱，不写生产事实 |

机器凭证唯一绑定 Namespace／环境／服务／principal；首期只接受 principal 直接绑定，组授权延期。动作取 machine_credential.allowed_actions 与当前 role.actions／绑定的交集，两组动作数组都受代码动作目录约束。客户端声明的 scope、service、Key 或自定义头不能覆盖可信凭证范围。成员不自动授资源 read；owner、标签不授权限。引用不继承权限，规则编译必须完整校验后再做授权投影。

## 2. SDK 外观与生命周期

以下为语言无关的接口示意，不是已发布的包名：

```text
Client.initialize(options) -> readiness
Client.beginDecision(unit, trustedContext, requestId, businessScope) -> Decision
Client.resolveContext(decisionToken, requestId) -> Decision
Decision.getBoolean(key, emergencyDefault) -> ParameterResult<boolean>
Decision.getNumber(key, emergencyDefault) -> ParameterResult<number>
Decision.getString(key, emergencyDefault) -> ParameterResult<string>
Decision.getObject(key, schemaId, emergencyDefault) -> ParameterResult<object>
Decision.getAll() -> immutable parameter map
Decision.getAssignments() -> authorized assignment list
Decision.recordQualification(triggerId, triggerVersion, occurrenceId)
Decision.recordExecution(executionReport)
Decision.recordExposure(exposurePoint, occurrenceId, actualBundle)
Client.trackBusiness(event)
Client.flush(deadline)
Client.close(deadline)
```

`initialize` 有限等待，返回 ready／degraded／unavailable。`beginDecision` 固定快照、unit、资格 epoch 与业务范围；getter 只读该对象，不联网、不换组。上下文绑定请求／异步任务，结束即清理，不使用全局“当前用户”。

| 返回契约 | 内容 |
| --- | --- |
| ParameterResult | `value,type,source,parameter_version_id,decision_id,reason`；实验值另含 `parameter_bundle_id,digest,assignment_index` |
| source | experiment／baseline／emergency_default；后者为调用方预先确认的安全值，不是假对照组 |
| freshness | fresh／last_known_good；旧配置仍须有效、未撤销，不能靠缓存续期 |
| 已分配后回退 | 保留原 assignment、期望 bundle；实际值与来源另记。无可信分配时才无 assignment |

HTTP `parameters` 返回逐 Key 值及 assignment_index；`assignments[]` 含 experiment_id、experiment_revision、run_id、variant_id、allocation_revision、layer_path、parameter_keys、parameter_bundle_id。未命中返回固定基线。`getAssignments()` 只读当前服务授权结果，不另发请求或按名称重新分组。

初始化提供可信凭据、Namespace／环境、authority 模式、配置与缓存、超时、队列上限及日志脱敏策略；声明范围须与凭据一致。凭据不硬编码或下发公开客户端。连接状态来自握手、配置加载和执行上报。

### 2.1 一次推荐请求的业务代码

```text
// BFF，在任何实验处理发生前建立决策
decision = client.beginDecision(
  authenticatedUser, trustedEligibilityReference,
  requestId, "recommendation.home"
)
decision.recordQualification("home_recommendation", "qv_1", requestId)

// 同一决策 token 传给召回、排序等服务
recallResult = recallService.call(input, decision.token)
rankResult = rankService.call(recallResult, decision.token)

// 排序服务内：先取本服务投影，不能再次 evaluate
localDecision = client.resolveContext(token, requestId)
profile = localDecision.getObject("home.rank.profile", "rank_profile_v2", safeProfile)
actual = rankWith(profile.value)
localDecision.recordExecution({
  occurrence_id: requestId,
  trigger_id: "home_rank_applied",
  parameter_bundle_id: profile.parameter_bundle_id,
  expected_digest: profile.digest,
  actual_model_version: actual.modelVersion,
  outcome: actual.fallback ? "fallback" : "applied",
  fallback_reason: actual.reason
})
```

此为伪代码，正式示例须补初始化与错误分支。资格在处理前按各组同一规则记录，以 request/decision ID 关联；真正采用参数才记 applied，读取／预取不算曝光。

## 3. 身份与固定资格

### 3.1 稳定身份

首期 `unit.type=user_id`，ID 来自可信登录会话。Runtime 接收 unit:{type,id}，身份服务转为 Namespace 内稳定 `unit_key`，事件记同值 `unit.id_hash`。规则与密钥世代在 run 期间固定，各微服务不能另加盐。原 Namespace 改名也不得更换假名策略或 ID。

ID 始终是字符串："00123" ≠ "123"；不转数字、截断、trim 或折叠大小写。device/session 须另建实验方案，同 run 不混用单位。匿名转登录须记录版本化身份策略，首期不自动合并样本。

### 3.2 资格快照协议

同一层可复用桶的候选必须共享资格命名空间：

```text
eligibility key = namespace_id + environment_id
                 + eligibility_epoch + unit_type + unit_key
```

快照含 `snapshot_id / eligibility_epoch / attribute_schema_versions / attributes / captured_at / source_watermark / digest`。画像来源是平台可信画像服务；“画像属性目录”仅定义字段语义，不代表值已经存在。公开请求上传的属性只能作为非可信上下文，不能直接决定共享桶的固定资格。

environment 保存当前 epoch 的完整 unit、身份、画像 Schema 与 snapshot namespace 契约；该映射不可原地改写，旧 epoch ID 不复用不同语义。存在相关活跃/draining 预留时不得更换 epoch。属性目录仅保当前定义，audience_version、run 和 release 冻结使用时的完整定义；执行旧契约不能回读目录当前语义。

首次获取使用既有资格 KV 的原子 `put-if-absent`／条件写入，不为每个业务用户在控制库建记录。两个并发请求读取不同画像时，只允许一个快照成为该 key 的正式记录，另一方重读获胜值。缓存过期必须回源读取原快照，不能重新截取当前画像。

快照内缺字段就是该 epoch 的固定缺失状态，不在后续请求补填；所有受众求值将缺失／类型错误视为不满足。画像系统完全不可用时，返回 `eligibility_unavailable`，不把故障包装成“有效空画像”并永久写入。加入新画像字段若需要重采，要创建新的资格 epoch 和受影响运行，不能修改已有资格。

固定快照应覆盖该 epoch 会用于互斥证明的属性全集；新增条件引用了快照未包含的属性时不会自动补采。epoch 的保留期限至少覆盖相关 run、旧配置／上下文执行窗口和审计所需期限。删除资格数据后若继续允许旧 run 决策会破坏不变性，因此删除、退役与重新分配必须协同处理。

### 3.3 动态条件

页面场景、请求时间、网络状态等动态上下文可用于执行某个业务功能，但不能为桶坐标复用提供互斥证明。固定资格负责“这个单位是否可以进入分配”，动态触发负责“这次请求是否实际走到功能”。即使前者不变，后者仍可能受处理影响；指标分析不得自动用处理后的触发事件筛掉不活跃用户。

## 4. 生产分桶协议 ab-bucket-sha256-v2

旧草案从 v1 收敛为九字段 v2。v1.2 仅将第三字段显示名 `project_id` 改为 `namespace_id`；九字段的值、顺序和编码全不变，**不升 hash 协议、不改既有 ID、不重新分桶**。fixture 中 opaque 值 `project_rec` 必须保留。

当前无生产 SDK；原型仍用 FNV 演示算法。生产新环境采用下述 v2；其他既有真实算法须并存版本、显式迁移 run，不能直接替换或重标。

### 4.1 输入编码

字段固定为下列顺序的 **9 个非空字符串**：

| 顺序 | 字段 | 层分流取值 | 实验组分流取值 |
| --- | --- | --- | --- |
| 1 | protocol | `ab-bucket-sha256-v2` | 相同 |
| 2 | purpose | `layer` | `variant` |
| 3–4 | namespace_id、environment_id | 原 opaque 空间 ID 与环境 ID；改名不换值 | 相同 |
| 5 | node_id | layer_id | run_id |
| 6 | epoch | allocation_epoch | variant_epoch |
| 7 | unit_type | `user_id` 等 | 与层相同 |
| 8 | unit_key | 可信身份服务的稳定假名 | 相同 |
| 9 | salt | 128 位随机值的小写 32 位十六进制文本 | run 独立的 salt |

每个字段 UTF-8 编码，不做 Unicode 规范化；拒绝不合法 Unicode 标量（如孤立 surrogate）。输入字节由 4 字节无符号大端字段个数 `9` 开始，再按顺序拼接每字段的 `4 字节大端 UTF-8 字节长度 + 字段字节`。单字段最长 4096 字节。长度按字节，不按 Java／JavaScript 字符数。salt 是文本字段，不再次 hex decode。

```text
payload = U32BE(9) || Σ[ U32BE(byteLength(UTF8(field))) || UTF8(field) ]
digest = SHA256(payload)
u = digest 前 8 字节，以 unsigned 64-bit big-endian 解释
bucket = u mod 10000
```

Java 使用 unsigned remainder，JavaScript 使用 BigInt，禁止把 u 转成双精度 Number 后取余。SHA-256 可使用标准语言库，例如 [Java MessageDigest](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/security/MessageDigest.html)；无符号运算见 [Java Long](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Long.html)。模运算存在远小于业务采样噪声的有限整数映射偏差，不应宣传为数学上绝对均匀；生产仍需做分布及 A/A 验证。

salt 用于稳定、独立的分配，不是鉴权秘密。配置 revision、参数值、名称、请求 ID、标签和当前时间均不进入 hash。更换 salt／epoch 是重新随机化，需要显式创建新的分配契约并评估残留影响。

### 4.2 分组映射

每个 run 编译时生成不可变、覆盖 `[0,10000)` 的 variant 区间表，区间长度等于各组 `weight_bps`。例如：

```json
{
  "run_id": "run_rec_001",
  "variant_epoch": "ve_1",
  "variant_ranges": [
    {"start": 0, "end": 5000, "variant_id": "v_control"},
    {"start": 5000, "end": 7500, "variant_id": "v_recall"},
    {"start": 7500, "end": 10000, "variant_id": "v_joint"}
  ]
}
```

variant bucket 用独立的 `purpose=variant` hash，不使用“在已占桶集合中的序号”。这样增加实验准入桶不会改变已有用户的分组。管理页面调整分组显示顺序也不能重建运行中的区间表；分组权重、角色、处理值变化必须开启新 run。

实验占父层 20% 与其中某处理组 25% 是两个阶段：在固定资格均匀且无其他筛选的假设下，名义父层占比为 5%；实际样本需要观测，不据此承诺人数。

### 4.3 协议样例附件

[hash-vectors.json](./hash-vectors.json) 提供长度编码后的 payload、SHA-256 和期望桶号，覆盖普通 ID、分隔符、中文、组合字符、不同 purpose 和 salt。它是待实现 SDK 的一致性输入，不是平台的正式用户样本。

运行 `node docs/服务端技术方案/verify-hash-vectors.mjs` 验证 10 组 Python 生成的向量。v1.2 已同步 fixture 的 field_order 与 Node 字段名；v1.3 不修改向量或验证脚本，所有 payload／digest／bucket 保持不变。Java／Go／移动端仍须用各自编码器通过同一向量。

## 5. 递归决策流程

```text
evaluate(snapshot, unit, trusted_eligibility, business_scope):
  verify snapshot/lease/authority/identity compatibility
  result = baseline values pinned in snapshot
  visit(root_domain)
  return service-authorized projection(result), assignments, decision_token

visit(domain):
  if full inherited audience does not match fixed eligibility: return
  for each nonempty layer in domain within compiled business scope:
    b = hash(layer, unit)
    candidates = children and reservations containing b
    matched = candidates whose full fixed eligibility matches
    if matched.count > 1: fail affected branch; raise invalid_snapshot
    if matched.count == 0: continue
    x = matched[0]
    if x is child domain: visit(x)
    else if x is running and execution lease permits:
      v = immutable variant interval containing hash(run, unit)
      apply full selected-key bundle for v
      append assignment
    else: preserve baseline; do not try another experiment
```

编译器从 change_request／run 的冻结输入生成 release 完整快照，包含固定基线、完整祖先条件、参数版本和值、分组区间、epoch 契约与依赖摘要；不能从当前参数默认值或可变目录重建历史。编译器在后台校验完整拓扑与全部继承参数；scope 包含祖先和影响冲突判定的候选。UI 脱敏或只请求部分 Key 不能裁剪继承／跳过父层隔离。服务投影仅可移除已证明不影响结果的计算，并与完整树做一致性验证。

同一域不同参数层可并行决策；层内只能匹配一个直接实验或子域。进入子域后不再同时执行该父层的直接实验。非重叠子域的隔离只作用于它的分支，不自动停止祖先域中的其他并行参数层。

若任意覆盖产生重复顶层 Key，编译应已阻止；SDK 遇到此类坏包必须拒绝冲突分支并报告，禁止用后写覆盖掩盖错误。多服务原子配置包需以完整 bundle 校验与回退，不能因为一个字段类型不对就将其余实验字段随意混入基线。

## 6. 配置包分发、校验和缓存

配置仓库返回 manifest，包含身份、schema/hash 协议、不可变 URI、内容 digest、签名 Key ID、有效期和最低 SDK 版本。release 保存配置 URI、摘要、签名与编译版本，environment 保存活动 head 和只增撤销序号。SDK 定时条件 GET 或接收更新通知，再用 ETag 查询；通知丢失可通过轮询收敛。

projection/bundle 索引可在一个 release 对象目录内管理，但每个 service + capability 必须取得独立授权的文件 URI 和摘要；普通执行服务不得下载含其他应用参数的全环境包。产物字段一旦冻结不得修改，重新编译或回滚使用新的 release/config_revision；作用域、capability 和摘要一致的内容文件可复用。

加载步骤：下载至临时文件 → 校验大小与完整性 → 校验签名与 scope → 严格解析 → 检查支持的 schema/hash 版本和资源上限 → 构建只读索引 → 原子替换内存引用及 last-known-good 缓存。失败保留仍有效的旧版本，并报告明确原因。

签名采用成熟 JWS 库，首期固定允许 ES256，`kid` 只从预配置可信密钥集解析；拒绝 `alg=none`、不支持算法及正文指定的任意远程密钥地址。验签依据收到的原始签名字节，不先解析再自行重序列化。配置内容摘要按 JCS 生成，用于跨端比对；JSON 必须拒绝重复 Key、NaN/Infinity、非法 Unicode。JSON 精确大整数与十进制定点金额用字符串表达，避免不同语言丢精度。[RFC 7515 JWS](https://www.rfc-editor.org/rfc/rfc7515.txt)、[RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785)

服务端加载完整授权包；大 JSON 以不可变内容摘要去重，不能把每个实验组的百行 JSON 重复复制到每个业务请求。`Decision` 持有只读引用，业务需要修改时显式复制。返回对象不允许业务方原地修改共享缓存。

配置包默认值、实验组 bundle 与模型／索引引用全部版本固定。包中可引用预装资源，但运行前必须 readiness；不得在首个用户请求内临时下载数 GB 模型而阻塞决策。

| 缓存 | 必要分区键 |
| --- | --- |
| 配置 | namespace_id + environment_id + service_id + projection_id + config_revision |
| 固定资格 | scope + eligibility_epoch + unit_type + unit_key |
| 决策上下文 | scope + authority + decision_id |
| resolve 响应 | 上述上下文键 + service_id + 当前授权投影／policy_revision |

首期管理鉴权直查当前成员、角色和绑定，不建设 allow 缓存／跨 Namespace 失效服务。运行配置及结果缓存仍按 scope 和投影隔离；在线签发／续签重检当前授权和撤销，本地决策在有效租约及受限签名能力内执行，不要求每次 decision/getter/token 读写 SQL。撤权阻止新的鉴权／续签，不暗中停止实验；已签发包和上下文按短租约及运行撤销栅栏处理。

### 6.1 租约签发与桶回收

manifest 不逐条落表。每次签发／续签在短事务内检查主体、目标 release 可签发状态和撤销栅栏，持久化 `max_lease_expires_at = max(旧值, 本次到期时间)`；提交成功后才签名返回。签名失败可留下保守上界，不能先返回再异步补写。关闭续签与签发使用同一锁栅栏，涵盖所有仍可能包含目标 run 的旧 release，不只检查当前活动版本。

本地 authority 只能在有效租约内签出 context，context TTL 不超过冻结契约上限；透传、resolve、重试均不能续期。关闭续签后，回收下界为所有相关旧 release 的最大持久租约到期上界加 `max_context_ttl + max_inflight + clock_skew`。allocation_reservation 保存回收证据；证明不足保持 draining，不能以多数实例 ACK 代替。回滚创建新发布，并重验桶占用与只增撤销序号，不复活已回收分配。

ACK/readiness 原始记录走既有遥测，service_environment 保最近摘要。配置续签才更新租约上界；高 QPS 本地 decision/token 与事件不逐次写控制库。

## 7. 跨服务上下文

### 7.1 上下文内容与传输

签名 token 或不可猜测的上下文引用至少绑定：

```text
iss / aud / jti / iat / exp / schema_version
namespace_id / environment_id
decision_id / request_id / unit_type / unit_key
config_revision / eligibility_epoch / eligibility_snapshot_id
assignments[{run_id, experiment_revision, variant_id, parameter_bundle_id}]
revocation_revision / business_scope
```

HTTP 可用专用 `X-Experiment-Context`，gRPC 用等价 metadata；header 仅传短 token，不塞入百行策略 JSON。异步任务将上下文引用与任务 payload 一起持久化；超过执行有效期的任务按明确规则拒绝旧处理或重新建立新业务决策，并记录二者关系，不能无提示继续旧实验。

`contexts:resolve` 依次验证凭证 scope → runtime.context.resolve → token 签名／引用 → authority、unit、请求链、目标 audience → 有效期／撤销栅栏 → 当前服务投影。请求 scope 不能覆盖凭证或 token；跨 Namespace 解析拒绝。子调用沿用 decision ID，各执行步骤独立 occurrence ID。

W3C Baggage 可传播小量诊断元数据，但不承担授权或防篡改；不要将完整参数、令牌和画像写入会被下游广泛记录的 baggage。[W3C Baggage](https://www.w3.org/TR/baggage/)

### 7.2 authority 与本地 SDK

不是任何持有配置的服务都有权伪造完整决策。只有显式授予某业务 scope 的 authority 能建立和签发该 scope 上下文；普通下游只有消费权限。远程决策服务可以集中签发；高 QPS 的本地 authority 使用短期受限签名能力，只有持有有效执行／签发租约时才能签发 context；无需逐个注册 SQL 决策记录。密钥权限和审计独立于配置下载权限，运行事实走既有事件链路。

下游不能仅凭“同一个 user_id”断言分组一致；还必须一致的协议、salt、epoch、资格快照、拓扑和组映射。已有 token 优先重用，不能为了追上最新配置在调用链中重新决策。

### 7.3 执行一致性与缓存

同一 assignment 不代表所有服务已原子执行。发布前校验各服务支持的 bundle／模型／Schema；执行时每个服务记录实际采用版本、fallback 与错误。跨服务联合实验若需要整体回退，要在业务编排层定义统一 fallback 方案，平台不能撤回已经发生的页面展示或交易。

业务缓存必须纳入会影响结果的参数 bundle 或处理签名、模型与索引版本；不能只按 user_id 或 URL 缓存导致组间污染。也不应盲目把整个 config_revision 放入所有业务缓存 Key，引起无关发布全量失效。缓存命中仍记录本请求真实采用的处理身份，不能重发首次生成缓存时的 occurrence ID。

请求重试沿用 decision_id 与逻辑 occurrence_id；新的独立业务请求新建 occurrence_id。上下文未到期且未撤销时沿用原分配，不因重试读到新发布版本而换组。

## 8. 事件、回退与埋点

| 事件 | 产生位置 | 含义 |
| --- | --- | --- |
| qualification | 所有组一致的业务触发点、处理之前 | 单元到达预定义的实验机会 |
| assignment | 可信决策 authority | 单元在某 run 分配到哪个组 |
| execution | 参数使用的业务步骤 | 期望配置与实际版本，以及失败、回退或执行成功 |
| exposure | 满足预定义实际生效／可见条件的业务点 | 已发生的曝光事实；执行失败或回退不自动算处理曝光 |
| business | 订单／点击／请求等业务系统 | 结果事实；不要求生产者知道全部实验身份 |

`get*()` 不自动记曝光。SDK 可缓存同 Decision 的 getters，但不得用“调用次数”当用户数。同一逻辑曝光的去重身份必须稳定：由 Namespace／环境／producer／event_id 标识原始事件；需要多 run 展开的记录同时纳入 run_id，避免只保留第一个实验。

事件使用有界队列、批发送、指数退避和 jitter；收到采集端持久 ACK 才确认发送完成。进程关闭在 deadline 内 flush，队列满或进程崩溃可能丢失，必须统计并暴露，不承诺客户端恰好一次。重要服务可配本地持久 WAL；浏览器无法保证退出时所有事件到达，关键成交应由业务后端产出。

执行 token 的 TTL 限制“还能否使用配置”，不能机械地等同“历史事件是否有效”。迟到事件根据当时决策记录、签名时间、业务发生时间及分析允许迟到窗口校验；允许真实历史执行晚到，但不能用过期 token 伪造当前曝光。

fallback 至少分清：未分配时使用基线、已分配但执行失败使用紧急默认、无资格／配置时完全无法建立实验分配。已分配后的失败样本留在原组的 ITT 分析中；缺少可信分配的样本不能编成对照组。主指标、去重键与归因见[指标文档](./04-指标生产与分析.md)。

## 9. 错误与兼容策略

| 原因 | SDK 动作 |
| --- | --- |
| 参数不存在／未授权 | 返回明确 reason 和调用方安全默认；对外不泄露其他服务参数 |
| 值类型／Schema 不匹配 | 按 bundle 策略回退，报告期望／实际版本 |
| 快照过期／执行租约失效 | 停止实验处理，不能无限使用旧实验配置 |
| 资格缺失 | 不命中相关分支；默认值不计为实验对照 |
| token 单元／Namespace／服务／环境不匹配 | 拒绝解析；不能 fallback 为一次新的随机分配 |
| 同层多重命中／Key 冲突 | 配置完整性故障，阻止冲突范围执行并告警 |
| 队列满／发送失败 | 业务有界继续，记录丢失计数与降级状态 |

SDK schema 使用主次版本：新增可选观测字段可兼容；新操作符、新 hash、参数类型解释或关键字段语义改变需要声明最低版本并阻止不支持的客户端加载。未知必需字段不能被默默忽略。升级采用新旧内核双算只比对结果，不重复曝光，再逐步切换；新 hash 不能通过 SDK 升级影响仍运行的旧 run。

可提供 OpenFeature Provider 适配常见 typed getter 和请求上下文；本平台的层域、多个 assignment、执行报告与跨网络 token 仍是扩展契约。OpenFeature 的 transaction context 主要解决语言进程内传播，不能代替微服务一致性与鉴权。[OpenFeature Evaluation Context](https://openfeature.dev/specification/sections/evaluation-context/)

## 10. SDK 验收清单

1. 同一输入跨语言得到相同 payload、digest、桶号和 variant；覆盖中文、非 BMP 字符、前导零、分隔符、非法 Unicode 与数值边界。
2. 增加准入桶、更新标签／名称／配置 revision 后，原用户保持 variant；权重／epoch 变更不能作为普通热更新绕过检查。
3. 固定资格首次并发写、缓存淘汰回源、属性缺失、新字段、画像不可用场景不破坏共享桶互斥性。
4. 嵌套域、并行层、paused 占位、非重叠分支、服务投影与完整树决策结果一致。
5. 一个请求内配置更新不改变已建立 Decision；多个线程不能交叉读取用户身份和参数。
6. token 篡改、跨 Namespace／环境重放、伪造 scope、过期、被撤销、未知 kid 均拒绝；历史事件迟到与执行授权过期分别处理。
7. 网络断开、冷启动、坏包、队列溢出、进程重启、紧急停止与桶 draining 有明确可测边界。
8. 联合实验某服务模型未就绪、部分回退、缓存命中和异步重试均能报告 assigned 与 actual，不自动剔除失败样本。

9. 成员无资源角色、跨服务私有 Key、撤权后缓存／新请求均不能越权；调试需额外动作，生产事件不接受强制分组。
10. 只重命名 Namespace 保持 opaque ID、九字段编码和全部向量；不同 Namespace 同一用户可同时入组，不误报流量互斥。
11. 投影 URI 不能读取其他应用文件；签发上界必须先提交，关闭续签与并发签发串行，晚签出的 context 仍被纳入回收窗口；本地决策链路不要求逐请求 SQL。

这些是研发验收要求。本次仅修订文档并检查示例结构，不代表上述生产 SDK 功能已经实现或全部测试通过。
