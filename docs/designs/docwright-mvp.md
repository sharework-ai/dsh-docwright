# docwright 功能说明书（MVP）

Status: CURRENT — 本文描述插件现状，与代码不一致时以代码为准。
Repo: sharework-ai/dsh-docwright
Updated: 2026-10-14

> 本文前身是 2026-08-27 /office-hours + /autoplan 产出的设计决策文档（含 44 条决策审计、评审报告）。现已重写为 current-state 功能说明书；遵循"规格零历史"纪律，正文不含设计推演——原决策过程记录只在 git 历史中（`git log -- docs/designs/docwright-mvp.md`），进行中的设计提案见 docs/designs/ 下各 PROPOSED 文档。

## 1. 产品定位

docwright 是 deepseek-harness（dsh）的文档生成插件：AI 生成结构化 JSON 文档 → 强制校验 → 不合格打回重写，直到全绿；每份文档自带机器可读的验证回执，任何人可离线复验。

解决的问题：AI 大量生成文档时质量不可控、结果不可验证。

读者可能会问：让 LLM 输出 JSON 并在校验失败时自动重试，不是已经有现成轮子了吗？确实有——instructor、BAML、Guardrails AI 这类结构化输出框架都内置"schema 校验 + 重试"。但它们只判断**结构对不对**（字段齐不齐、类型对不对），判断不了**内容合不合格**——"功能描述要写满 80 字""名称不许用'管理/系统'这类泛化词""估算值总和要落在业务区间"这类标准因文档类型而异，框架无从知晓。

docwright 的差异化就在"内容合格性"这一层，由三件事组成：

1. **领域规则包（pack）**：每类文档的合格标准（schema + 领域规则 + prompt + 模板）声明在可插拔的数据包里，换文档类型不换代码；
2. **可复验回执（receipt）**：校验结果作为机器可读文件随文档落盘，任何人可事后复验——"全绿"从一次过程变成一件产物；
3. **闭环修复**：校验不过自动把问题清单喂回模型重写，直到全绿或明确失败。

与结构化输出框架相比，差异不在"会不会重试"，而在**合格标准可插拔（pack）、校验结论可复验（receipt）**。安装与上手（quickstart、工具示例）见仓库根 README。

## 2. 核心概念

| 概念 | 是什么 | 由谁提供 |
|---|---|---|
| **插件（docwright）** | 引擎：闭环、校验执行、回执、路径安全、dsh 工具注册。不含任何文档领域知识 | 本仓库 TypeScript 代码 |
| **pack（场景包）** | 内容：一类文档的 schema、规则、生成 prompt、渲染模板、golden 样例。纯 JSON 数据 + 至多一个 JS 规则文件 | `packs/<name>/` 目录，任何人可编写 |
| **闭环（repair loop）** | 生成 → 校验 → 把 Issue 喂回模型重写 → 直到全绿或迭代耗尽 | 插件 |
| **验证回执（receipt）** | 全绿状态的机器可读快照（产物哈希、规则集快照、逐规则结果），随产物落盘，可离线复验 | 插件生成；pack 提供被快照的规则 |

一句话分工：**换文档类型 = 新写一个 pack 目录，插件零改动；改闭环/校验/回执行为 = 改插件。**

### 2.1 COSMIC 场景链与领域模型（各 pack 措辞的语义基准）

一套 COSMIC 文档的源头是**一项需求（requirement）**。为了实现它，五个阶段各回答一个问题：

1. **context**（cosmic-context）：项目架构是什么——背景、概述、模块树（1-3 级，每模块有编号 code）、角色（person/organization/system 三分类）、第三方系统、各级编号规则、设计原则；素材未覆盖处由模型假定并**显式登记进 assumptions**。
2. **plan**（cosmic-plan）：改哪些模块——基于 context 模块树规划**新增/修改**（`functions[].changeKind`），每个被增加或修改的底层模块就是一项 **function**；funcId 的分段即模块 code 链。
3. **req**（cosmic-req）：一项 function 的需求分析——功能描述、功能用户（kind 四分类，用户故事主体是**角色或第三方系统**，流程性故事可引入**顶层模块**）与用户故事、业务规则；用户故事是后续流程分析的主要来源。
4. **func**（cosmic-func）：一项 function 拆成若干**功能过程（process）**（发起者/接收者/触发事件）。
5. **tech**（cosmic-tech）：每个功能过程拆成 2-3 个**子过程**，每个子过程同时是一项**数据移动**（ERX/EW/EX 模式）。

概念定义住在各 pack 的 prompt 里（单 pack 单词汇表，每个 prompt 只讲本阶段概念）；本节是场景级语义基准。项目知识（context）由 plan 消费入链；req/func/tech 需要项目知识时经 `doc_generate.upstream` 按需携带（见 3.5）。

## 3. 插件功能（机制层）

插件导出 `name: 'docwright'`、`inject: ['tools', 'llm']`、`Config`；`apply()` 时加载全部 pack 并注册五个工具（`doc_packs` / `doc_generate` / `doc_extract_params` / `doc_validate` / `doc_chain_status`）。pack 加载失败（坏 manifest、坏规则、Config 默认语言不被支持）在 apply 期直接报错，不会带病进入会话。

### 3.0 工具 `doc_packs` — 能力发现（拉式）

零参数工具，返回已装载 pack 注册表 `[{ name, version, description, languages, consumes }]`。`doc_generate`/`doc_validate` 的描述与 `pack` 参数描述内置静态邀请（先调 `doc_packs`）；未知 pack 报错同时给出 `doc_packs` 提示与可用清单——模型跳过发现时由此自愈。工具描述不随 pack 集合变化（拉式渐进披露，见 docs/designs/capability-discovery.md）。

### 3.1 工具 `doc_generate` — 闭环生成

