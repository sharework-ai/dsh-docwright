# 《DeepSeek Harness 插件开发》分享提纲

副标题：dsh-docwright 插件（通用文档生成和校验插件）设计思路和研发过程

素材来源：仓库 README / docs/designs/（13 份设计文档）/ docs/testing/ / git 历史（2026-08-27 → 2026-11-03，202 commits）。
本提纲是幻灯片的内容蓝本；slides 文件与本文同目录。

---

## 0. 封面

- 主标题：DeepSeek Harness 插件开发
- 副标题：dsh-docwright 插件（通用文档生成和校验插件）设计思路和研发过程
- 演讲人 / 日期（2026-11）
- 底部一行事实数字：npm `@sharework-ai/dsh-docwright` v0.4.2 · 6 个内置 COSMIC pack · 插件源码 5.5k 行 / 测试 7.2k 行 · 202 commits · 13 份设计文档

## 1. docwright 是什么（一段话功能）

- 一段话：docwright 是 deepseek-harness（dsh）的文档生成与校验插件——它把"AI 生成文档"变成一个受控闭环：文档以结构化 JSON 表示并按 JSON Schema 强制校验，不合格自动把问题清单喂回模型重写直到全绿；每类文档的合格标准（schema + 领域规则 + 生成 prompt + 渲染模板）打包成可插拔的 pack；每份文档随盘附带机器可读的验证回执（receipt），任何人可以离线复验"这份文档当时为什么合格"。
- 核心理念两条：**JSON 为中心**（所有文档可机器校验）、**场景化配套**（scenario = generator + checker 的组合，按场景插拔）。
- 和现成结构化输出框架（instructor / BAML / Guardrails）的差异：它们只判断"结构对不对"，判断不了"内容合不合格"——"功能描述写满 80 字""名称禁用泛化词""估算总和落在业务区间"这类标准因文档类型而异。docwright 的差异化：**合格标准可插拔（pack）+ 校验结论可复验（receipt）**。
- 一句话分工：换文档类型 = 新写一个 pack 目录，插件零改动；改闭环/校验/回执行为 = 改插件。

## 2. 研发背景：文档生成的三个痛点

- **痛点 1：非结构化内容**。让 AI 大量生成文档，产出是自由文本（Markdown / Word），质量黑箱——无法机器校验，"看起来对"≠"真的对"，评审全靠人肉通读。
- **痛点 2：没有统一的规范**。每类文档"什么算合格"散落在人脑、聊天记录、模板批注里；同一个标准两个人执行出两种结果；规范本身没有载体、没有版本。
- **痛点 3：要求随时变化**。文档标准、模板版式、预算口径频繁调整；标准一旦硬编码进 prompt 或代码，每次调整都是一次开发。
- 对症下药（三件事，也是 docwright 的三个支柱）：
  1. **领域规则包 pack**：合格标准数据化——schema + 规则 + prompt + 模板是可插拔的数据包，换文档类型不换代码（治痛点 2、3）；
  2. **闭环修复 repair loop**：生成 → 校验 → Issue 喂回重写 → 全绿或明确失败，护栏是强制的不是摆设（治痛点 1）；
  3. **可复验回执 receipt**："全绿"从一次过程变成一件产物，机器可读、离线可复验（治痛点 1 的信任问题）。

## 3. 安装与使用

- 安装两条命令：`dsh plugin add @sharework-ai/dsh-docwright` → `dsh` 起会话；cordis.yml 里配 `provider`/`model`（宿主 LLM 路由名）、可选 `packsDir`（本地 pack 目录，同名覆盖内置）。
- 五个工具（模型可见的能力面）：
  | 工具 | 作用 | LLM |
  |---|---|---|
  | `doc_packs` | 能力发现：列出已装 pack 与参数清单（拉式渐进披露） | 零 |
  | `doc_generate` | 闭环生成：素材/上游 → JSON → 校验 → 修复循环 | 是 |
  | `doc_extract_params` | 素材参数抽取：`{value, quote}` 引文机检 | 是 |
  | `doc_validate` | 确定性复验 + seal 回签 | 零 |
  | `doc_chain_status` | 扇出覆盖账目矩阵 | 零 |
