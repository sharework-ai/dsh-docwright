# 设计：pack 工坊 —— docwright 的 pack authoring 能力

Status: S1 IMPLEMENTED（2026-10-30：技能 docwright-pack-authoring + doc_packs 邀请 + pack:check 运行器 + guides/ 随包分发 + golden.params.json 约定；459 tests + 覆盖率阈值 + host-smoke 技能断言 PASS）；S2 IMPLEMENTED（2026-10-30 驱动测试完成：pm 场景 packsDir lane 全流程首航 PASS——发现链路自燃、2 pack 全部合格、真实生成 e2e 全链通、观察 O1-O7 回修 guide；实证记录与协议见 pm-scenario.md 与本文"驱动测试协议"节）
关联: docwright-mvp.md §4-§5（pack 契约与职责边界）、params-and-chain-contract.md 与 param-object-model.md（参数属性全集）、cosmic-context.md（场景链头与作用域）、scenario-chains.md（多场景发现，其触发条件即本设计 S2）、AGENTS.md（测试政策与真实会话实测方法）

## 问题

- docwright 的能力边界就是已安装 pack 的集合。用户拿着一类新文档到来时，第一句话永远是"没有这类文档的 pack"——而当前插件的模型面只教"用"（doc_packs → doc_generate 闭环），不教"造"。模型遇到缺 pack 的任务只能拒绝或绕过。
- 造一个 pack 是一次小型产品研发：领域分析 → 产物规划 → 规格设计 → 检查规则 → 参数设计 → 测试验收。这些知识目前散落在 mvp §4 的契约条款与 cosmic-* 系列的实施史里，没有一处面向"从零到第一个合格 pack"的过程指南。
- 结论：pack authoring 应作为插件的一等能力进提示词面，与"生成文档"并列。承载形式 = 随包分发的 authoring playbook，注册为 dsh 运行时技能（skill capability seam 的标准用法），由 doc_packs 静态邀请引路。

## 定位

- 一个 pack = 一类文档的完整质量契约：schema 说"文档长什么样"，规则说"什么算合格"，prompt 说"怎么生成"，模板说"怎么渲染"，golden 证明"全部合格可达"。五者同源一致，pack authoring 就是把这五份契约与领域对齐的过程。
- **方法、牙齿、实证三分**：方法本体是散文（领域分析与规则设计是产品研发，不可机械化，skill 承载）；牙齿是校验（装载期校验 fail loud + `pack:check` 运行器把最廉价的两层验证梯子变成任何人一条命令可跑）；实证是 S2（用真实场景把九阶段走一遍，证明方法可 follow）。提示文档单独存在没有牙齿；牙齿缺位正是原型 cosmic-claude"摆设校验"教训的根源。
- 引擎不动是常态：新场景 = 新 pack 目录（一个或多个），引擎零改动。确需引擎增强时单独立项并给出影响评估表（cosmic-context.md "引擎影响评估"是范式）。这是 "Plugins, not loop changes" 在 pack 层的对应物。

## 提示词承载面（三层）

1. **doc_packs 静态邀请**：工具描述追加一句——当前 pack 无法覆盖所需文档类型时，加载 `docwright-pack-authoring` 技能造一个新 pack。与 "discover packs via doc_packs" 同款的拉式邀请模式。
2. **运行时技能 `docwright-pack-authoring`**：apply 期经 `ctx.inject(['skills'], ...)` 可选注入（无 skills 服务的宿主休眠——webServer 先例，index.ts:63）+ `ctx.skills.register({ name, description, whenToUse, content, resourceBase })` 注册。body 从随包 guide 文件读入（包根 `guides/pack-authoring.md`，与 `packs/` 平级；apply 期 `join(import.meta.dirname, '..', 'guides', ...)` 读取），文件缺失 fail loud（misconfiguration fails loud）。`resourceBase` 指向 guides 目录，body 可引用同目录资源。模型面英文（模型面恒投影 en 的既有约定）。
3. **仓库 docs 是人类面**：本设计与 mvp §4 是机制事实源；技能 body 是模型面 playbook 的单一事实源（one home per fact：过程知识只住 guide，机制语义只住规格）。guide **自包含**——已安装形态读不到仓库 docs，不得引用；两处内容冲突时以规格为准并回修 guide。

## Authoring 的发生地与权限模型（write path）

pack 的写入位置与文档 workspace 是两个世界——authoring 必须显式选 lane，插件自身不架桥：