| 参数 | 类型 | 语义 |
|---|---|---|
| `pack` | string，必填 | pack 名；未知名称报错并列出全部可用 pack |
| `materials` | string[]? | 素材引用。两种形态：相对 materialsRoot（默认 `<workspace>/references/`）的文件路径；或以 `#!inline` 开头的内联文本（显式标记，无启发式判断）。链式 pack 可省略（上游产物文本已入 prompt）；两个都没有时 fail loud 并同时列出两条路 |
| `language` | string? | 输出语言。优先级：tool 参数 > Config `defaultLanguage` > pack 的第一个语言；不被该 pack 支持即调用期报错 |
| `upstream` | string[]? | 上游产物路径（workspace 相对）。仅当 pack 声明了 `consumes` 时必填，见 3.5 |
| `artifactName` | string? | 输出基础名，仅允许 `[A-Za-z0-9._-]` 的纯 basename（拒绝路径形状与 `..`）；缺省时：per-function 调用（targetIndex 可解析）为 `<pack>-<funcId>`（不同功能不冲突、重生成幂等），其余为 `<pack>-<时间戳>`；显式传名逐字生效 |
| `maxRounds` | number? | 当次闭环轮数上限（用户意图经模型转述）；被 Config `maxRoundsCeiling` 硬钳制，任何层不可穿透 |
| `topic` | string? | 话题目录名（`[A-Za-z0-9._-]` 单段，如需求编号）。给定后产物根为 `<topic>/output/`、素材根为 `<topic>/references/`；声明 `requiresTopic` 的 pack **必填**（cosmic 链四阶段 plan/req/func/tech——一个需求一个 topic），workspace 级 pack（见 3.9 作用域）忽略该参数 |
| `force` | boolean? | 绕过复用预检，强制重建 |
| `params` | object? | pack 声明参数（`manifest.params`，doc_packs 可见清单）的覆盖值；未知名称/类型/枚举/越界 fail loud 并列出可用参数 |

前置条件：Config 必须配置 `provider` + `model`（宿主 LLM 编排中的路由名），缺失即调用期报错。

行为：素材读取与首 prompt token 预检 → 闭环（3.2）→ 落盘三个文件（产物 JSON、sidecar 回执、Markdown 渲染），全部 tmp+rename 原子写、产物先于回执落盘（崩溃只会留下可读草稿，不会留下孤儿回执）。

**复用预检**：`reuse: true` 的 pack（workspace 级默认开）在生成前扫描产物根，命中需过全部门关卡：同 pack + 绿回执 + 版本一致 + 产物 hash 一致 + 素材清单逐项相等 + （链式 pack）upstream 锚点相等与寻址产物名一致 + 显式非寻址 params 不在场 → 直接返回该产物（`reused: true` + 原回执），零 LLM 开销；任一漂移或 `force: true` 落正常生成。机制细节以 docs/designs/cosmic-context.md 复用预检节为准。

返回 `{ artifactPath, markdownPath, receipt, summary }`（回执内联全量；`summary` 为产物关键计数——functions/processes/subProcesses/totalCfps，按字段存在性给出，省一次文件回读）；warn 策略下追加 `upstreamWarnings`；per-function pack 追加 `coverage`（本阶段绿色产物相对参照功能集的 `{ covered, total, missing }`——req 参照 plan functions，func/tech 参照上游阶段已覆盖集）。required 的 `targetIndex` 缺失时 fail loud 并列出上游全部候选（index、funcId、l2Name），pendingConfirmation 同样携带 `candidates`。全绿时产物是正式产物；**迭代耗尽时工具抛错（fail loud），但草稿 + 红回执（`isValid: false` + 全部未解决 Issue）保留在磁盘上**，供人工救援，绝不静默采用最后一轮。

### 3.2 闭环修复循环（核心机制）

每一轮：

1. **预算预检**：prompt + 当前产物的估算 token（CJK 字符 ≈1 token/字，其余 ≈4 字符/token）超过 `promptTokenBudget` 即抛错，提示拆分素材或调大预算。
2. **模型调用**：经 `ctx.llm` 单一入口按 provider/model 路由流式调用；传输失败自动重试一次；取消（AbortError）原样透传。调用失败映射为 `internal/llm-error` Issue → 本轮即耗尽，保留已有草稿。
3. **解析**：剥离代码围栏后提取第一个完整 JSON 对象；解析失败映射为 `internal/invalid-output` Issue——与校验失败走同一条修复路径，不单独重试。
4. **校验**：ajv schema 校验（`allErrors`）+ 声明式规则 + JS 函数规则，全部映射为统一 Issue 格式：`{ ruleId, severity: error|warning|info, jsonPath, message, snapshot?(≤80 字截断), suggestion? }`。ajv 违规归并为 `schema/<keyword>` 规则族；修复 prompt、回执、报告只消费这一种格式（统一错误格式是闭环的粘合剂）。
5. **判定**：**全绿 = 0 条 ERROR**（warning/info 不拦截）。全绿即成功返回；否则组装修复 prompt 进入下一轮。

**修复 prompt 组装**：原生成 prompt + 当前产物 JSON + 按 jsonPath 分组、逐条携带 severity/message/suggestion 的 Issue 清单 + 指令"只修复列出的问题，输出完整 JSON，不要改动未列出的部分"。

**收敛检测与提前终止**（详见 docs/designs/convergence-detection.md）：提前终止只决定"何时放弃"，全绿判定始终是 0 ERROR。三层策略由 `oscillation.mode` 选择（默认 `auto`）：

1. **pack 评分**：`functions.js` 导出 `score(artifact, issues)`（0-100 百分制，越高越好；越界/崩溃 fail loud）时启用。连续 K 轮未超过历史最优分（默认 K=3，容忍单轮回撤）→ 终止 reason `stagnation`；连续 D 轮严格下降（默认 D=3）→ reason `decline`。
2. **内置默认评分**（pack 未导出 score 时自动启用）：`clamp(100 − 10×error − 3×warning − 1×info, 0, 100)`，权重可配。
3. **指纹兜底**（`mode: "fingerprint"`）：连续 3 轮 Issue 指纹完全相同 → reason `fingerprint-repeat`。