- 5 个工具里 3 个零 LLM——确定性操作和模型操作分家。
- quickstart（确定性、约 2 分钟、无 API key）：拷入 pack 自带 golden 样本 → `doc_validate` → 秒级全绿回执。
- COSMIC 场景链示意：`cosmic-context → cosmic-plan → cosmic-req/func/tech`（1:N:N:N 扇出，一个需求一个 topic），产物/回执/Markdown 三件套落盘 `<topic>/output/`。

## 4. 现场演示（演示要点卡）

- 演示 1（秒级冷启动）：`doc_validate` 对 golden 样本出全绿回执——零模型调用，先看"回执长什么样"。
- 演示 2（闭环）：素材里埋违规项 → `doc_generate` 多轮修复 → 全绿；看回执里每轮 issue 数与 promptHash。
- 演示 3（确认门）：显式改参数（如 cfpTotal 预算）→ `pendingConfirmation` 参数表（含来源标注）→ `confirm: true` 执行。
- 演示 4（防篡改 + seal）：手改产物 JSON → `doc_validate` hash 失配变红；修正后绿校验 → `sealed: true` 重新入链。
- 演示 5（对账）：`doc_chain_status` 输出覆盖矩阵（每个 plan 功能在 req/func/tech 层的覆盖 + orphaned 清单）。
- 备选（时间不够只放录屏/截图）：dsh web UI 参数维护界面。

## 5. dsh 插件开发：如何让 dsh 发现你，如何在 agent loop 中发挥作用

- dsh 一句话：基于 vendored Cordis 的插件化 agent harness，"一切皆插件"——运行中的 dsh 是一棵由有序配置层组合出的插件树；无特权核心：`ctx.llm`（模型）、`ctx.tools`（工具注册表）、甚至 agent loop 本身都是插件，均可替换。docwright 就是挂在它旁边的一个普通插件（"Plugins, not loop changes"）。
- **插件如何被发现与装载**：
  - 一切插件最终都是 Cordis 配置行：`- insert: [{ id: docwright, name: '<npm包名或绝对路径>', config: {...} }]`；name 支持 npm 包名 / 本地绝对路径 / 包内子路径导出。
  - 两个概念两张清单：**bundle** = npm 包，`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`（回答"贡献什么配置层"）；**profile** = `$DSH_HOME/profiles/<name>/`，`dsh.profile.bundles` 数组（回答"按什么顺序组合哪些 bundle"）。两个清单都由 `dsh plugin add/remove` 维护，不用手写。
  - 命令：`dsh plugin add @sharework-ai/dsh-docwright`（npm）/ `dsh plugin --profile demo add ./path`（本地）/ `add <tgz>`（tarball）；`dsh --profile demo --dump-config` 可查看合成树。
  - 装载层序（后者按 id 整行覆盖）：profile bundles 逐层 → profile cordis.patch.yml → $DSH_HOME cordis.patch.yml → --patch 临时层。
- **插件契约**（函数式推荐）：
  ```ts
  export const name = 'docwright'          // 诊断用
  export const inject = ['tools', 'llm']   // 依赖服务；未就绪则等待，运行中消失→自动 dispose
  export function apply(ctx: Context, config: Config) {
    ctx.tools.register(...)                 // 每条注册返回 disposer，卸载/HMR 自动 unwind
  }
  ```
  Config 声明 = TS 接口 + Schemastery schema（Standard Schema），apply 收到校验+默认值后的配置；装载期即校验——misconfiguration fails loud，绝不带病进会话。注册皆效果（Registrations are effects）。
- **工具如何进入 agent loop**（注册 → 模型可见 → 执行）：
  1. 注册：`ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))`；
  2. 模型可见投影：registry 的 `schemas()` 只白名单投影 `name/description/parameters` 组成 ToolSchema[]（execute/render 等永不进请求）；`system-prompt` 服务组装 PromptAssembly → loop 每步发请求携带；集合变化经 `tools/change` 通知下一 step 生效；
  3. 执行管线：`tools/pre-execute`（waterfall：allow/deny/cancel/ask）→ ToolGuard → `tools/execute` → 工具体 → `tools/post-execute` → `tools/result` 事件 + durable session 日志——模型可见 ⟺ 日志可重建。
  - 工具 description 是模型的"说明书"：docwright 把"先调 doc_packs"的静态邀请写进 description（描述不随 pack 集合变化——拉式渐进披露）。
