# 企业 AB 平台 Implementation Plan

**Goal:** 完成可运行中文实验平台原型及产品、技术设计文档。

**Architecture:** React 控制台以共享实验数据模型驱动总览和表格；创建、详情与支撑管理页分离。localStorage 持久化演示操作，状态机验证生命周期。

**Tech Stack:** React、TypeScript、Vite、Lucide、Recharts。

**Spec:** docs/superpowers/specs/2026-09-06-ab-platform-design.md

## Global Constraints

- 演示工作区，无生产副作用；所有模拟能力清晰标明。
- 中文界面，键盘可用，支持窄屏，状态不只依赖颜色。
- 创建校验 key 唯一与版本权重合计 100%，草稿无统计结果。

## Task 1: 核心工作台

- [x] src/data.ts 定义 Experiment、Variant、Activity 及样本、流转验证。
- [x] src/App.tsx 实现导航、总览、筛选和持久化；src/styles.css 统一视觉。
- [x] 首屏浏览器检查与生产构建。

## Task 2: 实验流程

- [x] src/components/CreateExperiment.tsx 接收 existing、onClose、onCreate，实现三步校验与保存。
- [x] src/components/ExperimentDetail.tsx 展示指标、配置、活动及生命周期操作。
- [x] 浏览器走通创建→提交→审核→暂停→恢复→结束；检查刷新持久化。

## Task 3: 支撑页面与交付

- [x] src/components/ManagementPages.tsx 实现流量、指标、受众、报告、SDK 与团队页。
- [x] PRD 与架构文档说明统一模型、治理、统计约束、生产接入边界及分期。
- [x] 运行构建和关键流程检查，保存截图，打开预览并交付 README。

## 用户修正：Google 域层模型

- [x] 核验论文 §4 / Figure 2b，明确域切流量、层分参数。
- [x] src/traffic.ts 完成兄弟域路由、层桶和版本桶、参数权限与容量验证。
- [x] 层域页面支持两域、参数层、固定桶与分流模拟；创建/详情/导出同步迁移。
- [x] 8项自动检查与浏览器关键流程通过；详细记录见 docs/VERIFICATION.md。