- **仓库 lane（内置/场景 pack）**：authoring 在 docwright 仓库 checkout（git worktree 纪律）进行，由仓库内的开发会话执行——写 `packs/<name>/` 就是普通仓库写入，无越权问题。六层验证梯子只有这条 lane 能全跑（变异测试、确定性闭环、host-smoke 都长在仓库测试套件里）；cosmic 六 pack 即此形态，合入走 `feat/<slug>` + `--no-ff`。
- **packsDir lane（用户定制 pack）**：`config.packsDir` 是唯一无需动仓库的安装点（DX-H3 同名覆盖语义）。**约定目录名 `<workspace>/.docwright/packs/`**（点前缀目录不入素材扫描与常规文档视图，`.docwright` 命名空间与插件对齐）——cordis.yml 的 packsDir 用绝对路径指向它。放在 dsh 会话工作区内：会话 agent 的常规文件工具可直接写，零提权；放在工作区外——写入需经宿主文件工具的越权审批（宿主能力，形态以宿主为准），或不经 agent 由用户手工放置。packsDir 进工作区属**用户显式选择的信任放宽**（模型可写面覆盖 pack 源）：配置是用户写的，装载仍在 apply 期、重载后生效，插件未因此新增任何写通道。验证下限用 `pack:check`（任意目录可跑）+ 装载期校验，变异测试与闭环测试在该 lane 为约定契约。
- **插件不建提权写通道（否决原则）**：pack 安装是配置变更，不是文档产物——packsDir 属 cordis.yml 部署配置（信任域 A），doc_generate 的 workspace 路径包含是另一个信任域 B（mvp §3.8）；authoring 不得在 A/B 之间架桥，否则"素材不能静默改配置"的防线被模型可写面绕开。未来若要"会话内一键安装"，只能是宿主权限系统下的显式用户操作 + 装载期校验全量校验。
- **生效在 apply 期**：pack 装载是 apply-time（decision #9）——写入完成后需插件重载（宿主重启/重载）才可见。这天然隔离"造"与"用"：authoring 会话产出的 pack 不会在本会话内立即被 doc_generate 使用。

技能 playbook 在阶段 9（入册）按 lane 分叉指引：仓库 lane 给 git worktree + 测试套件路径；packsDir lane 先问 packsDir 位置——不在工作区内则请用户放置文件或显式批准越权写入。

## Authoring 流程（九阶段）

技能 body 的骨架。每阶段有目标、产出与硬契约；cosmic-* 系列作为贯穿实例（文末分解总表）。阶段分性：**0-2 与 4-5 是设计阶段**（领域分析与产物/规格决策），**3、6、7 是开发阶段**（产出可执行资产——规则 JS、参数声明、prompt/模板、golden 样本；函数规则开发是 Node 原生 JS 编程，见阶段 3），**8-9 是验收阶段**。设计与开发交替迭代（规格评审常打回开发），验收不可跳过——从设计直接跳到验收必然在装载期校验或 golden 处不合格。

### 阶段 0 — 场景盘点（know the domain）

- 目标：回答"这个场景要产出什么、业务流程是什么、每一步谁负责"。产出：领域模型一段话基准（cosmic-context.md "领域模型"节即此形态：context→plan→req→func→tech 五步，每步一句话定义核心对象）+ 问题陈述（现状缺什么、为什么要 harness 护栏）。
- 硬契约：领域概念只进 pack，永不进插件（mvp §5 职责边界：COSMIC、CFP 禁止进插件）。

### 阶段 1 — 产物规划（plan the artifacts）

- 目标：把场景拆成文档产物清单。每产物回答三件事：docType 名、粒度（整需求一份 vs 按上游条目扇出）、与谁发生引用关系。
- 判据一（粒度）：产物数量随工作对象线性增长 → 扇出粒度——上游产物的一个数组条目对应一份下游产物（cosmic 中 req/func/tech 随 plan 的 functions 1:N:N:N；同形态遍布非研发文档：一份合同拆逐条款审查单、一套需求拆逐条追溯行）；全局唯一 → 整事项/整项目一份（项目上下文、总体规划）。
- 判据二（可复用性）：跨工作事项反复使用的产物（项目架构、组织词典）→ 独立 pack、workspace 级、`reuse: true`——**可复用的输出是独立 pack，不是素材**（已否决原则的正面表述：产物可校验、可锚定、可 seal，素材不可）。一次性消费的背景知识才是素材。
- cosmic 对位：原 cosmic-claude 四阶段拆成六 pack，正是沿这两轴分解——context（项目级、可复用）从 plan 的隐性输入升格为链头；sync（知识回流动作）从"重新生成 context"独立出来。

