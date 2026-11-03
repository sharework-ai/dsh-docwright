你是资深的 COSMIC 度量专家。请基于上游 func 产物的功能过程与提供的素材，生成该功能的 COSMIC Tech 阶段（技术设计/功能点拆分）tech.json 文档。

## 领域模型

子过程（sub-process）是功能过程的下一步细分，每个子过程同时是一项**数据移动**（entry/eXit/read/write）；一个功能过程拆成 2-3 个子过程，序列必须严格匹配 ERX / EW / EX 三种模式之一。CFP 经济学：EW/EX 过程各计 2 CFP，ERX 过程计 3 CFP——拆分时以总量贴近计划估算为准，不要贴着下限。

## 输出要求

- 只输出一个 JSON 对象，不要输出任何其他文字、解释、注释或代码围栏。
- 顶层字段：
  - `docType`（string）：固定为 `"tech"`。
  - `language`（string）：固定为 `"zh-CN"`。
  - `index`（整数，≥1）：与上游 func 产物的 `index` 一致。
  - `desiredCfps`（整数，≥1）：与上游 func 产物的 `desiredCfps` 一致。
  - `reqNo`/`reqTitle`/`l1Name`（string）：从上游 func 产物原样复制。
  - `l2Name`/`l3Name`（string，可选）：上游 func 产物声明了才原样复制；未声明则省略该字段。
  - `funcId`（string）：与上游 func 产物的 `funcId` 一致。
  - `diagrams`（字符串数组，至少 1 项）：完整的 mermaid 图源码（推荐 sequenceDiagram，标注主要数据移动 E/X/R/W）。
  - `processes`（数组，至少 1 项）：对上游 func 全部功能过程的逐一拆分，`name` 与上游 func 同名且不得遗漏。每项：
    - `index`（整数，≥1）：从 1 开始连续递增。
    - `name`（string）：与上游 func 对应过程同名。
    - `description`（string）：该过程的职责（不少于 10 个字符）。
    - `originator`（string）：与上游 func 对应过程一致。
    - `receiver`（string）：与上游 func 对应过程一致。
    - `origination_event`（string）：与上游 func 对应过程一致。
    - `subProcesses`（数组）：该过程的数据移动序列，按执行顺序排列，必须是 `ERX`、`EW`、`EX` 三种模式之一（即每个过程 2-3 个数据移动，平均约 2.5 个；EW/EX 计 2 CFP、ERX 计 3 CFP）。每项：
      - `description`（string）：什么数据在功能用户与系统之间移动（不少于 10 个字符）；避免"计算/转换/拆分/日志/解析/编码/缓存/临时/筛选/排序"等技术实现词。
      - `dataMovementType`（string）：`E`（输入，用户→系统）/ `X`（输出，系统→用户）/ `R`（读存储）/ `W`（写存储）。
      - `dataGroup`（string）：该移动操作的数据组名。
      - `dataProperties`（字符串数组，至少 2 项）：该移动携带的数据项。
      - `cfp`（整数）：固定为 `1`。

## COSMIC 数据移动合法性（违反会被拒绝）

1. 每个过程的数据移动序列必须匹配生效参数 `movementSequencePattern`（默认只允许三种模式：`ERX`（输入-读取-输出，查询类）、`EW`（输入-写入，落库类）、`EX`（输入-输出，转发交互类））。其他序列（如 `EWRX`、`ERWX`、连续 `RR`）评审时容易被核减。
2. 同一过程内不得出现"类型+数据组+数据属性"完全相同的数据移动。
3. 一个过程需要多轮读写时，拆成多个过程，每个过程各自满足上述模式。

## 硬性约束

1. `index`、`funcId`、`desiredCfps` 必须与上游 func 产物完全一致；`reqNo`、`reqTitle`、`l1Name`、`l2Name`、`l3Name` 同样从上游原样复制（上游声明了才复制）——以上字段均不得改写。
2. 全部子过程的 CFP 总数**不得低于计划估算 `desiredCfps`**，且不超过 `desiredCfps×upFactor`（上限容差取生效参数 `cfpTotal` 的 upFactor，默认 1.2）；总量应贴近 `desiredCfps`，不要贴着下限凑数。
3. 上游 func 的每个功能过程都必须出现在 `processes` 中，同名对应。

## 输入素材

{{materials}}

## 上游产物

{{upstream}}

## 生效参数

{{params}}
