# 设计：cosmic-context 场景链头与领域模型显式化

Status: IMPLEMENTED（2026-10-14，feat/cosmic-context 四 commit 合并）
Date: 2026-10-14
关联: docs/designs/scenario-chains.md（开放问题 3 由本设计定案）、docs/designs/docwright-mvp.md 第 4.x 节、TODOS.md

## 领域模型（场景语义基准，各 pack 措辞与其对齐）

一套 COSMIC 文档的源头是**一项需求（requirement）**。为了实现它：

1. **context**：了解项目架构——背景、简介、模块树（1-3 级，每个模块有缩写代码或序号）、角色（系统角色/组织角色/自然人角色）、第三方系统、各级模块的编号规则、设计思路与原则。用户可不提供素材，缺失部分由模型假定，但必须显式登记。
2. **plan**：根据需求，基于现有系统的模块划分，**规划修改哪些模块、新增哪些模块**——每个被增加或修改的底层模块就是一项 **function（功能）**。
3. **req**：分析**用户故事**与**业务规则**。用户故事是后续流程分析的重要来源（流程到哪个角色或模块、干什么）；用户故事的用户可以是**角色或第三方系统**，可适当引入**顶层模块**。
4. **func**：把每个 function 拆成若干**功能过程（process）**。
5. **tech**：把每个功能过程拆成 **2-3 个子过程（sub-process）**，每个子过程同时是一项**数据移动**（ERX/EW/EX 模式，已实施；合法序列形状由 cosmic-tech 参数 `movementSequencePattern` 定义，此为默认）。

该领域模型同时写入两个家：概念定义进各 pack prompt（单 pack 单词汇表：每个 prompt 只讲本阶段概念）；本节是场景级语义基准。

## 问题

- 项目知识（模块划分、角色、编号规则、设计原则）当前无承载：plan/req/func/tech 各自即兴假设，四次发挥互相矛盾且不可审。
- plan 无模块变更语义（改/增不区分），模块层级固定靠 funcId 两段约定。
- req 的功能用户无类型维度（自然人/组织/系统/第三方系统不分），用户故事主体无措辞指引。
- 第三方系统（项目依赖的外部系统）无承载。

## 目标 / 非目标

目标：项目知识一次生成、全链锚定、可人工修正（seal）；模块变更显式化；角色与第三方系统进 schema；五阶段定位写入 pack description。

非目标：场景级素材机制（已否决，见 scenario-chains）；req/func/tech 强制消费 context（v1 仅 plan 接链；req/func/tech 均可经 `upstream` 数组按需携带 context——req 参考角色与第三方系统、func/tech 参考模块与原则——prompt 邀请而非强制）；模块代码位置存在性校验（规则引擎不触文件系统，`path` 可为空且不校验）；context→plan 的完整层级链逐段对账（v1 做 modified ∈ / added ∉ context 的 code 引用对账与新增编号规则校验，全链逐段对齐留 v2）。

## 作用域与工作区布局

输入与产物分两个作用域——**workspace 级**（跨话题共享，如项目知识）与 **topic 级**（一个具体话题/需求的工作集）。作用域是通用机制而非 cosmic 专属概念（其他场景包同样适用），由 pack 声明：

- **manifest `scope`**：`"workspace" | "topic"`（缺省 `"topic"`，loader 校验值域）。cosmic-context 与 cosmic-context-sync 声明 `workspace`；其余 pack 缺省 `topic`。
- **manifest `reuse`**：布尔，与 scope 正交——scope 决定产物/素材落在哪级目录，reuse 决定 doc_generate 是否做"已有合格产物即复用"预检。机制对所有 scope 通用，**默认值按作用域语义区分**：workspace pack 缺省 `true`（cosmic-context 项目分析只做一次；cosmic-context-sync 显式 `false`——同步是动作，每次执行）；topic pack 缺省 `false`——topic 产物紧跟需求推进语义（扇出逐个推进、参数试调都要新鲜生成），缺省不复用。topic pack 声明 `reuse: true` 属 pack 作者的显式选择：素材新鲜度有回执清单对账兜底（见"复用预检"），但必须确认其全部输入类可对账（materials 清单、upstream 锚点、params 漂移策略）。调用方 `force: true` 始终可绕过预检。