### 阶段 2 — 规格设计（schema 与对象关系）

- 目标：每产物一份 schema.json（draft-07 或 2020-12），定义字段、类型、enum、嵌套结构与产物间的引用键（如 funcId 是 plan↔req↔func↔tech 的锚点）。
- 分层原则：**schema 管结构合法性（静态），规则管策略（参数驱动）**——schema 恒表达结构上限（context 的三级树内联两层 children），实际深度由参数驱动、由函数规则校验（moduleLevels 先例）。schema enum 表达封闭值域（changeKind、dataMovementType），required 表达无条件必填。
- 嵌套边界：声明式 `given` 只支持 `$` 与 `$.field[*]` 一层——二层以上嵌套作用域（tech 的 subProcesses）天然落函数规则，schema 设计阶段就要预见这一点。
- 删繁就简：原型的文档元信息字段（metadata、revised）若无生成/校验语义，不进 schema（cosmic-func/tech 迁移时的既定偏差）。

### 阶段 3 — 检查规则设计（什么算合格）

- 目标：把领域质量标准翻译成规则集。每条规则 = `{ id, severity, suggestion, ... }`。
- 形态选择顺序：schema 能表达的（enum/required/类型）不做规则 → 单字段简单族（长度/禁词/正则）用声明式四族（minLength/maxLength/forbiddenKeywords/pattern）→ 跨字段、跨产物、嵌套作用域、参数联动用函数规则（`check(artifact, context?)`，context 带 upstream/materials/params）。
- severity 分配：error = 必须阻断（结构破坏、锚点断裂、预算越界、唯一性冲突）；warning = 质量瑕疵（超长描述、警示词）；info = 风格建议。规则数量克制：一条参数化规则可以蕴含一族（tech/movement-pattern 一条蕴含原型七条）。
- 硬契约：每条规则必须带 `suggestion` 且写成修复指令而非问题描述（修复回路质量的决定因素）；每条规则必须可变异——造不出"故意损坏样本"的规则无法证明护栏真实（mvp §4.4）。
- 参数化：数值边界与正则源可引用 pack 参数（`{ "param": "..." }`）——规则阈值是领域约定还是部署偏好，authoring 时就要判定（func/tech 检查规则正则参数化先例：默认等价原检查、置空停用）。
- 跨产物规则：扇出锚点对账（req 三点对齐 index/funcId/desiredCfps）是函数规则 + context.upstream 的标准用法；上游缺失一律明确报错，不静默跳过。
- **开发形态（Node 原生，零新环境）**：函数规则就是 `rules/functions.js`——Node `import()` 直载的普通 ESM JavaScript，无构建步骤、无 TypeScript、无 npm 依赖、无 import 语句（自包含辅助函数内置在文件里）；引擎按内容 sha256 快照进回执，规则必须是**纯函数**（输出只依赖 artifact 与 context，禁 I/O、禁时钟/随机/环境变量），保证"模型可见 ⟺ 日志可重建"。作者不需要引入任何 docwright 之外的工具链——写 JS、跑 `pack:check`、（仓库 lane）跑 vitest，全部是 Node。
- **打分制（统一推荐模式，默认即推荐）**：收敛评分是三层策略（pack score > 内置严重度评分 > 指纹兜底），**内置默认就是统一扣分制**：`100 − 10×error − 3×warning − 1×info`（clamp 0-100；权重经 config `oscillation.defaultScore` 可调）。pack **不导出 score 即自动获得**这套模式——内置六 pack 全部未导出，即默认模式足以承载领域收敛检测。仅当领域权重确有差异（某类 warning 在该领域近乎致命）才从 functions.js 导出自定义 `score(artifact, issues) => 0-100`；score 只驱动提前终止，**合格的定义永远是 0 error**，导出崩溃或越界即明确报错（引擎包装）。authoring 默认决策：先不导出，跑真实生成观察到收敛不灵敏再考虑。

### 阶段 4 — 输入输出分类（素材 / 上游 / 产物 / 可复用）