**迭代上限**：生效轮数 = clamp(`maxRounds` 参数 ?? pack `manifest.maxRounds` ?? Config `maxIterations`（默认 5）, `maxRoundsCeiling`（默认 10，宿主运维持有，任何层不可穿透））。耗尽 → reason `max-iterations`，按失败返回（见 3.1）；模型调用失败 → reason `llm-error`。终止原因与每轮评分（score 模式）写入回执，收敛过程可审计。生成 prompt 的 `{{params}}` 槽位渲染生效参数（模型看得见旋钮），生效参数以 as-run 记入回执。

### 3.3 验证回执（receipt）

sidecar 文件 `<产物名>.receipt.json` 与产物同目录；同时内联在工具返回值里。字段：

| 字段 | 说明 |
|---|---|
| `formatVersion` | 回执格式版本（当前 1） |
| `pack` / `packVersion` | 生成时使用的 pack 名与版本 |
| `language` | 生成语言 |
| `artifactHash` | 产物 canonical JSON（键排序、无空白）的 sha256 |
| `schemaHash` | pack schema 的 sha256 |
| `rulesetSnapshot` | **声明式规则全文**（按语言）+ `functions.js` 源码哈希——pack 升级后历史回执仍可解释当时依据 |
| `upstreamHashes` | 链式锚点：每个上游的 pack/packVersion/artifactHash |
| `iterations` / `rounds` | 闭环轮数；每轮 `{round, errorCount, warningCount}` 及评分（score 模式，0-100）与 `promptHash`（该轮生成 prompt 的 sha256） |
| `rules` | 逐规则 rollup：`{ruleId, severity, status: pass\|fail, count}`；schema 违规归并为 `schema/*` 族 |
| `isValid` | 全绿与否 |
| `terminationReason` | 红回执的终止原因（`stagnation` / `decline` / `fingerprint-repeat` / `max-iterations` / `llm-error`）；绿回执无此字段 |
| `params` | 生效的 pack 参数 as-run（未覆盖即声明默认）；`doc_validate` 默认按它复验 |
| `generatedAt` / `model` | ISO 时间戳；模型标识（复验轮为 `revalidate`） |

**防篡改语义**：`doc_generate` 与 `doc_validate` 共用同一个回执构造器（两种回执永不漂移）。回执是 tamper-evident 而非 tamper-proof——无签名，误改必红，蓄意伪造产物+回执不可防。

### 3.4 工具 `doc_validate` — 确定性复验（零 LLM）

参数：`artifactPath`（workspace 相对路径）、`pack`、`language?`、`params?`、`upstream?`（链式 pack 复验用，同生成时的 workspace 相对路径数组，含随行 rider，见 3.5）。复验全由路径驱动，不设 `topic` 参数。对既有产物用**当前安装的 pack 规则**重跑校验，返回 `{ artifactPath, receipt, hashMatches, packVersionStale, sealed?, summary }`。**seal（回执回签）**：绿色校验把新回执写入 sidecar——发证渠道从「只有生产线（doc_generate）」扩展为「生产线 + 质检站（doc_validate）」，人工/外部编辑的产物借此重新入链；红色校验绝不触碰 sidecar，hash 依旧把合格证绑定到具体内容版本。`sealed: true` 即本次回签；`hashMatches` 仍报告回签前的篡改证据。返回值同时带 `summary` 关键计数。校验默认使用回执记录的 as-run 参数（**按当时的标准复验**）；显式传 `params` 可做 what-if 校验。传入 `upstream` 时走与 `doc_generate` 相同的六项上游校验，解析后的产物注入函数规则 context（跨产物规则得以复验），回执同步记录 `upstreamHashes` 锚点。

- `hashMatches`：`true` 产物与 sidecar 回执哈希一致；`false` 生成后被改动过（篡改可见）；`null` 无 sidecar（如手工拷入的样例）。
- `packVersionStale`：`true` 回执由**另一个 pack 版本**写入——绿回执证明的是旧规则，应重新生成（无版本记录的回执也算 stale）；`false` 版本一致；`null` 无回执。
- `language` 显式传参时必须与回执记录一致，否则报错；缺省时按"参数 > 回执记录 > Config 默认 > pack 首语言"取。

### 3.5 链式消费（`consumes`）

pack 的 `manifest.consumes` 声明其消费的上游产物类型（根 pack 为 `[]`）。`doc_generate` 对每个 `upstream` 引用强制校验，任一不过即报错：

1. 文件可读且为合法 JSON；
2. 存在 sidecar 回执（没有就要求先用 doc_generate 生成）；
3. 回执是**绿**的（红草稿永远不得流入下游）；
4. 回执内 `artifactHash` 与当前文件内容一致（上游被改过即拒绝）;
5. 回执的 pack 类型在消费方的 `consumes` 列表中；
6. 该上游 pack 已安装，且版本 staleness 按 `upstreamVersionPolicy` 处理：`strict`（默认）拒绝版本不符的上游，`warn` 放行但在返回值中附 `upstreamWarnings`。
7. 消费方的 `consumes` 之外、**已安装 pack** 的绿产物可以作为 **rider（随行上游）** 通过验证并注入 prompt 与函数规则 context（如 req/func/tech 按需携带项目 context）——但至少要有一个 consumed 类型的上游，缺失即报错（链契约不因 rider 松动）。上游注入是**内容注入**：全文渲染进该次调用的 prompt，不跨调用累积。

### 3.6 pack 装载（apply 期，fail loud）

装载范围 = 插件内置 `packs/` + Config `packsDir`（同名 pack 后者覆盖前者）。加载期强制校验（任何一条不过，整个插件启动失败）：manifest 字段完整（含 `scope`（`workspace|topic`，缺省 `topic`）与 `reuse`（布尔；workspace 缺省 true、topic 缺省 false，显式声明覆盖））；声明的每种语言都有 `rules/<lang>.json` + `prompts/<lang>.md` + `templates/<lang>.hbs` 三件套；声明式规则逐条校验（severity 枚举、kind 枚举、kind 载荷、pattern 可编译、suggestion 非空）；prompt 必须含 `{{materials}}` 槽位（否则素材会被静默丢弃）；`functions.js` 若存在必须可导入且导出 `rules` 数组；golden.json 必须存在；Config 设了 `defaultLanguage` 时所有 pack 都必须支持它；pack 集合为空报错。

Schema 的 ajv 编译在首次构建该 (pack, language) 的 DocService 时发生（schema.json JSON 语法错误仍是加载期报错）；编译产物按 (pack, language) 缓存，整个插件生命周期只编译一次。空模板渲染出的空 Markdown 也报错。

### 3.7 配置（cordis.yml，no hardcoded tunables）

```yaml
- id: docwright
  config:
    packsDir: ""            # 额外 pack 目录；同名覆盖内置
    workspaceRoot: ""       # 无会话 workspace 时的兜底根（默认 cwd）
    materialsRoot: ""       # 素材根（默认 <workspace>/references）
    outputRoot: ""          # 产物根（默认 <workspace>/output）
    defaultLanguage: "zh-CN"
    maxIterations: 5        # 闭环轮数全局默认
    maxRoundsCeiling: 10    # 轮数绝对上限（宿主运维持有，任何覆盖不可穿透）
    promptTokenBudget: 60000
    upstreamVersionPolicy: "strict"  # 链式上游版本不符：strict 拒绝 / warn 放行并告警
    oscillation:            # 收敛检测（提前终止策略，详见 docs/designs/convergence-detection.md）
      mode: auto            # auto | score | fingerprint
      stagnantRounds: 3
      decliningRounds: 3
      maxRepeats: 3
      epsilon: 0
      defaultScore: { error: 10, warning: 3, info: 1 }
    provider: "deepseek-official"    # 宿主 LLM 路由名（必填才能 doc_generate）
    model: "deepseek-chat"
```

workspace root 决策链：会话 workspace（如 dsh web UI 选择的目录）> `workspaceRoot` > 进程 cwd。`materialsRoot`/`outputRoot` 可相对（拼接到 workspace root）可绝对，但**必须落在 workspace root 内**，越界报错。Linux 宿主上，传给任何路径参数的 Windows 盘符路径（`D:\x\y`）先经 `wslpath` 归一化为 WSL 挂载点（带正则兜底）。注意：`provider` 路由名不存在时不报响错而是空流——doc_generate 第一轮报 llm-error 时先核对适配器注册的路由名。

### 3.8 路径与信任模型（安全边界）

- **三重路径包含**：素材路径做词法 + realpath 双重校验（工作区内软链指向外部也拒绝）；`artifactPath`/`upstream` 与两个 root 同样被限制在 workspace root 内。目的是把密钥挡在 prompt 之外。
- **素材是受信输入**：素材内容可引导生成结果（二阶注入）；MVP 接受此边界并文档化，nonce 定界符待真实反馈再立项。
- 回执防误改不防恶意（见 3.3）。

### 3.9 作用域（workspace / topic）

输入与产物分两级作用域，由 pack manifest 声明（通用机制，非 COSMIC 专属）：

```
workspaceRoot/
  references/              ← workspace 级素材（workspace pack 备料）
  context/                 ← workspace 级产物目录（约定名，固定）
  <topic>/                 ← 话题目录（每个需求一个）
    references/            ← topic 级素材
    output/                ← topic 级产物
```

- workspace 级 pack（cosmic-context / cosmic-context-sync）忽略 `topic`：素材根固定 `<workspace>/references/`、产物根固定 `<workspace>/context/`；
- topic 级 pack：声明 `requiresTopic: true` 的 pack（cosmic 链四阶段）**必须传 `topic`**（缺失即调用期响亮报错）——一个需求一个 topic 目录，链路径与覆盖扫描都以此为锚；未声明的 pack 不传 `topic` 时用 Config 根，传了则两个根移到 `<topic>/` 下（仍受 workspace 包含约束）；
- `reuse` 与 scope 正交：scope 决定目录，reuse 决定 doc_generate 是否做"已有绿产物即复用"预检。默认按作用域语义区分（workspace true——工作区级分析只做一次；topic false——逐 topic 生成是推进语义：扇出逐个推进、参数试调），pack 可显式覆盖（cosmic-context-sync 声明 `reuse: false`——同步是动作；cosmic req/func/tech 声明 `reuse: true`——输入类全部有锚后链式复用安全）；
- `doc_chain_status` 的输出根从 plan 路径推断（plan 所在目录即输出根），topic 目录下的链编排无需额外参数。

### 3.10 工具 `doc_chain_status` — 扇出覆盖账目

参数：`plan`（workspace 相对路径，须带绿色 sidecar 回执）。确定性、零 LLM。阶段链从 plan 的 pack 出发按 `consumes` 图逐层展开（内置链即 context→plan→req→func→tech；workspace 级 pack 不进入扇出——coverage 定义在 plan functions 扇出上，context 是项目级单产物）；扫描 outputRoot 下各阶段**绿色**产物（回执 `isValid` 且 pack 匹配），按 `funcId` 对齐 plan 的 `functions[]`。返回 `{ plan, stages, functions: [{ index, funcId, l2Name?, coverage: { <stage>: 产物名|null } }], coverage: { <stage>: { covered, total } }, orphaned? }`——`orphaned` 列出 funcId 不属于任何 plan 功能的绿色产物（防错挂）。agent 在收工呈现前跑一次即可全链对账（docs/designs/params-and-chain-contract.md）。

**扇出契约（1:N:N:N）**：plan 整需求一份；req/func/tech 与 plan 的 functions 一一对应、份数相等，每个功能一条平行微链。`targetIndex`（req/func/tech 必填无默认）指定目标功能；req 的对齐规则额外校验 `index === targetIndex`，func/tech 经上游锚点传递保持一致。

### 3.11 工具 `doc_extract_params` — 素材参数抽取（出处层）

| 参数 | 类型 | 语义 |
|---|---|---|
| `pack` | string，必填 | pack 名；该 pack 未声明 `extractable` 参数即报错 |
| `materials` | string[]，必填 | 抽取来源素材（引用语义同 `doc_generate`）；空列表拒绝——抽取必须从素材文本自证 |
| `topic` | string? | 话题目录名（同 `doc_generate` 语义，定位抽取缓存在 `<topic>/output/`） |
| `extractions` | object，必填 | 逐参数提案：`{ value, quote }`（quote 须为素材逐字子串，引擎机检）或 `{ notFound: true, suggestion?, rationale? }`（建议值过同一 spec 校验，永不自动生效） |

返回 `{ pack, extractionPath, extractable, results, hint }`：`results` 逐参数给出 `extracted`（带 quote、ref）或 `notFound`（带 reason：`not proposed` / `quote not found in any material`；带建议时附 suggestion）。抽取结果持久化为 `outputRoot/<pack>.extracted.json`（pack、packVersion、素材 anchors 清单、逐参数记录），重抽取整体覆盖。`doc_generate` 对声明 extractable 参数的 pack 应先跑本工具（工具描述静态引导）；解析序中抽取值位于上游回执继承之下、声明默认值之上；确认表 `extracted` 行带引文列，required 未找到在生成前拦截。机制语义见 docs/designs/params-and-chain-contract.md"素材参数抽取"节。

### 3.12 Pack authoring 面（技能 + `pack:check`）

插件的模型面同时教"用 pack"与"造 pack"（docs/designs/pack-authoring.md）：

- **运行时技能 `docwright-pack-authoring`**：apply 期读随包 guide `guides/pack-authoring.md`（九阶段 playbook，自包含——不引用仓库侧 docs），经 `ctx.inject(['skills'], ...)` 可选注入（无 skills 服务的宿主休眠）在宿主技能注册表注册；guide 文件缺失 apply fail loud。`doc_packs` 描述含一句静态邀请：无 pack 覆盖所需文档类型时加载该技能。
- **`pnpm run pack:check -- <packs-dir> [--with <root>]...`**（authoring 验证梯子第 1-2 层）：对目标根跑真实装载门，随后逐 pack 逐语言用真实 DocService 验证 golden 全绿——生效参数经 `resolveEffectiveParams` 解析（声明默认 + 可选 `samples/golden.params.json`，服务 golden 验证的 required 无默认参数取值），链式 pack 以 consumed pack 的 golden 样本为 upstream（consumed 不在检查根时报错并指路 `--with`）；输出体检单（规则清单/严重度分布/参数表）。`checkPacks` / `renderPackCheckReport` / `loadPacks` / `assertManifest` 已从包入口导出，供编程复用；与装载门同源，零第二套校验逻辑。宿主冒烟（`smoke:host`）断言技能已在真实宿主注册且 model-invocable。

## 4. Pack 契约（内容层，作者视角）

### 4.1 目录结构

```
packs/<name>/
├── manifest.json      # name / version / description / consumes / scope? / reuse? / materialsRoot? / languages / maxRounds? / params?
├── schema.json        # JSON Schema（draft-07 或 2020-12），定义"文档长什么样"
├── rules/<lang>.json  # 声明式规则，定义"什么算合格"（简单族）
├── rules/functions.js # JS 函数规则（可选），跨字段规则（唯一性、求和、区间）
├── prompts/<lang>.md  # 按语言的生成 prompt，定义"怎么生成"
├── templates/<lang>.hbs # 按语言的 Handlebars 模板，定义"怎么渲染成 Markdown"
└── samples/golden.json  # 全绿母本，变异测试的输入
```

`languages` 里声明的每个语言标签，三件套（rules/prompt/template）缺一不可（加载期强制）。`manifest.description`（一句话，说明该 pack 生成什么文档）必填、加载期强制——`doc_packs` 把它原样返回给模型。`manifest.maxRounds`（可选）是该 pack 的轮数默认。`manifest.params`（可选）声明可调参数：**声明即白名单**——每项 `{ type, default, description, enum?, min?, max? }`，default 必填且须满足自身约束；未声明的名称谁都不能调（加载期校验声明合法，调用期校验取值）。多语言只影响表达层——文档结构与 schema 语言无关。

### 4.2 声明式规则（四族）

每条规则：`{ id, severity: error|warning|info, given, field, kind, ..., suggestion }`。`given` 支持 `$`（根对象）与 `$.<arrayField>[*]`（数组逐项），其余路径加载期报错。minLength/maxLength 的数值边界与 pattern 的正则源都可写 `{ "param": "<声明的参数>" }` 引用 pack 参数（数值边界引 number 型、pattern 引 string 型；按次解析，未声明的引用加载期报错；被引参数不可 `overridable`，非空 default 须可编译）。

| kind | 载荷 | 语义 |
|---|---|---|
| `minLength` | `min` | 字符串长度下限 |
| `maxLength` | `max` | 字符串长度上限 |
| `forbiddenKeywords` | `keywords[]` | 命中任一关键字即违规 |
| `pattern` | `pattern`（字面量或 `{ param }`）, `mustMatch` | 正则须匹配（或不匹配）；引用参数时置空即不检查，设置则字段值必须匹配 |

### 4.3 函数规则（`rules/functions.js`）

导出 `rules` 数组，每条 `{ id, severity(默认 error), suggestion, check(artifact, context?) }`；`check` 返回 `RuleIssue[]`（`{ jsonPath, message, snapshot? }`，空数组即通过），拿到整个产物，负责声明式四族表达不了的跨字段断言。第二参 `context`（可选，旧单参规则零改动兼容）携带本次调用产物之外的信息：`upstream`（解析后的上游产物数组）、`materials`（素材原文）、`params`（生效参数）——链式 pack 用它做跨产物校验（如 req 对 plan 的三点对齐）与部署白名单（如功能用户角色）。规则运行时崩溃会带上规则 id 报错（不静默跳过）。另可导出 `score(artifact, issues) => 0-100`（收敛检测的 pack 层评分，越高越好；缺省自动启用内置严重度评分）。设计依据见 docs/designs/function-rule-context.md。

### 4.4 作者硬契约

1. **每条规则（声明式与函数）必须带 `suggestion`**——修复 prompt 的质量不随 pack 作者漂移（加载期强制）。
2. **golden.json 必须全绿**；每条规则族至少配一种"故意损坏"的变异测试，断言 checker 全部抓住——抓不住损坏样本的 checker 是摆设（内置 pack 由测试套件强制，外部 pack 为约定契约）。
3. `version` 是破坏性变更的逃生门：改规则语义必须升版本，旧产物回执会被 `packVersionStale` / 链式校验识别为过期。

### 4.5 现有 pack：cosmic-plan（v0.7.1，consumes cosmic-context，requiresTopic）

COSMIC 功能点估算的 Plan 阶段文档（从 cosmic-claude 迁移），`consumes: ["cosmic-context"]`——链头是项目上下文，plan 必须以绿 context 为 upstream，双语 zh-CN/en-US。schema 定义 `functions[]`（**changeKind**（added|modified，必填）/ funcId / l1-l3Name / funcDesc / estimatedCfps）+ totalCfps 等字段——模块变更语义显式化：每个被新增或修改的底层模块是一项 function。参数三块（docs/designs/params-and-chain-contract.md 的共享预算）：`cfpPerFunc`（object {value, min, max}，默认 {30, 15, 45}——value 是单功能均值目标，[min,max] 校验跨功能均值，confirm）、`cfpMin`（object，默认 {10, 5, 20}——单功能下限，confirm）、`cfpMax`（object，默认 {70, 40, 100}——单功能上限，超出应拆分模块而非压缩估算，confirm）、`cfpTotal`（object {value, downFactor, upFactor}，**required 无 default**——预算只从用户意图来，confirm）、`cfpPerSubProc`（number，默认 2.5，供下游阶段规模的引导）、`moduleLevels`（number 1-3，默认 2，与 cosmic-context 共享同名参数、沿回执继承——树层级深度是链级契约）。规则 9 条：声明式 6 条（funcDesc ≥80 字 [error] / ≤2000 字 [warning]、funcId 格式正则、三级功能名禁用"管理/处理/系统/manage/process/system"等泛化词）；函数规则 7 条（funcId 唯一、层级路径唯一、**context-alignment**——无绿 context 上游响亮报错；changeKind=modified 的叶子 code 必须已存在于 context 模块树，added 不得撞已有编号且须符合对应层级 `moduleIdConventionForLevelN`（v1 对账叶子 code，全链逐段对齐留 v2）、**name-hierarchy**——l2Name（levels≥2）/l3Name（levels=3）必填性与 funcId 分段数下限（≥moduleLevels）由参数驱动（schema 管结构、规则管策略），**cfp-func-range** estimatedCfps ∈ [cfpMin.value, cfpMax.value] [error]、**cfp-avg-band** 跨功能均值 ∈ cfpPerFunc.[min,max] [error]、**cfp-total-band** totalCfps ∈ cfpTotal.value×[downFactor, upFactor] [error]、CFP 总和 20-1000 且 totalCfps 等于求和）。原「推荐 20-50」警示规则已由参数带规则取代——模板不再与用户预算竞争。

### 4.6 现有 pack：cosmic-req（v0.7.2，requiresTopic）

COSMIC 需求分析（Requirements Analysis，从 cosmic-claude Req 阶段迁移），per-function 粒度：`index` 定位上游 plan `functions` 数组的 1-based 位置，`funcId`/`desiredCfps`（=estimatedCfps）从对应 function 复制；展示上下文字段 `reqNo`/`reqTitle`（plan 顶层）与 `l1Name`/`l2Name`/`l3Name`（对应 function，上游声明了才复制）同样原样复制——供下游 markdown 的英文文档标题（Requirement Breakdown Plan / Requirements Analysis）与层级标题使用，`req/plan-alignment` 对账、上游缺字段时跳过比对。`consumes: ["cosmic-plan"]`，双语 zh-CN/en-US。参数七个：`targetIndex`（必填无默认，1-based 定位上游 plan functions 的目标功能；缺失即 fail loud 并列出候选）、`functionalUserRoles`（功能用户角色白名单，逗号分隔 string，默认 6 个样例角色）、`funcDescMaxLength`（功能描述上限，默认 500；schema 硬顶 2000），外加共享预算三参数 `cfpPerFunc`/`cfpTotal`/`cfpPerSubProc`（从上游回执继承并回录，链条传递用）。E302 文案与建议同步改用 `cfpsPerRule`。prompt 的领域模型：用户故事主体是**角色（来自 context.roles）或第三方系统（来自 context.thirdPartySystems）**，流程性故事可引入**顶层模块**；需要项目知识时由模型在 upstream 数组按需携带 context（rider）。`functionalUsers[].kind`（必填，四分类 person/organization/system/3rd-party，schema 层）标明功能用户类型；对 context.roles 的引用校验留 v2（upstream 不强制传 context 时无从对账）。规则 8 条：声明式 5 条（funcDesc ≥10 [error] / ≤参数上限 [warning]、funcId 格式、role 格式 `^[a-z][a-z0-9-]*$`、业务规则描述 ≥10 [error]）；函数规则 3 条（**E301** role ∈ 部署白名单、**E302** 规则数 ∈ [ceil(cfps/cfpsPerRule), floor(ceil×1.5)]、**E303 泛化** index/funcId/desiredCfps 加展示上下文字段（reqNo/reqTitle/l1Name/l2Name/l3Name）与上游 plan 对齐——全部 error 阻断，与原系统"审计意见只降分不阻断"不同，差异与理由见 docs/designs/function-rule-context.md）。

### 4.7 现有 pack：cosmic-func（v0.7.2，requiresTopic）

COSMIC 概要设计文档（功能过程设计，从 cosmic-claude Func 阶段迁移），per-function 粒度：`index`/`funcId`/`desiredCfps` 从上游 req 产物原样复制，展示上下文字段 `reqNo`/`reqTitle`/`l1Name`/`l2Name`/`l3Name` 同样原样复制（上游声明了才复制，`func/req-alignment` 对账）；`funcDesc`（相对上游 req 扩写的功能描述，Functional Process Design 版式的功能描述节供稿，`func/func-desc-min-length` ≥40 字 [error]）+ `diagrams`（mermaid 源码）+ `processes[]`（name/description/originator/receiver/origination_event/dataGroups——主要数据组名，与 tech 阶段子过程的 dataGroup 对应，功能过程清单的"主要数据组"列供稿）。相对原 schema 的两处偏差：`metadata`（时间戳等文档元信息）删除——docwright 无手工编辑 UX，版本由回执承载。`consumes: ["cosmic-req"]`，双语，声明共享预算三参数（继承回录用）+ `targetIndex`（必填）。规则 11 条：声明式 6 条（**E002** 过程名禁用"进行/执行/异常处理/设计/校验/conduct/execute" [error，v1 审计器默认与 v2 关键字文件合并]、**A001** 过程名后缀"处理/过程/闭环/流程/管理/等等/待定/TBD/etc." [info，ADVICE→info，用 pattern+mustMatch:false 表达]、**W001** 过程名警示词"计算/转化/转换/拆分/日志/解析/编码/缓存/临时/筛选/排序" [warning]、**E003** originator/receiver 禁用存储设施字眼"数据库/文件存储" [error，功能用户是业务角色，存储设施是实现载体——单字段单规则故拆为 originator/receiver 两条]、funcDesc ≥40 字 [error]）；函数规则 5 条（**E001** originator≠receiver [error]、过程名文档内唯一、过程 index 从 1 连续、**process-count-vs-budget** 过程数 ≥ ceil(desiredCfps/3) [error，每过程最多 3 CFP，少了则下游 tech 预算数学不可达——2026-11-03 真实链实测暴露]、**req 对齐**——index/funcId/desiredCfps 加展示上下文字段与上游 req 一致，缺失/非 req 上游一律响亮报错）。原 Func 审计器的 expected_functions 外部计数检查未迁移（docwright 无对应外部输入，过程规模由 tech 阶段 CFP 预算约束兜底）。

### 4.8 现有 pack：cosmic-tech（v0.7.1，requiresTopic，CFP 下限钉死计划估算）

COSMIC 技术拆分文档（Function-Point Breakdown 表，从 cosmic-claude Tech 阶段迁移），per-function 粒度：锚点同 func（index/funcId/desiredCfps 从上游 func 复制，展示上下文字段 reqNo/reqTitle/l1Name/l2Name/l3Name 同样原样复制——拆分表版式的"需求编号/需求名称/各级功能模块"列供稿，`tech/func-alignment` 对账），`processes[].subProcesses[]` 为数据移动（description/dataMovementType E-X-R-W/dataGroup/dataProperties/cfp=1）。相对原 schema 的两处偏差：`metadata` 删除（同 4.7）；`revised`（人工复核标记）删除——docwright 无人工修订流。`consumes: ["cosmic-func"]`，双语。参数四个：共享预算 `cfpPerFunc`/`cfpTotal`/`cfpPerSubProc`（继承回录用，`cfpPerSubProc` 默认 2.5——即平均每个功能过程约 2.5 个数据移动）+ `targetIndex`（必填）；原 `cfpMinRatio`/`cfpMaxRatio` 参数删除，容差系数改读共享 `cfpTotal` 的 downFactor/upFactor（缺省回退 [0.9, 1.2]，比原 [0.9, 1.5] 收紧——用户预算的偏离带全链一致）。CFP 预算错误带：**下限钉死计划估算**——总数不得低于 `desiredCfps`（真实会话复盘发现 0.9 带内系统性偏低 11-16%，downFactor 不再放宽 tech），上限 `desiredCfps×upFactor` [error]；警示带简化为「高于计划估算但带内即提示 [warning]」。规则 8 条：声明式 1 条（funcId 格式）；函数规则 7 条。数据移动序列收紧为三种评审安全模式 **`ERX`（查询）/`EW`（落库）/`EX`（转发交互）**——`tech/movement-pattern` 一条函数规则承载，回执给出实际序列与合法模式对比；该模式集蕴含原型的 E101（首移动必 E）、E102（收尾 W/X）、E103/E107/E109（移动计数 1/2/>6）、A101（5-6 个拆分建议）与 E105（E/W/X 不连相同类型）、E108（非首 E 前必 X），上述 7 条原型规则不再单独存在（多轮读写拆多个过程，各自满足模式）；golden 亦按 7×EW + 7×ERX 重排（14 过程 = 35 CFP，恰等预算，平均 2.5）。其余函数规则沿用：**W103** 同过程内移动三元组（类型+数据组+数据属性）不重复 [warning]（`tech/movement-duplicate`）、**W101** 子过程描述警示词 [warning]（`tech/subprocess-desc-keywords`）、**W102** 数据属性 ≥2 [warning]（`tech/data-properties-count`）、CFP 预算错误带与带内偏离提示（对应 W100/W200，分属 `tech/cfp-total-vs-budget` [error] / `tech/cfp-budget-advice` [warning]）、**func 对齐**——三点锚定加过程名覆盖（上游 func 每个过程必须出现在 tech.processes 中，同名，`tech/func-alignment`）。嵌套作用域（subProcesses）规则全部走函数规则——声明式 `given` 仅支持根与一层 `$.field[*]`，嵌套由函数规则的整产物视角覆盖，引擎无需扩展。

### 4.9 现有 pack：cosmic-context（v0.1.0，链头）

COSMIC 项目上下文——场景链的第一个产物、项目知识的唯一承载（docs/designs/cosmic-context.md）。`consumes: []`、`scope: "workspace"`（素材 `references/`、产物 `context/`，忽略 topic）、`reuse: true`（项目分析只做一次；复用预检按 pack+绿回执+hash 对账，`force` 绕过）。schema：`projectName` / `background` / `overview`（各 ≥20 字）/ `modules[]`（树 1-3 级，每模块 `code`（`^[A-Za-z0-9]{1,8}$`，全树唯一，是模块身份——funcId 的段即 code 链）与可选 `path`（代码位置，规则引擎不校验存在性）/ `responsibility`）/ `roles[]`（person|organization|system 三分类）/ `thirdPartySystems[]`（purpose=它是什么，interaction=如何交互）/ `moduleIdConventionForLevel1..3`（numeric|alphabetic，树用到第 N 级必声明）/ `designPrinciples[]` / `assumptions[]`（模型假定显式登记）。参数 `moduleLevels`（1-3，默认 2）——schema 恒表达三级结构，实际树深由参数驱动。规则 4 条（函数）：**module-code-unique**（全树 code 唯一 [error]）、**module-depth**（实际最大深度 = moduleLevels [error]）、**module-id-convention**（第 N 级（N≤moduleLevels）有模块但规则缺失 [error]）、**assumptions-review**（假定非空提示人工审阅 [warning]；修正后 seal 回签重新入链）。

### 4.10 现有 pack：cosmic-context-sync（v0.1.0，同步动作）

把一个话题绿 plan 规划的模块变更（added/modified）合并回 workspace 级 context，产出刷新后的绿 context——项目知识随需求持续演化。`scope: "workspace"`、`reuse: false`（同步是动作，不被复用预检拦截）、`consumes: ["cosmic-context", "cosmic-plan"]`——upstream 显式传旧 context 与本话题绿 plan（缺一即工具层响亮拒绝；模型可见 ⟺ 日志可重建，工具不做隐式扫描），触发时机写进 description：plan 阶段绿后可用。schema 与 cosmic-context 相同（产物是 docType context 的新版本）。生成走标准闭环：LLM 以旧 context + plan 为输入产出合并 context（新增模块按编号规则插入对应层级、修改模块更新职责），规则 = context 四条 + 两条合并对账：**context-sync/coverage**（plan 每个 added/modified 功能的最深层级名称必须出现在合并树中 [error]；v1 按 name 匹配，funcId 段逐段对账留 v2）、**context-sync/preserve**（旧 context 模块在合并产物中缺失 [warning]——防合并丢失，确属下线由人工 seal 裁决）。`doc_chain_status` 的扇出图不含 workspace 级 pack，coverage 矩阵不受影响。

## 5. 插件 / pack 职责边界（总表）

| 关注点 | 插件实现 | pack 实现 |
|---|---|---|
| 文档结构 | — | `schema.json` |
| 合格标准 | 规则执行引擎（schema + 四族声明式 + 函数规则） | 规则本身（`rules/*.json`、`functions.js`） |
| 生成方式 | prompt 组装、素材/上游注入、模型调用 | `prompts/<lang>.md` |
| 闭环行为 | 迭代、预算、振荡检测、错误映射、终止语义 | — |
| Markdown 渲染 | Handlebars 编译与空渲染检查 | `templates/<lang>.hbs` |
| 多语言 | 语言解析链、按语言编译缓存 | 每语言的三件套资产 |
| 回执 | 生成、哈希、复验、staleness | 提供被快照的规则内容 |
| 链式消费 | 上游六项校验、版本策略 | `manifest.consumes` 声明 |
| 安全 | 路径包含、名称消毒、素材非空 | — |
| 作用域 | `topic`/`force` 参数、workspace/topic 根解析、复用预检（绿回执+hash）、doc_chain_status 输出根推断 | `manifest.scope` / `manifest.reuse` 声明 |
| 配置 | Config schema 与全部默认值 | — |
| 领域概念（COSMIC、CFP） | **禁止进入插件** | 规则与 prompt 中自由使用 |
| 能力发现 | `doc_packs` 工具、三处静态邀请文案、manifest.description 加载期校验 | `description` 的一句话内容 |
| 参数旋钮 | 解析/校验/钳制、`{{params}}` 渲染、回执 as-run、复验按当时参数 | `manifest.params` 声明与默认值、`manifest.maxRounds` 领域默认 |

## 6. 质量门与验收基线

- Vitest；每文件 100% 行/函数/语句覆盖门。
- 变异测试（mutation tests）证明护栏非摆设：golden 样本按规则族故意损坏，checker 必须全抓住。
- 闭环行为用确定性策略测试：注入损坏 JSON + LLM seam 按脚本返回，断言循环与回执；真实模型端到端属 e2e（有 API key 才跑）。
- 预发布宿主冒烟（`scripts/host-smoke.ts`，`pnpm run smoke:host`）：npm tarball → 真实 dsh 宿主 boot → 三工具注册断言，无模型调用、无 API key。

## 7. 当前限制与路线（未实现，按优先级参考 TODOS.md）

- 真实 LLM 闭环已验证：多轮修复轨迹、内置权重对账（score = 100 − 10×error 精确吻合）、跨 dsh 版本回执复验均通过（数据见 docs/testing/e2e-real-llm.md）。停滞/阴跌阈值在 glm-5.3 级强模型下不可触达（模型优先 pack 规则），仍由确定性测试覆盖。
- 闭环每轮数据（含各轮 promptHash）进回执；回执整体作为 doc_generate 工具结果内容逐字进入 session log，审计流由该通道承载。独立 doc-gen-round session 事件类型延后：dsh 未提供插件事件类型写侧 `ignorable` 标记的入口，未经标记的未知类型会使会话在 stock 宿主下不可重载。
- 草稿续修（从红回执草稿断点继续修）工具、MCP 包装（宿主无关分发）、pack npm 分发——均未启动。
- 同名产物的并发写入无跨文件锁（单文件原子，artifact/receipt 对可能交错，last-writer-wins）。