```
workspaceRoot/
  references/              ← 项目参考知识（架构文档、模块图、编号规范——workspace 级分析类 pack 的备料）
  input/                   ← 用户输入（一次工作事项的需求文档等工作产物）
  context/                 ← workspace 级产物目录（约定名）
  <topic>/                 ← topic 目录（一个工作事项一个，如 REQ-142 收藏夹）
    input/                 ← topic 级用户输入（优先于工作区级）
    references/            ← topic 级参考知识
    output/                ← topic 级产物
```

**references 与 input 语义分离，不得混用**：`references/` 是项目级参考知识（跨工作事项共享的背景材料），`input/` 是一次工作事项的用户输入（驱动本次生成的需求文档）。素材目录由 manifest `materialsRoot` 声明（缺省 `references`；cosmic-plan 声明 `input`——需求文档是 plan 的生成输入）。topic 级 pack 的素材 ref 先在 `<topic>/<dir>/` 解析、落空再落到工作区级 `<workspace>/<dir>/`（topic 自己的输入遮蔽共享目录）；workspace 级 pack 固定 `<workspace>/<dir>/`。

- **topic 参数**：`doc_generate` 的 `topic`（单段目录名 `[A-Za-z0-9._-]`，confine 校验在 workspaceRoot 内）对声明 `requiresTopic: true` 的 pack **必填**（2026-10-14 真实会话复盘后收紧：cosmic 链四阶段 plan/req/func/tech 一个需求一个 topic，缺失调用期明确报错；manifest 声明，引擎不做包名硬编码）；其余 pack 缺省行为不变；`doc_validate` 不设该参数——复验全由产物路径驱动。给定后：产物根为 `<topic>/output/`、素材根为 `<topic>/references/`；缺省维持现状（workspaceRoot 根下的 `output/`、`references/`）——既有调用与测试零迁移。workspace scope 的 pack 忽略 topic（固定 workspace 级目录：素材 `references/`、产物 `context/`）。
- **复用预检**（`reuse: true` 的 pack，机制对所有 scope 通用）：doc_generate 生成前扫 `context/`，命中需同时满足：同 pack 产物、sidecar 回执 `isValid === true` 且版本与已安装 pack 一致、**产物当前 hash 与回执记录一致**（产物 staleness 对账）、**本次调用的素材清单与回执 `materials` 清单逐项相等**（输入新鲜度对账，均不重跑 LLM 校验）、链式 pack 还需**本次 upstream 校验后的锚点与回执 `upstreamHashes` 逐项相等**（上游重生成即级联失效下游复用）、**本次调用寻址的确定性产物名与扫描文件一致**（扇出寻址：targetIndex 2 绝不复用功能 1 的产物；仅时间戳缺省名按文件名无关扫描）；**显式传入非寻址类 params 跳过复用**（交给正常路径的 paramDriftPolicy）。素材清单是生成时引擎记录的 canonical ref + 内容 sha256（inline 素材记 `#!inline` 标记 + 内容 hash，双重前缀拼写归一为实际读取路径），按集合比对（与顺序无关，重复计数）——素材被改、多传、少传任一漂移即落正常生成闭环；素材文件不可读则明确报错（调用方点名的输入缺失，不静默吞）。回执无 `materials` 字段（旧格式）一律不复用，重生成一次即补齐。命中返回 `reused: true` + 原回执，除非调用方显式 `force: true`。doc_validate seal 回签时原样携带 `materials`（复验只证内容，不改输入基线），人工修正后的产物经 seal 重新可复用。
- **doc_chain_status**：从 `plan` 参数的路径推断输出根（plan 所在目录即 output 根），topic 目录自然生效，不加参数。
- 产物路径对下游照旧是 workspace-relative（如 `context/cosmic-context-….json`、`req-2026-001/output/plan.json`），`upstream` 传递与 confine 校验不变。
- **upstream 是内容注入，不是引用**：doc_generate 把 upstream 产物全文渲染进该次调用的 prompt（`{{upstream}}` 槽）——LLM 自身无法读文件，"仅传路径"要么模型读不到、要么经额外工具读取后同样进上下文，无节省反多往返。成本量级：context 产物典型 1-2k token，每次 doc_generate 注入一份；修复循环内每轮 prompt 重建时都在，但**不跨调用累积**（会话持久负担只有回执，回执记录的是 upstream hash 而非全文）；promptTokenBudget 预检（既有）兜总量。req/func/tech 按需携带 context 的实际开销即此量级，不构成上下文灾难；若未来 context 产物膨胀，节流手段是按 pack 裁剪注入视图（如 req 只注入 roles/thirdPartySystems），留作观察项不预先实现。
- **随行上游（rider）**：consumes 之外、已安装 pack 的合格回执产物（回执合格 + hash + 版本策略全量校验后）可作为随行上游进入 prompt 与函数规则 context——"按需携带 context"由此承载；链式 pack 的 upstream 至少须含一个 consumed 类型，缺失明确报错（链契约不因 rider 松动）。