- **Capability Seam 三角色**：Service Definition（接口 + 类型合并进 `interface Context`）/ Service Provider（实现并挂载）/ Consumer（`inject` 使用，常见为工具）；Provider 与 Consumer 互不依赖，换 provider = 换 cordis.yml 一行。docwright 消费宿主 `tools`/`llm` seam，并把 pack-authoring 技能注册进宿主 skills registry（无该服务的宿主上休眠）。
- **插件开发基本过程**（从零到 npm）：
  1. 脚手架：`"type": "module"`、TS strict、相对导入带 `.ts` 扩展名、`cordis.patch.yml`、tsc 出 lib/types + tsdown 打运行时；
  2. 宿主联调：devDependencies 用 `link:` 指向 dsh checkout（`file:` 会去解析 dsh 的 `workspace:*` 内部依赖而炸），先 `pnpm run build:lib:host`；
  3. 测试：Vitest 行为测试 + 每文件 100% 覆盖门 + registry HMR-safety 测试；模型可见行为变更配 keyless snapshot；
  4. 预发布冒烟：`smoke:host` —— npm tarball → 真实 dsh 宿主 boot → 工具注册断言（无 API key）；
  5. 发布与安装验证：`pnpm pack` → `dsh plugin add <tgz>`；版本兼容用 `engines.dsh` SemVer 范围声明；重装同版本 tarball 前先 remove。
- 开发期最有用的三份文档：dsh 仓库 `docs/architecture.md` / `docs/cordis-primer.md` / `docs/user/develop/basic/`（插件教程四篇）。

## 6. docwright 的关键设计

### 6.1 pack：内容与引擎分离（场景化配套的载体）

- pack 目录七件套：`manifest.json`（元数据/链消费/参数声明）/ `schema.json` / `rules/<lang>.json`（声明式四族：minLength / maxLength / forbiddenKeywords / pattern）/ `rules/functions.js`（跨字段函数规则，可选）/ `prompts/<lang>.md`（`{{materials}}`/`{{upstream}}` 槽位）/ `templates/<lang>.hbs` / `samples/golden.json`。
- 职责边界总表（PPT 放精简版）：文档结构/合格标准/生成方式/闭环行为/回执/安全……"领域概念（COSMIC、CFP）禁止进入插件"。
- 作者硬契约：每条规则必须带 `suggestion`（修复 prompt 质量不随作者漂移）；golden 必须全绿 + 每个规则族配"故意损坏"变异测试——**抓不住损坏样本的 checker 是摆设**；改规则语义必须升 version（旧产物回执被 staleness 识别为过期）。
- 声明即白名单：`manifest.params` 未声明的参数名谁都不能调；声明式规则的边界可引用参数（`{ "param": "..." }`，含 pattern 正则参数）。
- pack authoring 也是插件能力：运行时技能 `docwright-pack-authoring`（九阶段 playbook）+ `pnpm run pack:check`（真实装载门 + golden 全绿验证）——AI 可以教 AI 造 pack。

### 6.2 闭环修复与打分机制

- 每轮五步：预算预检（token 估算）→ 模型调用（传输失败重试一次）→ 解析（剥围栏提取 JSON，解析失败也是一条 Issue）→ 校验（ajv allErrors + 声明式 + 函数规则，全部归一为统一 Issue 格式）→ 判定（**全绿 = 0 条 ERROR**，warning/info 不拦截）。
- 统一 Issue 格式是闭环的粘合剂：`{ ruleId, severity, jsonPath, message, snapshot, suggestion }`——修复 prompt、回执、报告只消费这一种格式。
- 修复 prompt 组装：原 prompt + 当前产物 + 按 jsonPath 分组的 Issue 清单 + "只修列出的问题"。
- **打分机制**：内置默认 `clamp(100 − 10×error − 3×warning − 1×info, 0, 100)`；pack 可导出 `score(artifact, issues) => 0-100` 覆盖；分数用途 = 收敛检测，不是质量认证（质量认证是 0-ERROR + 回执）。
- **收敛检测三层**（提前终止只决定"何时放弃"，全绿判定不变）：连续 K 轮不超过历史最优 → stagnation；连续 D 轮严格下降 → decline；指纹兜底（连续 3 轮 Issue 指纹相同）→ fingerprint-repeat。终止原因与每轮评分写进回执，收敛过程可审计。
- 失败语义：迭代耗尽 → 工具抛错 + 草稿与红回执留在磁盘（绝不静默采用最后一轮）。

