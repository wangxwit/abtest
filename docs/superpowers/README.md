# 早期设计与实施记录

本目录保留原型各阶段的设计摘要与完成记录，不作为现行生产契约。整理日期：2026-09-23；各文件的测试数字仍属于原日期。

| 版本 | 内容 | 记录 |
| --- | --- | --- |
| v1–v2 | 企业实验平台初版 | [设计](specs/2026-09-06-ab-platform-design.md) · [实施](plans/2026-09-06-ab-platform.md) |
| v8 | 应用管理与服务参数归属 | [设计](specs/2026-09-12-service-tags-design.md) · [实施](plans/2026-09-12-service-tags.md) |
| v9 | 应用内参数维护 | [设计](specs/2026-09-12-service-owned-parameters.md) · [实施](plans/2026-09-12-service-owned-parameters.md) |
| v10 | 应用私有标签 | [设计](specs/2026-09-12-application-tags.md) · [实施](plans/2026-09-12-application-tags.md) |
| v11 | 参数与层独立生命周期 | [设计](specs/2026-09-12-parameter-layer-lifecycle.md) · [实施](plans/2026-09-12-parameter-layer-lifecycle.md) |
| v12 | 受众与域条件 | [设计](specs/2026-09-12-audience-domain-conditions.md) · [实施](plans/2026-09-12-audience-domain-conditions.md) |
| v13 | 画像属性与条件编辑器 | [设计](specs/2026-09-12-audience-builder-design.md) · [实施](plans/2026-09-12-audience-builder.md) |

原始逐版验收证据见[归档](../archive/原型逐版验收记录.md)；最新操作见[使用手册](../平台文档/03-平台使用手册.md)，生产设计见[服务端方案](../服务端技术方案/README.md)。

已替代的设计：全局参数页、共享应用标签、注册时强制归层、仅 AND 受众、画像来源应用、连续桶要求、双初始层、参数组合约束与三步创建弹窗。各文件明确标注其后续变化。