## 设计

### 1. cosmic-context pack（新链头）

- manifest：`name: "cosmic-context"`、`consumes: []`、`scope: "workspace"`、`reuse: true`、双语、参数 `moduleLevels`（共享，见下）。description（见"description 文案"节）。plan 声明 `materialsRoot: "input"`（需求文档是用户输入，落 `input/` 不落 `references/`，见工作区布局节）；req/func/tech 声明 `reuse: true`（链式复用，输入类全部有锚：materials 清单、upstream 锚点、params 漂移策略、pack 版本校验）。
- schema（`docType: "context"`，顶层字段）：
  - `projectName`（string，非空）
  - `background`（string，业务背景，minLength 20）
  - `overview`（string，系统概述，minLength 20）
  - `modules[]`：一级模块 `{ name, code, path?, responsibility, children? }`；`children[]` 二级 `{ 同构 }`；`children[].children[]` 三级。**schema 恒表达三级结构**（两层内联 children，第三层无 children 字段——这就是 schema 能表达的嵌套深度上限）；**实际树深由共享参数 `moduleLevels` 明确**（1-3，default 2，context 与 plan 声明同名参数沿回执继承）。两个不同概念，勿混：`code` 是**模块编号**（缩写代码或序号，必填，pattern `^[A-Za-z0-9]{1,8}$`，全树唯一——它是模块的身份，funcId 的段即模块 code 链）；`path` 是**模块对应的代码位置**（可选元数据，允许为空；规则引擎不触文件系统，path 不做存在性校验）
  - `roles[]`: `{ name, kind: "person" | "organization" | "system", description }`（项目内角色三分类）
  - `thirdPartySystems[]`: `{ name, purpose, interaction }`（第三方系统： purpose=它是什么，interaction=本系统与它如何交互）
  - `moduleIdConventionForLevel1`（必填）、`moduleIdConventionForLevel2/3`（可选，各 enum `"numeric" | "alphabetic"`）：**每一级模块的编号规则**——数字序号或字母缩写；随项目模块级数而定：树用到第 N 级，则 Level1..N 的规则必须声明。模块编号规则在 plan 阶段**新增模块时**用于分配编号
  - `designPrinciples[]`: string 非空数组
  - `assumptions[]`: string 数组（模型假定条目的显式登记，可为空）
- 规则（克制：结构/枚举由 schema 承担，规则只做跨节点语义与参数联动）：
  - `context/module-code-unique` [error]：全树（三层）模块 code 唯一——函数规则整产物视角遍历
  - `context/module-depth` [error]：树的实际最大深度必须等于生效参数 `moduleLevels`（读 `context.params`，cfp-total-band 先例）
  - `context/module-id-convention` [error]：第 N 级（N ≤ moduleLevels）模块存在但 `moduleIdConventionForLevelN` 缺失
  - `context/assumptions-review` [warning]：`assumptions` 非空时提示"以下条目为模型假定，采纳前请审阅；修正后可用 seal 回签重新入链"
- prompt 契约要点（双语）：有素材则抽取结构化；素材未覆盖的部分按通用工程惯例假定且**逐条登记进 assumptions**；模块树 1-3 级、code 用于 funcId 段；角色三分类；第三方系统单列。
- golden：与现有 cosmic golden 同源（电商收藏示例），`assumptions: []`（全 issue 清零标准）。

### 2. 链接入：plan consumes context

- plan manifest `consumes: ["cosmic-plan"] → ["cosmic-context"]`；plan 新增函数规则 `plan/context-alignment` [error]：upstream 须含 `docType: "context"` 合格产物（缺失/非 context 明确报错，模式与 func-alignment 一致），并做**引用对账**——plan 中 `changeKind: "modified"` 的 function，其模块 code 必须已存在于 context 模块树；`changeKind: "added"` 的 code 必须**不存在于** context（新增不得撞已有编号）且符合 `moduleIdConventionForLevelN`（numeric 段全数字、alphabetic 段全字母）。
- req/func/tech 的 consumes 不变（plan→req→func→tech 主链）；它们需要项目知识时由模型在 `doc_generate.upstream` 数组按需携带 context（prompt 邀请）。
- `doc_chain_status` 不变：coverage 定义在 plan functions 扇出上，context 是项目级单产物不参与扇出。