### 6.3 回执与 checksum 机制

- 回执字段（sidecar `<产物名>.receipt.json` + 工具返回内联）：`artifactHash`（canonical JSON——键排序无空白——的 sha256）/ `schemaHash` / `rulesetSnapshot`（声明式规则全文 + functions.js 源码哈希，pack 升级后历史回执仍可解释当时依据）/ `upstreamHashes`（链式锚点）/ 每轮 `{round, errorCount, score, promptHash}` / as-run `params` / `terminationReason`。
- **checksum 语义**：hash 把"合格证"绑定到具体内容版本——产物被改一个字符，`doc_validate` 即 `hashMatches: false`（防误改不防蓄意伪造，tamper-evident 而非 tamper-proof）。
- 生成与复验共用同一个回执构造器——两种回执永不漂移。
- **seal 回签**：绿校验把新回执写入 sidecar——发证渠道从"只有生产线"扩展为"生产线 + 质检站"；人工/外部编辑的产物过校验即可重新入链（复用预检把素材清单、上游锚点 hash 一并向前携带）。
- 版本门：`packVersionStale`——回执由另一个 pack 版本写入时绿回执只证明旧规则，提示重生成。
- 复用预检：同 pack + 绿回执 + hash 一致 + 素材清单逐项相等 + 上游锚点相等 + 参数一致 → `reused: true` 零 LLM 返回；`force` 绕过。

### 6.4 参数治理（参数的划分、读取、继承）

- **参数四层级**：插件 Config（部署运维）/ pack manifest `params`（pack 作者，声明即白名单）/ 调用参数（用户·agent，单次调用）/ 引擎派生（如 `topicNo`，不可配置）。
- **参数属性全集**：`type / default / required / confirm / overridable / extractable / min / max / enum`；装载期不变量：`overridable ⇒ confirm`（可调基线必过人）；被规则引用的参数禁 `overridable`。
- **参数的划分**：共享参数（CFP 预算族 `cfpPerFunc/cfpMin/cfpMax/cfpTotal/cfpPerSubProc`、`moduleLevels`、`topicNoPattern`）链头声明一次、沿链继承；pack 本地参数（req 的 `functionalUserRoles` 等）各自声明。继承声明不填 default——写了只是误导性死数据（UI 以删除线标注"由 X 管理"）。
- **解析序**：显式 params > 上游回执继承 > 抽取值（引文机检）> 声明默认值 > required 缺失 fail loud。
- **素材参数读取（extract-params，出处机制）**：模型对每个 extractable 参数提 `{value, quote}`，引擎机检 quote 是素材逐字子串，通过才入解析第三档；`notFound` 是一等结果——required 参数 notFound 在花费生成成本前拦截，**素材缺值被模型代答必须防止**。抽取缓存落 `<pack>.extracted.json`，生成前对当次素材重验引文。
- **确认门（confirmation gate）**：显式改参或 confirm 参数未经上游确认 → 返回 `pendingConfirmation` 参数表（零 LLM 成本），带来源标注（pack 默认/显式/上游继承/抽取引文）；`confirm: true` 重发才执行。沿链继承不再立门——**全链用户交互恰一次**。档位 `confirmPolicy: none/standard/strict`。审计兜底：谁批了什么，session log 可重建（模型可见 ⟺ 日志可重建）。
- **Mind the gap（生成语义与校验语义分家）**：参数对象只有 `value` 渲染进 prompt（模型把上下文数值当写作目标）；`min/max/downFactor/upFactor` 是校验容差，只活在规则与回执，经 Issue 消息到达模型。判断标准一句话：这个数描述"文档应该长什么样"（进上下文），还是"离目标多远必须打回"（留在规则）？
- **参数漂移**：`paramDriftPolicy: regenerate`（默认，质量优先）/ `revalidate`（确定性重验上游）。

### 6.5 链契约与扇出（1:N:N:N）

