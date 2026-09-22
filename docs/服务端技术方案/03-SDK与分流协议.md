# SDK 与分流协议

设计 v1.1 · 2026-09-22 · [返回总览](./README.md)

本文定义服务端决策、公开客户端接入、跨服务传播与一致性验收要求。当前原型只有浏览器内模拟器，没有可直接接入生产的 SDK。下文接口是拟实现的 SDK 外观，HTTP 字段以[接口协议](./02-接口协议.md)为准。

## 1. SDK 分工与接入模式

| SDK／组件 | 可以做什么 | 配置与信任边界 |
| --- | --- | --- |
| Java 服务端 SDK，首发 | 本地确定性分流、批量取参数、处理上下文、异步事件 | 仅受控服务，可下载授权范围的签名规则和参数 |
| 决策服务 Client | 调用远程批量决策、缓存同请求结果、上报执行 | 无需嵌入本地分流内核，适合语言长尾 |
| BFF／网关集成 | 建立可信身份与资格、作为一次业务请求的决策 authority | 给下游签发／转发决策上下文，按应用投影参数 |
| 下游消费 SDK | 验证或解析 authority 的上下文，读取本服务参数 | 不对已有上下文再次独立分组 |
| Web／App SDK | 获取允许公开的最终值，报告真实页面／组件触发 | 经 BFF，不能持有服务凭据、画像全量或完整实验规则 |
| 管理模拟器 | 使用候选快照解释整条分流路径 | 仅管理权限，不产生生产分配／曝光数据 |

服务按环境选择 `direct` 或 `delegated`。委托关系必须同项目同环境、无环，并明确 authority 的可决策业务范围。`direct` 服务也不能在已有上游上下文时重新选择组；模式只决定谁有权建立初始决策。

一个用户可能同时参与多个参数层的实验，因此上下文包含 `assignments[]`，不能用一个全局 `A/B` 字符串表示。每个请求先确定该业务范围的全部相关分配，再对调用服务投影参数；不同服务传入不同 Key 列表不能改变分流结果。

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

`initialize` 区分 `ready / degraded / unavailable`，等待有上限。`beginDecision` 固定快照、unit、资格 epoch 和业务范围，所有 getter 都从该对象读取，不再访问网络或换组。禁止使用进程全局可变的“当前用户”；上下文绑定到请求／异步任务并在结束时清理。

`ParameterResult` 至少返回 `value / type / source / parameter_version_id / decision_id / reason`；已分配值还带 `parameter_bundle_id / digest / assignment_index`。来源为 `experiment / baseline / emergency_default`；另用 `freshness=fresh|last_known_good` 表达是否在有效授权期内回用旧配置，不能以此绕过过期和撤销。已分配后回退仍保留原 assignment 引用和期望 bundle，实际值及来源另记；从未产生可信分配时才没有 assignment。紧急默认来自调用方预先约定的业务安全值，仅在无有效参数、类型不符等情况下使用，不能悄悄标记为对照组。

HTTP 响应的顶层 `parameters` 使用每 Key 的结构化值及 `assignment_index`；`assignments[]` 包含 `experiment_id / experiment_revision / run_id / variant_id / allocation_revision / layer_path / parameter_keys / parameter_bundle_id`。所有本服务可见参数都有明确来源，未命中实验时仍能返回签名配置里的基线值。业务只需查询参与了哪些实验及所在分组时读取 `getAssignments()`，不再单独请求或根据实验名称重新算组；结果只包含该服务获授权的信息。

初始化选项应包括身份与授权凭据提供器、环境、authority 模式、配置拉取与缓存路径、超时、事件队列上限、日志脱敏策略；凭据不能硬编码在业务代码或公开客户端。连接状态由真实握手、配置加载和执行上报决定，不能由管理页面手动勾选。

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

这是伪代码，初始化和错误分支在正式 SDK 示例中补齐。资格触发可以在决策之前记录，再以 request/decision ID 关联，但必须在处理之前确定且所有组使用相同规则。只有真正采用该参数的执行步骤才记录 `applied`；读取、预取或请求未进入该步骤不算曝光。

## 3. 身份与固定资格

### 3.1 稳定身份

首期使用 `unit.type=user_id`，输入 ID 必须来自可信登录会话。Runtime 接口可以接收 `unit:{type,id}`，服务端身份适配器将其转换为项目级稳定假名 `unit_key`；事件中同一值记为 `unit.id_hash`。假名生成规则与密钥世代在 run 期间固定，不能每个微服务各自加盐。