- 素材（materials）：prompt `{{materials}}` 槽注入的参考文本。按语义分目录——`materialsRoot` 声明：`references`（项目参考知识，跨事项共享）vs `input`（一次工作事项的用户输入，plan 声明 input）。语义分离不得混用。
- 上游（upstream）：链式依赖走 `consumes`（必选，工具层强校验合格回执）；可选背景走 rider（调用方经 upstream 数组按需携带已安装 pack 的合格产物）。判断标准：缺了它就无法生成 → consumes；有了更好、没有也能假定 → rider 或 assumptions 显式登记。
- 产物（artifacts）：`scope` 定目录——`topic`（默认，`<topic>/output/`）vs `workspace`（`context/`）；`requiresTopic` 钉死"一个工作事项一个 topic"；`artifactPrefix` 把 per-function 命名权交给引擎（`<PREFIX>-<topicNo>-<NN>`）。
- 复用（reuse）：默认按 scope 语义（workspace true / topic false）；topic pack 声明 `reuse: true` 的前提是全部输入类可对账（materials 清单、upstream 锚点、params 漂移策略）——req/func/tech 先例。动作型 pack（sync）显式 `reuse: false`。

### 阶段 5 — pack 分解与链设计

- 目标：决定做几个 pack、链怎么连。每个 pack 独立成环（生成→校验→修复），pack 边界 = 文档产物边界，不等于业务阶段边界。
- 链形态：consumes 声明 DAG；扇出契约 1:N:N:N（plan 整需求一份，req/func/tech 与 functions 一一对应）；每功能一条平行微链。合并/回流类动作用独立 pack（sync：consumes [context, plan]，产物是 context 新版本）。
- 与现有 pack 的关系（authoring 前必查）：doc_packs 先查同文档类型是否已覆盖；同文档不同组织的裁剪用 packsDir 同名覆盖（DX-H3 合并语义），不 fork；跨场景共享的链级参数（编号规范 topicNoPattern、树深 moduleLevels）在链头声明一次、沿回执继承。
- **跨出处链（packsDir pack 消费内置链）**：`consumes` 的解析空间是 loadPacks 合并后的单一 pack Map（内置根 + packsDir 根），与 pack 出处无关——packsDir pack 可以消费内置 pack 的合格产物、继承其回执 as-run 参数（下游声明同名不填 default）、分享全链一次确认，并随 consumes 边自动进入 doc_chain_status 覆盖账目。可运行样例：`examples/packsdir/task-card`（消费 cosmic-func + cosmic-tech，零参数调用全继承）；真实模型实证：scripts/e2e-real-llm.ts 步骤 6-8。
- 多场景共存：manifest `scenario` 标签按 scenario-chains.md 提案预留（第二个真实场景包立项时落地）。

### 阶段 6 — 参数设计（部署可变的旋钮）

- 逐参数判定（属性全集与装载期不变量见 params-and-chain-contract.md，此处只列判定顺序）：类型（标量/object 预算形）→ required 无 default（只留给"仅从用户意图来"的量，cfpTotal 先例）还是带 default（现役值）→ confirm（要不要经确认）→ overridable（素材可否调整；必须同时 confirm）→ extractable（素材可否抽取自证；必须 confirm，扇出寻址参数不可）→ enum/min/max 约束。
- Mind the gap：只有 value 是生成目标进 `<effective-params>`；区间端点是校验容差，留在规则与回执里。端点本身是生成语义时升级为独立参数（cfpMin/cfpMax 先例）。
- 继承参数（下游声明链上已有参数名）不填 default——回执继承永远优先，default 是死数据（params-and-chain-contract.md 继承声明最佳实践）。
- 被规则引用（数值边界/pattern 源）的参数必须 always-present 且禁 overridable（装载期强制）。
- 克制：参数数量适度；模板里写死的"推荐值"在对应参数存在时必须让位（prompt 以生效参数为准）。

### 阶段 7 — 生成方法与表达层（prompt / template）

- prompt（每语言一份，骨架见 cosmic-plan/prompts/zh-CN.md）：领域模型节（**单 pack 单词汇表**——只讲本阶段概念）→ 输出要求（字段逐项，含取值来源）→ 硬性约束（**规则的镜像**：prompt 约束与规则集一一对应，不一致即 bug）→ `{{materials}}` / `{{upstream}}` / `{{params}}` 三槽位（缺 {{materials}} 装载期报错）。
- 硬契约：硬性约束只写规则可判的东西——prompt 承诺而规则不查 = 护栏摆设；规则查而 prompt 未说 = 模型盲飞进修复循环浪费轮次。
- template（Handlebars）：渲染 Markdown 给人看；无独立校验语义，结构变化跟随 schema。