### 3. plan 的模块变更显式化

- `functions[].changeKind`（必填，enum `"added" | "modified"`，schema required）——对应"每个被增加或修改的底层模块就是一项 function"。
- 新增共享参数 `moduleLevels`（number，1-3，default 2，context 与 plan 声明同名参数、沿回执继承）：在 plan 侧校验 l1/l2/l3 名称的必填性（levels≥2 时 l2Name 必填，levels=3 时 l3Name 必填）与 funcId 段数下限（≥moduleLevels）。schema 对 l2Name/l3Name 保持 optional（schema 静态、参数驱动策略），精确必填性由新函数规则 `plan/name-hierarchy` [error] 读参数校验——schema 管结构合法性，规则管策略，现有分层原则。
- v1 不做：funcId 段数与模块 code 链的逐段对账（留 v2，机制同 plan-alignment 族）。

### 4. req 的用户故事主体与角色类型

- `functionalUsers[]` 增 `kind`（必填，enum `"person" | "organization" | "system" | "3rd-party"`，schema 层）。
- prompt 更新：用户故事的用户可以是**角色（来自 context.roles）或第三方系统（来自 context.thirdPartySystems）**；流程性故事可适当引入**顶层模块**（流程到哪个模块、干什么）。
- v1 不做：role/kind 对 context.roles 的引用校验（upstream 不强制传 context 时无从对账；留 v2 随"func/tech 按需携带 context"一起评估）。

### 5. 产物文件命名

req/plan/func/tech 产物**不需要特别的编号规则**：沿用既有 `artifactName` 机制（调用方自由命名，`[A-Za-z0-9._-]` basename）。cosmic 场景的命名约定（如 `需求编号-plan-01.json`）属调用方习惯，由说明书给出建议示例，引擎与 pack 不感知。context 产物同理（默认 `<pack>-<timestamp>` 亦可，复用预检按 pack + 回执匹配而非文件名模式）。

### 6. cosmic-context-sync（同步 pack，workspace 级）

plan 规划通过并落地后，把"本次 topic 修改/新增的模块"合并回项目 context，使项目知识随需求持续演化：

- manifest：`name: "cosmic-context-sync"`、`scope: "workspace"`、`reuse: false`（同步是动作，不被复用预检拦截）、`consumes: ["cosmic-context", "cosmic-plan"]`（复用既有上游验证通道：upstream 缺失或不合格在工具层即时明确拒绝，零 LLM 开销；`doc_chain_status` 的阶段游走跳过 workspace 级 pack，扇出矩阵不受影响）、schema 与 cosmic-context 相同（产物是 `docType: "context"` 的新版本）、双语。
- 调用：`doc_generate(pack: "cosmic-context-sync", topic: "<topic>", upstream: [<context 路径>, <topic>/output/<plan 路径>])`——upstream 显式传旧 context 与该 topic 的合格 plan（模型可见 ⟺ 日志可重建；工具不做隐式扫描），upstream 缺失或非合格回执 fail loud。触发时机写进工具描述：plan 阶段合格后可用。
- 生成：LLM 以旧 context + plan 为输入产出合并后的 context（新增模块插入对应层级并按 `moduleIdConventionForLevelN` 分配编号、修改模块更新职责描述），走标准闭环（生成 → 校验 → 修复循环）。
- 规则（函数规则读 upstream，在 context 自身四条规则之外）：
  - `context-sync/coverage` [error]：plan 中每个 function（changeKind 为 added/modified）的最深层级名称（l3Name ?? l2Name ?? l1Name）必须存在于合并产物的模块树 name 集——v1 语义按 name 匹配，funcId 段与模块 code 的逐段对账留 v2
  - `context-sync/preserve` [warning]：旧 context 的模块在合并产物中缺失时提示（防合并丢模块；确属模块下线场景由人工 seal 裁决）
- 测试纳入既有 cosmic 系列 spec 模式（见实施切分），golden 复用 context/plan golden 作输入、scriptedLlm 返回合并产物。

### 7. description 文案（manifest，英文，风格对齐现有）