ID 始终是字符串：`"00123"` 与 `"123"` 不同，不能转数字、截断、隐式 trim 或按大小写折叠。支持 device/session 单元时须新建相应实验方案；不能在同一 run 中“有用户 ID 就用用户，没有就用设备”却仍把它当一致随机化单元。匿名转登录必须有显式身份策略并记录转换，首期不自动合并两份实验样本。

### 3.2 资格快照协议

同一层可复用桶的候选必须共享资格命名空间：

```text
eligibility key = project + environment
                 + eligibility_epoch + unit_type + unit_key
```

快照含 `snapshot_id / eligibility_epoch / attribute_schema_versions / attributes / captured_at / source_watermark / digest`。画像来源是平台可信画像服务；“画像属性目录”仅定义字段语义，不代表值已经存在。公开请求上传的属性只能作为非可信上下文，不能直接决定共享桶的固定资格。

首次获取使用持久存储的原子 `put-if-absent`／条件写入。两个并发请求读取不同画像时，只允许一个快照成为该 key 的正式记录，另一方重读获胜值。缓存过期必须回源读取原快照，不能重新截取当前画像。

快照内缺字段就是该 epoch 的固定缺失状态，不在后续请求补填；所有受众求值将缺失／类型错误视为不满足。画像系统完全不可用时，返回 `eligibility_unavailable`，不把故障包装成“有效空画像”并永久写入。加入新画像字段若需要重采，要创建新的资格 epoch 和受影响运行，不能修改已有资格。

固定快照应覆盖该 epoch 会用于互斥证明的属性全集；新增条件引用了快照未包含的属性时不会自动补采。epoch 的保留期限至少覆盖相关 run、旧配置／上下文执行窗口和审计所需期限。删除资格数据后若继续允许旧 run 决策会破坏不变性，因此删除、退役与重新分配必须协同处理。

### 3.3 动态条件

页面场景、请求时间、网络状态等动态上下文可用于执行某个业务功能，但不能为桶坐标复用提供互斥证明。固定资格负责“这个单位是否可以进入分配”，动态触发负责“这次请求是否实际走到功能”。即使前者不变，后者仍可能受处理影响；指标分析不得自动用处理后的触发事件筛掉不活跃用户。

## 4. 生产分桶协议 ab-bucket-sha256-v2

本次单企业部署修订将输入收敛为 9 个字段，因此协议从旧草案 v1 升为 v2，避免同名协议对应不同字节编码。旧草案保留在 Git 历史；当前没有已运行的生产 SDK，原型模拟器继续使用原有演示算法。

原型 FNV 演示 hash 不直接升级为生产协议。生产新环境采用以下协议；已有真实生产分配若使用其他算法，必须并存协议版本、迁移运行，不能偷偷替换 hash。

### 4.1 输入编码

字段固定为下列顺序的 **9 个非空字符串**：

| 顺序 | 字段 | 层分流取值 | 实验组分流取值 |
| --- | --- | --- | --- |
| 1 | protocol | `ab-bucket-sha256-v2` | 相同 |
| 2 | purpose | `layer` | `variant` |
| 3–4 | project_id、environment_id | 授权空间身份 | 相同 |
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

可运行 `node docs/服务端技术方案/verify-hash-vectors.mjs` 验证 Node 参考编码器；本次另以 Python 标准库独立生成和比对。Java／Go／移动端仍需实现自己的编码器并通过同一向量，不能把一份 Node 结果称为已经验证所有语言。

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

编译后的业务 scope 必须包含正确祖先与所有影响冲突判定的直接候选；不能因只请求一个服务的 Key 而跳过父层的隔离选择。服务投影可以剔除不相关的子树计算，但需证明其与完整树求值等价，并纳入一致性测试。

同一域不同参数层可并行决策；层内只能匹配一个直接实验或子域。进入子域后不再同时执行该父层的直接实验。非重叠子域的隔离只作用于它的分支，不自动停止祖先域中的其他并行参数层。

若任意覆盖产生重复顶层 Key，编译应已阻止；SDK 遇到此类坏包必须拒绝冲突分支并报告，禁止用后写覆盖掩盖错误。多服务原子配置包需以完整 bundle 校验与回退，不能因为一个字段类型不对就将其余实验字段随意混入基线。

## 6. 配置包分发、校验和缓存