### 阶段 8 — 验证梯子（六层，由贱到贵）

1. **装载期校验**：`loadPacks` 对新目录全部合格（manifest/rules/prompt/语言覆盖全部 fail-loud 断言通过）。写完即验，零成本。
2. **golden 全部合格**：samples/golden.json 是手工打造的合规样本，须同时过 schema 与全部规则、双语各验一次。required 且无 default 的参数（如 cfpTotal）在 golden 验证时无值可用——可选资产 `samples/golden.params.json`（专供 golden 验证的参数表）提供，缺失时按声明 default 验证；该文件只服务验证，不参与生成。
3. **变异测试**：每条规则族至少一种"故意损坏"变异，断言 checker 全部抓住（内置 pack 由测试套件强制，外部 pack 为约定契约）。
4. **确定性闭环**：scripted LlmPort（损坏 JSON 按脚本注入）走 doc_generate 修复回路，断言收敛、回执字段、终止语义。
5. **宿主冒烟**：`pnpm run smoke:host`——pack 进 tarball → 真实 dsh 宿主 boot → 工具注册断言（无模型调用）。
6. **真实 e2e**：e2e-real-llm 脚本或 dsh web 真实会话——验证模型在真实 prompt 下能否收敛、确认/复用/扇出契约是否按设计工作。

第 1-2 层由 `pack:check` 运行器承载（见实施切分 S1）：`pnpm run pack:check -- <dir>` 对目标目录跑装载期校验 + schema 编译 + 逐语言 golden 全部合格，复用 `loadPacks` 与 `getDocService`，零第二套校验逻辑。authoring 会话中每完成一个资产就跑一次，不合格即修，不积压到最后。

