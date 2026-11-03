你是资深交付经理。请基于上游 COSMIC 链产物（func：功能过程设计；tech：数据移动拆分），为本功能生成一张开发团队可直接领用的《功能开发任务卡》task-card.json 文档。任务卡不重新设计任何内容——它把上游已经绿过的产物按领用版式重组：每行任务对应上游的一个数据移动。

## 领域模型

任务卡（task card）是把估算产物转成开发工作指令的交接文档：一张卡对应一个功能（funcId），卡上的每个任务对应上游 tech 产物的一个数据移动（E/X/R/W），任务的 CFP 与上游完全一致（不重新估算），预计人时按部署折算系数（生效参数 effortHoursPerCfp）由 CFP 换算。验收要点从上游业务规则与功能过程行为推导，供评审人逐条核对。

## 输出要求

- 只输出一个 JSON 对象，不要输出任何其他文字、解释、注释或代码围栏。
- 顶层字段：
  - `docType`（string）：固定为 `"task-card"`。
  - `language`（string）：固定为 `"zh-CN"`。
  - `index`（整数，≥1）：与上游 tech 产物的 `index` 一致。
  - `funcId`（string）：与上游 tech 产物的 `funcId` 一致。
  - `reqNo`/`reqTitle`/`l1Name`（string）：从上游 tech 产物原样复制。
  - `l2Name`/`l3Name`（string，可选）：上游 tech 产物声明了才原样复制；未声明则省略该字段。
  - `cardId`（string）：`TC-<funcId>`，即把上游 funcId 原样接到 `TC-` 后（如 `TC-KERQ-352-01`）。
  - `summary`（string，≥40 字符）：给开发者的自包含任务概述——建什么、给谁用、关键行为；提炼自上游 func 的 `funcDesc` 与功能过程清单，概述应概括上游功能过程承载的行为；不得出现 TBD/待定/占位 等未定稿标记。
  - `tasks`（数组，≥1 项）：逐行对应上游 tech 的**每个数据移动**，按上游顺序排列，不得遗漏、合并或杜撰。每项：
    - `seq`（整数，≥1）：任务序号，全卡从 1 开始连续递增。
    - `process`（string）：所属功能过程名，与上游 tech 对应过程同名。
    - `dataGroup`（string）：该任务操作的数据组，与上游子过程一致。
    - `movementType`（string）：`E`（输入）/ `X`（输出）/ `R`（读存储）/ `W`（写存储），与上游子过程一致。
    - `description`（string，≥8 字符）：什么数据在功能用户与系统之间移动，从上游子过程描述提炼；不得只写数据组名。
    - `cfp`（整数）：与上游子过程的 `cfp` 一致，不得改写。
    - `hours`（数值）：`cfp × 生效参数 effortHoursPerCfp`，按公式计算，不要手填估算。
  - `acceptance`（数组，≥1 项）：可验证的验收要点，从上游业务规则与过程行为推导。每项：
    - `point`（string，≥6 字符）：一条可观察结果的具体陈述。

## 硬性约束（违反会被拒绝）

1. `index`、`funcId`、`reqNo`、`reqTitle`、`l1Name` 必须与上游 tech 产物完全一致（上游声明了 `l2Name`/`l3Name` 时同样原样复制）——均不得改写。
2. `cardId` 必须匹配 `TC-<funcId>` 格式。
3. `tasks` 与上游数据移动**逐行一一对应**：行数恰好等于上游 tech 全部子过程总数，每行 `process`/`dataGroup`/`movementType`/`cfp` 与上游对应行一致、顺序一致。**不同功能过程下数据组相同的移动行是不同的任务行，全部逐行保留**（包括面向前端展示/接收类看似"不算开发任务"的 E 行）——不得合并、去重、或按自己的语义判断省略任何一行。
4. 每行 `hours` 必须等于 `cfp × effortHoursPerCfp`。
5. `summary` ≥40 字符且不含未定稿标记，并应概括上游功能过程的行为；`tasks[*].description` ≥8 字符；`acceptance[*].point` ≥6 字符。

## 输入素材

{{materials}}

## 上游产物

{{upstream}}

## 生效参数

{{params}}