配置仓库返回 manifest，包含身份、schema/hash 协议、不可变 URI、内容 digest、签名 Key ID、有效期和最低 SDK 版本。SDK 定时条件 GET 或接收更新通知，再用 ETag 查询；通知丢失可通过轮询收敛。

加载步骤：下载至临时文件 → 校验大小与完整性 → 校验签名与 scope → 严格解析 → 检查支持的 schema/hash 版本和资源上限 → 构建只读索引 → 原子替换内存引用及 last-known-good 缓存。失败保留仍有效的旧版本，并报告明确原因。

签名采用成熟 JWS 库，首期固定允许 ES256，`kid` 只从预配置可信密钥集解析；拒绝 `alg=none`、不支持算法及正文指定的任意远程密钥地址。验签依据收到的原始签名字节，不先解析再自行重序列化。配置内容摘要按 JCS 生成，用于跨端比对；JSON 必须拒绝重复 Key、NaN/Infinity、非法 Unicode。JSON 精确大整数与十进制定点金额用字符串表达，避免不同语言丢精度。[RFC 7515 JWS](https://www.rfc-editor.org/rfc/rfc7515.txt)、[RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785)

服务端加载完整授权包；大 JSON 以不可变内容摘要去重，不能把每个 group 的百行 JSON 重复复制到每个业务请求。`Decision` 持有只读引用，业务需要修改时显式复制。返回对象不允许业务方原地修改共享缓存。

配置包默认值、实验组 bundle 与模型／索引引用全部版本固定。包中可引用预装资源，但运行前必须 readiness；不得在首个用户请求内临时下载数 GB 模型而阻塞决策。

缓存区分：配置缓存按 scope+config_revision，资格按 scope+eligibility_epoch+unit_key，决策上下文按 authority+decision_id，resolve 结果还包含调用 service_id。不同服务的授权投影不能共用一个未分权限的缓存项。

## 7. 跨服务上下文

### 7.1 上下文内容与传输

签名 token 或不可猜测的上下文引用至少绑定：

```text
iss / aud / jti / iat / exp / schema_version
project_id / environment_id
decision_id / request_id / unit_type / unit_key
config_revision / eligibility_epoch / eligibility_snapshot_id
assignments[{run_id, experiment_revision, variant_id, parameter_bundle_id}]
revocation_revision / business_scope
```

HTTP 可用专用 `X-Experiment-Context`，gRPC 用等价 metadata；header 仅传短 token，不塞入百行策略 JSON。异步任务将上下文引用与任务 payload 一起持久化；超过执行有效期的任务按明确规则拒绝旧处理或重新建立新业务决策，并记录二者关系，不能无提示继续旧实验。

`contexts:resolve` 验证签名／引用、authority 授权、unit 和请求链绑定、受众字段、有效期与撤销栅栏，再返回本服务允许的参数。请求 scope 不能覆盖 token 的 scope。对跨服务 trace，父请求授权的子调用沿用 decision ID，但每个执行步骤有自己的 occurrence ID。

W3C Baggage 可传播小量诊断元数据，但不承担授权或防篡改；不要将完整参数、令牌和画像写入会被下游广泛记录的 baggage。[W3C Baggage](https://www.w3.org/TR/baggage/)

### 7.2 authority 与本地 SDK

不是任何持有配置的服务都有权伪造完整决策。只有显式授予某业务 scope 的 authority 能建立和签发该 scope 上下文；普通下游只有消费权限。远程决策服务可以集中签发；高 QPS 的本地 authority 可使用短期受限签名凭据或注册决策记录，密钥权限和审计独立于配置下载权限。

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

`get*()` 不自动记曝光。SDK 可缓存同 Decision 的 getters，但不得用“调用次数”当用户数。同一逻辑曝光的去重身份必须稳定：由项目／环境／producer／event_id 标识原始事件；需要多 run 展开的记录同时纳入 run_id，避免只保留第一个实验。

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
| token 单元／服务／环境不匹配 | 拒绝解析；不能 fallback 为一次新的随机分配 |
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
6. token 篡改、跨环境重放、过期、被撤销、未知 kid 均拒绝；历史事件迟到与执行授权过期分别处理。
7. 网络断开、冷启动、坏包、队列溢出、进程重启、紧急停止与桶 draining 有明确可测边界。
8. 联合实验某服务模型未就绪、部分回退、缓存命中和异步重试均能报告 assigned 与 actual，不自动剔除失败样本。

这些是研发验收要求。本次只验证协议样例附件及文档结构，不代表上述生产 SDK 功能已经实现或全部测试通过。
