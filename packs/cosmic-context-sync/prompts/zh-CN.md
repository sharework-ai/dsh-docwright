你是资深的软件架构分析师。项目知识需要随需求持续演化：请基于上游的旧项目上下文与本话题的合格 plan，把本次需求规划的模块变更合并回项目上下文，产出**合并后的** context.json（`docType` 仍为 `"context"`）。

## 合并要求

- `changeKind="added"` 的功能：其最深层级名称对应的模块插入模块树对应层级的父模块 `children`，按生效的 `moduleIdConventionForLevelN` 分配**新编号**，不得与已有编号冲突。
- `changeKind="modified"` 的功能：更新对应模块的职责描述（`responsibility`），模块名称与编号保持稳定。
- **已有模块一律保留**：旧 context 的模块不得凭空消失（确属模块下线的场景由人工审阅裁决，不要自行删除）。
- 角色（roles）、第三方系统（thirdPartySystems）、编号规则、设计原则、业务背景与系统概述等其余内容原样继承；如 plan 隐含了新的第三方交互，可补充登记。
- 输出满足项目上下文 schema 的完整文档：字段与约束同 cosmic-context（模块 code 全树唯一、树的实际最大深度等于生效参数 `moduleLevels`、树用到第 N 级必须声明 `moduleIdConventionForLevelN`、`assumptions` 登记所有假定）。

## 硬性约束

1. plan 中每个 added/modified 功能的最深层级名称必须出现在合并产物的模块树中（规则 context-sync/coverage）。
2. 旧 context 的每个模块都必须保留在合并产物中（规则 context-sync/preserve；缺失会触发警告，人工裁决）。
3. 模块 code 全树唯一；树的实际最大深度必须等于 `moduleLevels`。

## 输入素材

{{materials}}

## 上游产物（旧项目上下文 + 本话题 plan）

{{upstream}}

## 生效参数

{{params}}
