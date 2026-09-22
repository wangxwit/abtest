# 参数与层独立生命周期设计

v11 · 2026-09-12。用户指出注册参数需要层、建层又需要参数，要求解除依赖。本文件记录本轮授权范围，不增加审批；v10 私有标签和验证记录保留历史定位。

## 最小模型

- 参数先在所属应用登记定义和本应用私有标签，保存为待归层，不要求选层。`Topology.pendingParameterKeys?: string[]` 标识待归层 Key；缺少该字段的旧数据保持全部已激活。
- 注册全集与激活分流全集分开。根域只使用激活 Key，`*` 只继承激活父范围；显式层列表也不得引用 pending。注册不能扩大任何层的分流范围。
- 合法重叠域可以先创建空普通层。空层待配置，不承载实验、零参数 A/A 或子域，也不计入可执行并发。根域、非重叠域及非重叠祖先分支原有限制保持。
- 独立首次归层沿所有受影响递归域完成唯一分配后，一次移出 pending 并激活。可进入既有空层，或建层时选择待归层参数一次完成两步；深层目标需固定祖先路径和目标新层，补齐其他受影响分支。
- 激活参数保持域内完整唯一分区、父范围和使用保护。保存拒绝 active → pending、清空／删除旧非空层，以及转移被未结束实验或子域保护的 Key。

## 接口与边界

核心合同包括 `activeParameterKeys`、`isParameterPending`、仅登记的 `planParameterRegistration(input, existing, t?)`，以及独立 `planParameterLayerAssignment(key, selections, existing, t?)`。`registrationAssignments` 保留递归规划；`NewLayerInput.pendingSelections` 与 `newLayerRegistrationAssignments` 组织建层中的首次归层。生命周期计划放在独立模块，避免模块顶层循环调用。

应用参数页区分待归层与历史待归属服务；归层前可维护定义展示与应用私有标签，不能选择进实验。激活、建层和服务认领不改旧实验 Key、A/B 值、桶位或随机化标识。真实 SDK、生产审批、参数退激活、定义编辑删除和并发保护不在本轮范围。

上述设计已落实；最终 115/115 测试、构建及浏览器验收证据见 [VERIFICATION](../../VERIFICATION.md) 的 v11 记录。现代配置保存还要求保留归层状态字段，防止遗漏字段造成星号隐式激活。