- **cosmic-context**：`COSMIC project context: project background, overview, module tree (up to 3 levels with abbreviation codes), roles (person/organization/system), third-party systems, ID conventions, and design principles; generated from materials, with model-assumed items explicitly registered (root pack, no upstream consumed).`
- **cosmic-plan**：`COSMIC function-point estimation plan: given one requirement and the green project context, plan which modules to add or modify — each changed leaf module becomes one function with hierarchical names and estimated CFPs (consumes a green cosmic-context artifact).`
- **cosmic-req**：`COSMIC requirements analysis for one plan function: functional description, functional users (roles or third-party systems) with user stories — the primary source for later flow analysis (which role or module does what) — and business rules (consumes a green cosmic-plan artifact).`
- **cosmic-func**：`COSMIC functional-process design for one function: decomposes the function into functional processes (originator, receiver, origination event) refined from a green cosmic-req artifact.`
- **cosmic-tech**：`COSMIC technical breakdown: decomposes each functional process into 2-3 subprocesses — data movements (E/X/R/W) — with exact CFP counts checked against the budget, refined from a green cosmic-func artifact.`
- **cosmic-context-sync**：`Sync the modules planned in one topic's green cosmic-plan artifact (added or modified) back into the workspace-level project context, producing a refreshed green context; usable once the plan stage passes (workspace scope, requires topic + green plan and context upstream).`

## 引擎影响评估：三处增强，其余现成

作用域模型（workspace/topic 两级 + 复用预检）是本轮唯一超出既有机制的增量：

| 增强点 | 内容 | 量级 |
|---|---|---|
| 1. manifest `scope` + `reuse` 字段 | loader 声明与校验（scope：`workspace`/`topic` 缺省后者；reuse 布尔按 scope 语义取默认、显式声明覆盖） | 小 |
| 2. `doc_generate` 的 `topic` + `force` 参数 | 产物根/素材根按 `<topic>/` 解析（单段名 + confine 校验）；workspace pack 忽略 topic；缺省行为不变；`force` 绕过复用预检 | 小 |
| 3. workspace 复用预检 | doc_generate 对 `reuse: true` 生成前扫产物根：同 pack + 合格回执 + 版本一致 + hash 对账命中即复用（`reused: true`，零 LLM） | 中 |
| 4. 随行上游（rider） | consumes 之外已安装 pack 的合格产物放行注入；链式 pack 至少一个 consumed 类型 | 小 |
| 5. doc_chain_status 输出根推断 + workspace 排除 | 输出根 = plan 所在目录；阶段游走跳过 workspace 级 pack | 小 |

复用判定复用既有 hash 对账机制（staleness 语义），不新增校验逻辑。以下需求全部落在既有机制内：

| 需求 | 承载机制 | 结论 |
|---|---|---|
| context 作链头、plan 接链 | consumes 声明 + upstream 合格回执校验 + 函数规则 context 注入（D3/D6） | 现成 |
| moduleLevels 驱动的层级/树深校验 | 函数规则 `check(artifact, context)` 读 `context.params`（cfp-total-band 先例） | 现成；schema 静态故精确校验放规则层——既有分层原则，非新缝隙 |
| 模块树三层校验 | schema 恒表达三级结构（两层内联 children）+ 函数规则遍历（唯一性/深度/编号规则联动）——声明式 `given` 不支持嵌套是已定案边界（说明书 4.8） | 现成 |
| 角色 kind / changeKind 枚举 | schema enum | 现成 |
| assumptions 警告 | warning 函数规则 | 现成 |
| context-sync 合并 pack | 标准 pack 闭环 + upstream 多路径 + topic 参数定位；coverage/preserve 为函数规则 | 现成（pack 层，无引擎改动） |
| context 更新后下游失效 | 回执 hash 对账 + staleness（Sprint 4 机制） | 现成 |
| topic 目录下的链编排 | upstream 传 workspace-relative 路径（含 topic 前缀）+ doc_chain_status 从 plan 路径推断输出根 | 现成 + 推断一处 |
| 人工修正 context 后重新入链 | seal 回签（D7）；修正后 hash 变化，下次生成预检不命中，语义自洽 | 现成 |

引擎增强的验收约束：实施分支对 `src/` 的改动**仅限** pack-loader（scope/reuse 校验）与 tools/doc-service（topic 解析 + 复用预检）两处，其余文件不动。

## 实施切分（确认后按仓库惯例走 `feat/cosmic-context`）