- `consumes` 声明上游类型；upstream 引用过六项校验（可读 JSON / 有回执 / 回执绿 / hash 一致 / 类型匹配 / 版本策略）；其余已安装 pack 的绿产物可作 rider 随行入 prompt。
- **1:N:N:N**：plan 一份；req/func/tech 与 plan functions 一一对应；`targetIndex` 必填无默认，缺失 fail loud 并列出全部候选。
- **引擎命名权**：per-function 产物 `<PREFIX>-<topicNo>-<NN>` 由引擎命名，显式传 `artifactName` 报错——同名覆盖在机制上不可能发生，重生成幂等。
- `doc_chain_status`：覆盖矩阵 + orphaned（funcId 不属于任何 plan 功能的产物）；覆盖是集合性质，归链级账目工具，不塞进单产物规则引擎。
- 跨出处链实证：packsDir 里的外部 pack（task-card）消费内置 cosmic 链，引擎零改动——参数沿回执继承、确认门跨出处只立一次、chain-status 自动入册（2026-11-03 e2e 八步全绿）。

## 7. 研发历程（从 git 时间线看三阶段）

- **阶段一：MVP 一日冲刺（2026-08-27）**。/office-hours + /autoplan 产出设计决策文档（44 条决策审计）→ 当日实现闭环 MVP → 当日 QA 三连修（bundle patch 行名 / tarball 带 patch 文件 / types 路径）——第一课："插件能被 dsh 正确发现和装载"本身就是工程。
- **阶段二：设计与实证深化（2026-10-11 ~ 10-14）**。规格重写为 current-state 功能说明书；三个设计提案 D1（pack 发现）/ D2（收敛检测）/ D3（参数桥）当日设计当日落地；真实 LLM e2e runbook（zai glm）打通；cosmic req/func/tech 补全四阶段链、更名 docwright、0.1.0；**真实 web 会话暴露四类缺口**（参数通道缺失/确认缺失/扇出无契约/外部编辑死路）→ D5 参数治理 + D6 扇出契约 + D7 seal 一日落地（0.2.0）；链头 cosmic-context + workspace/topic 作用域。
- **阶段三：治理工程化与生态（2026-10-16 ~ 11-03）**。三参数 CFP 模型与 Mind the gap；confirmPolicy；引擎命名权；复用预检素材新鲜度；参数对象模型 → **参数维护 UI**（读 RPC + 写通道 + web 客户端 + i18n）；extract-params 出处机制；pattern 正则参数；pack-authoring 技能 + pack:check；跨出处链实证；输出对齐业务交付模板（0.4.x）。
- 三条复盘：
  1. **真实会话是最好的设计输入**——四缺口全部来自一次真实 web 会话（9 个功能只生成 1 份且校验全绿：护栏对"没发生的事"不设防）；
  2. **测试要穿过宿主运行时**——"测试直调 execute() 绕过 dsh 运行时校验"曾让 confirm-gate undefined bug 漏网；
  3. **文档纪律是研发效率**——规格零历史（设计推演进 git、正文只写现状）、one home per fact，13 份设计文档按 PROPOSED→implemented 状态机管理。

## 8. 工程实践（可以并入前文，时间不够即跳过）

- 质量门：每文件 100% 行/函数/语句覆盖；变异测试证明护栏非摆设；闭环行为用确定性策略测试（LLM seam 注入脚本）；真实模型只进 e2e。
- dsh 约定落地：no hardcoded tunables（全部旋钮是 Config 字段）；模型可见 ⟺ 日志可重建（promptHash 入回执）；Plugins, not loop changes（新行为走扩展点，不改 agent-loop）。

## 9. 总结与展望

- 三个可复用的设计原则：
  1. **合格标准数据化**——标准是数据（pack）不是代码，变化不进开发流程；
  2. **校验结论产物化**——"合格"不是过程是产物（receipt），可复验、可追责、可续链；
  3. **治理机制内建于工具**——确认门/账目/防篡改都长在工具语义里，靠模型自觉的护栏等于没有。
- 展望（TODOS）：草稿续修（红回执断点续修工具）、MCP 包装（宿主无关分发）、pack npm 分发、as-run 参数值记录、更多场景 pack。
- 一句话收尾：让 AI 生成文档从"碰运气"变成"可验证的工程"。

## 附：演示环境准备清单

- dsh（本机常驻 web 或 CLI）+ `@sharework-ai/dsh-docwright@0.4.2` 已安装；
- 演示工作区：`references/` 放正常与埋雷两版素材；golden 样本可用 pack 内置；
- `docwright` provider/model 配置好（zai 或 deepseek 路由）；零 LLM 演示项不依赖 key；
- 录屏兜底：闭环多轮修复 + 参数维护 UI 两段。
