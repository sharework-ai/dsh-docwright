你是资深的 COSMIC 概要设计专家。请基于上游 req 产物描述的功能与提供的素材，生成该功能的 COSMIC Func 阶段（概要设计）func.json 文档。

## 领域模型

功能过程（functional process）是把一项 function（一个被新增或修改的底层模块）拆分得到的基本处理单元；每个功能过程必须有发起者（originator）、接收者（receiver）与触发事件（origination event），发起者与接收者应是业务角色或第三方系统，不得是存储设施。

## 输出要求

- 只输出一个 JSON 对象，不要输出任何其他文字、解释、注释或代码围栏。
- 顶层字段：
  - `docType`（string）：固定为 `"func"`。
  - `language`（string）：固定为 `"zh-CN"`。
  - `index`（整数，≥1）：与上游 req 产物的 `index` 一致。
  - `desiredCfps`（整数，≥1）：与上游 req 产物的 `desiredCfps` 一致。
  - `reqNo`/`reqTitle`/`l1Name`（string）：从上游 req 产物原样复制。
  - `l2Name`/`l3Name`（string，可选）：上游 req 产物声明了才原样复制；未声明则省略该字段。
  - `funcId`（string）：与上游 req 产物的 `funcId` 一致。
  - `funcDesc`（string）：功能描述——在上游 req 产物 `funcDesc` 基础上扩写为一段完整描述（约 150-300 字，不少于 40 个字符），覆盖该功能的核心环节、关键业务规则与质量属性（如可靠性、重试、审计），作为需求解决方案文档的功能描述节；仍不得虚构素材中不存在的功能。
  - `diagrams`（字符串数组，至少 1 项）：完整的 mermaid 图源码（推荐 sequenceDiagram，覆盖主要功能过程的交互），每项为一段可独立渲染的图源码。
  - `processes`（数组）：本功能的功能过程清单，数量约 `desiredCfps`÷2.5，且**不得少于 `ceil(desiredCfps/3)`**（下游技术设计按 `ERX`/`EW`/`EX` 三种数据移动模式拆分，每个功能过程最多 3 个 CFP——过程数不足时 CFP 总预算在数学上不可达）。每项：
    - `index`（整数，≥1）：从 1 开始连续递增。
    - `name`（string）：业务对象+业务动作的简短命名（如"收藏商品"），文档内唯一；命名正则由生效参数 `processNameForbiddenPattern` / `processNameSuffixPattern` / `processNameTechnicalPattern` 定义（默认排除"进行/执行/异常处理/设计/校验"等设计与实现字眼、拒绝"处理/过程/闭环/流程/管理"等泛化词结尾、避免"计算/转换/拆分/日志/解析/编码/缓存/临时/筛选/排序"等技术实现词）。
    - `description`（string）：该过程为发起者完成什么（不少于 10 个字符）。
    - `originator`（string）：触发该过程的功能用户或外部系统；必须匹配生效参数 `functionalUserPattern`（默认排除"数据库/文件存储"等存储设施——它们是实现载体，不是功能用户）。
    - `receiver`（string）：响应并实现该过程的系统部分；必须与 `originator` 不同，同样不得是存储设施。
    - `origination_event`（string）：触发该过程的具体事件（不少于 10 个字符）。
    - `dataGroups`（字符串数组，至少 1 项）：该功能过程涉及的主要数据组名（如"收藏请求、收藏记录"），与后续 tech 阶段各子过程的 `dataGroup` 对应。

## 硬性约束

1. `index`、`funcId`、`desiredCfps` 必须与上游 req 产物完全一致；`reqNo`、`reqTitle`、`l1Name`、`l2Name`、`l3Name` 同样从上游原样复制（上游声明了才复制）——以上字段均不得改写。
2. `funcDesc` 不少于 40 个字符，写成一段连贯的自然语言（规则 func/func-desc-min-length 拒绝过短描述）。
3. `processes` 数量不得少于 `ceil(desiredCfps/3)`（规则 func/process-count-vs-budget 拒绝数学上不可达的拆分）。
4. `processes[].name` 在文档内唯一，命名保持业务视角；`originator` 与 `receiver` 必须不同。
5. `processes[].index` 从 1 开始连续递增。

## 输入素材

{{materials}}

## 上游产物

{{upstream}}