- **S0 引擎**：manifest `scope`/`reuse` 校验 + `doc_generate`/`doc_validate` 的 `topic` 参数与产物/素材根解析 + workspace 复用预检（`reused`/`force`）+ doc_chain_status 输出根推断 + 测试。
- **S1 契约与链**：cosmic-context pack 全套（manifest/schema/prompts/templates/rules/golden，`scope: "workspace"`、`reuse: true`、`moduleLevels` 参数）+ plan 接链（consumes、context-alignment、changeKind、name-hierarchy）+ 全部既有链测试前置 context 生成步。
- **S2 同步 pack**：cosmic-context-sync 全套（`scope: "workspace"`、`reuse: false`、coverage/preserve 规则、golden）+ 测试。
- **S3 文案与文档**：六 pack description（含 sync）+ req prompt 用户故事主体 + req `functionalUsers[].kind` + 四 pack prompt 领域模型措辞对齐 + 说明书（4.x context/sync 节 + 领域模型节 + 作用域布局节）+ scenario-chains 开放问题 3 定案 + TODOS。
- 单分支四个 commit（S0 引擎、S1 pack、S2 sync、S3 文档），`--no-ff` 合并。
- **测试集**：新增 `tests/cosmic-context.spec.ts`、`tests/cosmic-context-sync.spec.ts`，沿用既有 cosmic 系列 spec 模式（pack shape 断言 / golden 双语全部合格 / mutation guardrail-is-real / 确定性 LLM 链生成），与 cosmic-plan/req/func/tech 四个 spec 并列。

## 验收标准（草案）

1. cosmic-context 双语全部合格（golden 无任何 issue）；module-code 重复触发 error；moduleLevels=2 时三级树触发 module-depth error、缺 Level2 编号规则触发 module-id-convention error；assumptions 非空触发 warning。
2. plan 无 upstream 或 upstream 非 context 时，`plan/context-alignment` 明确报错；带合格 context 全链 context→plan→req→func→tech 确定性生成 PASS。
3. `changeKind` 缺失/非法值被 schema 拒绝；moduleLevels=3 时缺 l3Name 报 error，levels=1 时仅 l1 必填。
4. req `functionalUsers[].kind` 非法值被 schema 拒绝；prompt 含"角色或第三方系统、顶层模块"指引。
5. 六 pack description 更新且 `doc_packs` 渲染正确。
6. **作用域**：`topic: "req-a"` 时产物落 `req-a/output/`、素材根 `req-a/references/`；workspace 产物固定落 `context/`、素材根 `references/`；`doc_chain_status` 在 topic 目录下从 plan 路径正确推断输出根。
7. **复用**：已有合格 context（回执 valid、hash 一致、素材清单与本次调用逐项相等）时再调 doc_generate 不调 LLM、返回 `reused: true`；素材被改/多传/少传、产物被改（hash 不符）或回执不合格时重新生成；无 `materials` 字段的旧回执不复用；`force: true` 强制重建；seal 回签后的产物重新可复用；cosmic-context-sync 不受预检拦截（`reuse: false`）。
8. **同步**：sync 以旧 context + topic 的合格 plan 生成合并 context；plan 中 added/modified 模块缺失触发 `context-sync/coverage` error；旧模块丢失触发 `context-sync/preserve` warning。
9. 引擎改动仅限 pack-loader 与 tools/doc-service（scope/reuse 校验、topic 解析、复用预检）。
10. 全部测试 + 覆盖率阈值 + typecheck + build + host-smoke PASS。

## 开放问题

1. context→plan 的完整层级链逐段对账（funcId 每一段与 context.modules 对应层级的 code 链逐段对齐）——v2 候选；v1 已覆盖叶子级引用对账与新增编号规则校验。
2. func/tech 是否升级为强制消费 context（consumes 双上游）——等真实生成中出现"下游缺项目知识"的具体失败再定。
3. E003 推广为"originator/receiver ∈ roles ∪ thirdPartySystems"——同上，v2 候选。

## 已否决（已定案，不再重开）

> 重新提议备选前先读否决原则；触及原则的变体视为已答。

### 已否决：场景级素材机制承载项目知识

- 否决原则：**项目知识是场景链的第一个产物，不是一种特殊素材类型**——产物可校验、可锚定、可 seal 修正，素材不可；且"用户可不提供"的正确实现是显式登记假设（assumptions），而非各阶段隐性即兴发挥。

### 已否决：项目知识做成生成参数（params）

- 否决原则：**参数是标量旋钮，不是知识载体**——模块树/角色清单是变长结构，params 走确认流程会把它变成每次生成的交互负担，且无法回签修正。

### 已否决：大而全的"领域词典素材"注入各阶段

- 否决原则：**单 pack 单词汇表**——每个 prompt 只讲本阶段概念（plan 讲模块/function、func 讲过程、tech 讲子过程=数据移动）；共享词典破坏聚焦，方法论属 pack 契约而非用户可替换素材。
