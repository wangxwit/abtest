# 画像属性与受众条件编辑器

v13 · 已实现并完成本地验收（2026-09-12），承接本任务关于入口、条件组和冲突校验的讨论。验收证据见 [VERIFICATION.md](../../VERIFICATION.md)。

## 交付范围

- 一个“受众管理”一级入口，受众列表与画像属性两个独立地址页签。受众与属性均可搜索，详情可通过深链接打开；切换页签保留筛选。
- 画像属性支持登记、类型／来源／口径／单位查看与受众、域、实验引用追踪。自定义属性由已登记应用提供；内置属性保留原 key。属性定义登记后不可原地改写或删除，含义变化登记新 key。类型为枚举、数值、布尔或文本；数值非负，可限制整数。属性不是实验参数，不进入参数层分区或参数包。
- 共用的受众编辑器支持 AND／OR 条件组，根组计入最多 3 层，总计最多 30 条叶条件；属性选择与操作符随类型变化。新树非空，无条件人群需显式选择。已有受众通过创建新版本修改，旧引用保持原版本。
- 编辑器显示完整表达式、具体条件错误、手动画像验证；没有画像服务时不显示人群规模。域／实验中可快捷创建，保存即选中；取消保留父草稿。
- 条件自身、所有祖先域条件 AND 当前条件、同父层的实验／子域桶逐对校验。只证明完整条件互斥时允许同桶复用；不能证明或求解复杂度超限时分开占桶。OR 不能只检查其中一个分支。
- 固定首次 user_id 资格快照；自定义属性可输入、保存和恢复，旧用户缺少新属性不能补填以改变资格。三值逻辑保持 false AND unknown=false，true OR unknown=true；整体 unknown 不执行，不改投其他桶。

## 核心契约

`Topology.profileAttributes?: ProfileAttribute[]` 保存不可变画像属性目录。`ProfileAttribute` 含 key、label、type、values?、description、serviceId、unit?、integer?、createdAt；getProfileAttributes、getProfileAttribute、planProfileAttributeRegistration 为访问入口。

`AudienceExpression = {kind:'rule',rule:AudienceRule} | {kind:'group',operator:'and'|'or',children:AudienceExpression[]}`。旧受众保留 rules 数组原文；新树使用 expression 且 rules=[]，禁止两套条件同时有值。EffectiveAudience 携带完整表达式和属性快照，供三值计算、互斥证明及描述共用。

DNF 证明最多展开 64 项；超过限制不产生错误的互斥结论。规则错误返回 path、code、message、severity。冲突报告包含冲突对象、重叠桶、原因与可构造的共同满足画像，明确示例不是实测用户。

## 兼容与边界

保持 v12 固定哈希、旧规则语义、不可变引用、应用私有标签、参数 pending／active 与递归空层限制。新目录与规则一起保存，存储失败不能部分提交，遗漏已存目录不能恢复为 seed。当前仍为本地原型，不新增生产画像、SDK、曝光、RBAC、审批或多标签页事务。

## 验收

自动化覆盖 OR 分支、祖先交集、缺属性、复杂度上限、属性非法值与不可变引用、存储兼容与失败。浏览器完成属性登记 → 创建包含自定义属性的嵌套受众 → 引用追踪 → 域／实验快捷创建 → 合格与不合格模拟 → 刷新恢复；原用户 origin 不写入测试数据。