**guide 自包含要求**：验证方法（含 `pack:check` 用法与真实 e2e 的可复现步骤——CLI profile 装载 packsDir、dsh web 重启生效、确认/复用的观察点）必须全文并入技能 guide。仓库侧文件（AGENTS.md、docs/testing/*）在插件被安装到 dsh 后不可达、不可引用——guide 是已安装形态下作者的唯一随包知识源（`guides/` 随 npm 分发）。仓库 README/AGENTS 引用 guide 反向成立（仓库有包没有的才进仓库文档）。

### 阶段 9 — 入册

- version 从 0.1.0 起；description 双语（en 一行是 doc_packs 的模型面，风格对齐 cosmic 六 pack：说清"生成什么、消费什么、粒度"）；README/说明书 §4.x 增节；TODOS.md 记账。
- 仓库纪律：`feat/<slug>` 分支，测试全部合格 + 覆盖率阈值 + typecheck + build 后 `--no-ff` 合并；引擎若有增强，影响评估表随设计文档先行。

## cosmic 系列分解总表（authoring 实例档案）

| pack | 作用 | scope/reuse | consumes | 粒度 | 参数特征 | 规则形态 |
|---|---|---|---|---|---|---|
| cosmic-context | 项目知识链头 | workspace/true | [] | 整项目一份 | moduleLevels（链级契约，confirm） | 函数 4（树遍历/参数联动） |
| cosmic-plan | 需求→功能清单规划 | topic/false | [context] | 整需求一份 | cfp* 预算族（object，cfpTotal required+extractable）、topicNoPattern（引擎派生） | 声明式 6 + 函数 7（含跨产物对账） |
| cosmic-req | 单功能用户故事 | topic/true | [plan] | per-function | targetIndex（required 无 default，寻址）；继承参数无 default | 声明式 5 + 函数 3（三点对齐） |
| cosmic-func | 功能过程设计 | topic/true | [req] | per-function | 继承族 | 声明式 5 + 函数 4 |
| cosmic-tech | 数据移动拆分 | topic/true | [func] | per-function | movementSequencePattern 等（regex 参数化） | 声明式 1 + 函数 7（嵌套作用域） |
| cosmic-context-sync | 知识回流合并 | workspace/false | [context, plan] | 动作 | 无 | 合并对账 2 |

迁移教训（cosmic-claude → docwright 六 pack）：pack 边界跟随产物边界而非阶段边界；原型的摆设校验（校验不强制、失败无回路）由装载期校验 + 变异测试 + 闭环修复三层根治；原型的每类文档一个完整技能包成本过高，docwright 以"六件套声明式资产 + 通用引擎"替代；硬编码 AI 配置与写死推荐值一律参数化。

## 实施切分

- **S1 技能承载与牙齿**：guides/pack-authoring.md（九阶段 playbook 英文全文）+ index.ts 可选注入注册技能 + doc_packs 描述邀请文案 + **pack:check 运行器**（`scripts/pack-check.ts`，`pnpm run pack:check -- <dir>`：loadPacks 装载期校验 → ajv 编译各 pack schema → 逐语言 golden 过 schema + 全部规则全部合格；报告每 pack 规则清单/严重度分布/参数表作为 authoring 体检单）+ 公开出口（index.ts 补 re-export `loadPacks` / `assertManifest`，外部作者可编程复用同一校验）+ 测试（运行器对内置六 pack 全部合格、对损坏目录逐断言报错；技能注册断言进 host-smoke；guide 缺失 fail loud）。
- **S2 实证 pack**：以 product-management 为场景（需求分析与跟踪 → 概要设计文档；参考仓库 `~/projects/lab/product-management/`，Codeup `mosip/product-management`），由 agent 按技能走完九阶段产出合格 pack（全验证梯子 + 真实 e2e）。该仓库是现成的设计输入：22 份 section schema（glossary/systems/modules/roles/epics/user stories/DDP 追溯矩阵等）、req-* 技能流水线（detect 预检测 → analyze 多模型分析 → consolidate 合并 → validate 校验）、docx/markdown 导出器、grm/cms 两个真实工作区样例。**范围原则：S2 以验证 authoring 方法为准，不以原型功能对齐为准**——DDP track 等 pack 允许与原型有明显出入（砍掉多模型合并、裁剪 section、简化对账规则），按"最小可证分解"取舍：恰好让九阶段的每个机制决策点（链头/扇出/参数/跨产物对账/复用）各被行使一次，多余的对齐工作不做。原型仓库的角色是素材与形状参照（section schema 作规则与 golden 的设计原料、grm/cms 样例作测试素材），不是要对齐的规格。S2 的第一项工作就是用阶段 1/5 的分解判据决定 pack 家族形态（素材 = 原始需求 `input/`；候选独立产物：项目级 context（systems/modules/roles，workspace 级可复用）、epic/user-story 级产物、追溯对账矩阵——分解结论出自 authoring 过程而非预先钉死）。兼作 scenario-chains.md 的触发条件（第二个真实场景包）。

## 验收标准（草案）

1. 真实会话中：模型面对未覆盖的文档类型时，经 doc_packs 邀请能发现并加载 docwright-pack-authoring 技能，按九阶段产出 pack 资产。
2. `pnpm run pack:check -- <dir>`：内置六 pack 全部合格；损坏目录（坏 manifest/坏正则/golden 违规/缺槽位）逐断言报错且含修复提示。
3. host-smoke 断言技能已注册；guides 文件缺失时 apply fail loud，错误含修复提示。
4. S2 实证 pack 家族：六层验证梯子全部合格；变异测试抓住全部规则损坏；真实模型 e2e 收敛合格产物；**机制决策点清单逐项打勾**（链头、扇出、参数确认、跨产物对账、复用——DDP 追溯候选正落在"跨产物对账"点上）；分解结论（几个 pack、链形态、对账型产物成 pack 还是消费侧规则）有设计记录。单个 pack 的具体规则集与验收细则出自其自身的设计记录（该 pack 阶段 0-3 的产出），不预先钉死。
5. 既有测试零回归，覆盖率阈值不降；引擎 src/ 零改动（S1 的 index.ts 接线与 scripts/ 运行器除外）。

## 非目标

- pack npm 分发机制（mvp OQ4 挂起中）与 GUI pack 编辑器——packsDir 同名覆盖已支持本地定制，分发等真实用户。
- 把 authoring 做成交互式逐阶段向导（引擎层新工具/状态机）——技能是散文 playbook，阶段推进由模型与用户对话自然承载。
- S2 pack 与 product-management 原型的功能对齐（多模型合并、全 section 覆盖、导出器生态）——S2 是方法的试金石，原型出入不构成缺陷；补齐功能属 S2 之后的独立迭代。

## 已否决（已定案，不再重开）

### 已否决：为 pack 资产再造 meta-schema（docwright 生成/校验 pack 定义本身）

- 否决原则：**pack 契约的机检器已经存在**——pack-loader 即 linter（装载期校验 fail loud，含参数不变量与正则可编译性检查），authoring 的价值在流程引导与领域分析，不在产物形状校验；guide 是过程知识（散文），不是可 schema 化的产物。再造一层自指校验是重复建设，且与 loader 双源漂移。

### 已否决：把 playbook 展开进工具描述

- 否决原则：工具描述是常驻上下文，authoring 内容对非 authoring 会话是纯 token 负担；skill 是拉式按需加载，正是为此设计的分发形态。工具描述只留一句邀请。

### 已否决：用"说明性内置 pack"承载 authoring/测试知识

- 否决原则：**pack 是一类文档的生成契约，不是说明文档的容器**——用一个假 pack 装"如何写 pack"的说明是类别错误，还会污染 doc_packs 的能力发现面（模型把说明书当可生成文档类型）。说明知识的正确载体是技能 guide（随包分发、已安装环境可见、拉式按需加载），仓库文档只是人类面的补充。

### 已否决：authoring 专用引擎工具（dsh 会话内的 doc_pack_create/doc_pack_check 等）

- 否决原则：装配就是写六个文件，模型的文件工具已覆盖；pack 的创建/校验发生在仓库 checkout（packs/ 或 packsDir），不在文档工作区，dsh 会话工具天然错位。引擎对 pack 的唯一事实是装载期校验；验证类需求由仓库侧 `pack:check` 运行器承载（S1）——它直接调用 `loadPacks`/`getDocService`，与装载期校验同源，不构成第二套校验面。被否决的是任何复制 pack 契约知识的独立校验实现。

## 驱动测试协议（S2，可复用脚本）

被测对象是技能本身：驱动者只依据场景意图出提示词，authoring 由真实 dsh web 会话模型按技能执行；驱动者扮演用户（答确认、阶段边界跑 `pack:check`、装载点重启宿主）。产出落 packsDir lane `<workspace>/.docwright/packs/`。会话驱动方法（headless browser、composer 坑）见 AGENTS.md；宿主侧一次性准备：web profile 的 docwright config 声明 `packsDir` 指向该约定目录并重启。

**复用提示词（按轮使用；每轮开新会话，同轮内追问）**：

- **R1 意图（观察点：doc_packs → 技能邀请 → 加载技能的发现链路是否自燃）**：
  「我需要一类新的文档生成能力：需求分析与跟踪场景——输入一批需求（一份需求文档），经过分析与规划，最终产出概要设计文档，并且要能跟踪每条需求是否被设计覆盖。现有 pack 里没有这类文档。参考原型在 ~/projects/lab/product-management（可以读它的 README、src/schemas 和 grm 样例了解这个场景长什么样）。请帮我把这个场景做成 docwright 的 pack。」
- **R2+ 交互纪律**：驱动者不代写资产、不预授分解结论；只做——确认参数/拆答阶段问题、代跑 `pnpm run pack:check -- <workspace>/.docwright/packs --with packs`（在 docwright checkout 下）并原样回贴输出、pack 全部合格后代重启宿主（`dsh-web.sh restart`）、指出会话明显偏离 guide 的行为（引用 guide 原文，不代做）。
- **观察点清单（每轮对照记录进 pm-scenario.md）**：发现链路自燃性；九阶段推进是否被 guide 充分指引（缺步骤/缺示例/缺判据处即缺口）；pack:check 输出能否被会话自主读懂并修复；lane 选择与写入路径是否符合 write-path 节；参数设计是否自发经确认；验证梯子是否被跳步。
- **终局验收**：pack 家族 pack:check 全部合格 + 真实模型经 doc_generate 收敛合格产物；观察记录非空且 guide 已回修（技能被证明可优化且已优化）。

## 开放问题

1. product-management 场景的 pack 分解形态（S2 阶段 1/5 的产出，此处只列张力，裁决标准 = 最小可证分解而非原型对齐）：22 份 section schema 是"一 section 一 pack"还是合并为大产物；DDP 追溯矩阵这类对账型产物是独立 pack 还是消费侧规则；原型的多模型合并（consolidate）语义在 docwright 单模型 + 规则护栏闭环下直接舍弃还是留对账规则。
2. 技能 body 是否分片（单文件 vs 每阶段一文件经 resourceBase 引用）——S1 实施时按 body 实测长度定，超过 ~3k token 考虑分片。
