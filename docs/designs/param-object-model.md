# 参数对象模型 —— 界面管理的设计地基

参数体系的机制语义（确认细节、漂移策略、Mind the gap、topic 确认）以 `params-and-chain-contract.md` 为准；本文是它的对象模型补充：**参数的层级归属、属性全集、全生命周期行为矩阵、全量清单**，为"插件级 / pack 级参数的界面管理"产品设计提供事实基础。§1–§8 为现状描述，每条均有代码依据（`src/params.ts`、`src/config.ts`、`src/pack-loader.ts`、`src/tools.ts`、各 `packs/*/manifest.json`）；§9 为参数出处/可见性的残留开放方向。

## 1. 参数的四个层级

| 层级 | 拥有者 | 载体 | 作用范围 | 修改影响半径 |
|---|---|---|---|---|
| 插件 Config | 部署运维 | `cordis.yml` / 宿主配置 | 全部工具调用 | 即时生效；不触碰已生成产物与回执（`provider`/`model` 例外：进入 prompt，影响后续 `promptHash`） |
| pack manifest `params` | pack 作者 | `manifest.json`（随 `version` 确认） | 声明即白名单 + 默认值 + 确认/校验属性 | 改 default：影响后续生成，不追溯已产物；结构性增删应升 `version`，否则旧回执照常复用 |
| 调用参数 | 用户 · agent | `doc_generate` 的 `params` 入参 | 单次调用 | 受确认与 `paramDriftPolicy` 约束；写进本次回执沿链继承 |
| 引擎派生 | 引擎（不可配置） | 运行时注入（`topicNo`） | 本调用 + 沿回执继承 | 只能改其来源（`topicNoPattern` 的声明值），不能关闭派生本身 |

## 2. ParamSpec 属性全集（pack 级声明）

| 属性 | 约束 | 语义 | 装载期校验（fail loud） |
|---|---|---|---|
| `type` | `number \| string \| boolean \| object` | 值类型；`object` 必须是平面对象（非数组） | 必填，四值枚举 |
| `description` | 非空字符串 | 唯一说明文案；`doc_packs` 与确认表逐字展示 | 必填 |
| `default` | 与 `type` 匹配 | 缺省值（现役值） | 非 required 时必须匹配 type；number 型须落在 [min,max]；enum 型必须是枚举成员 |
| `required` | boolean | 声明契约性（见下） | 仅 boolean |
| `confirm` | boolean | 确认属性：未经理确认不得以该值执行 | 仅 boolean |
| `overridable` | boolean | prompt 中渲染"素材内容可调整此参数"提示；**不放松任何校验** | 仅 boolean；**必须同时 `confirm: true`**（可调基线必须经用户确认）；被声明式规则引用（ParamRef：数值边界或 pattern 正则源）即报错（硬边界参数不可调） |
| `extractable` | boolean | 可由 `doc_extract_params` 从素材抽取（模型提 `{value, quote}`，引擎机检引文 ⊆ 素材） | 仅 boolean；**必须同时 `confirm: true`**（抽取值的自证通道是确认表引文列，寻址参数无需确认故不可抽取） |
| `min` / `max` | number 型专用 | 值域闭区间 | min ≤ max，须为有限数；object/string 型声明即报错 |
| `enum` | 非 string/number 外禁用 | 取值白名单 | 非空数组、成员类型匹配、default 必须是成员 |

**`required` 的两种组合**（语义完全不同，界面必须区分呈现）：

- **纯 required**（无 `default`，如 `cfpTotal`、`targetIndex`）：值必须来自调用方显式传参或上游回执继承；两者皆无 → 明确报错（`missing required pack param`），缺失项进确认表的 `missingRequired`。
- **required + default**（如 context 的 `topicNoPattern`）：链级必备契约参数——默认值即现役值，永远可解析、永不因自身缺值而要求确认；required 标记表达"该参数是链契约的一部分，不可缺位"。

**值校验三路统一**：显式值、上游回执继承值、声明 default 在解析时走同一个 `assertValueMatches`（type / enum / min-max 全查；回执值违规同样报错，错误文案标注 `(receipt-recorded)`）。未知参数名一律拒绝（白名单原则，错误列出可用名）。

**当前内置 pack 未使用 `overridable` 与 `enum`**——机制完整可用、场景暂未用。界面做属性编辑器时需支持，优先级可低。

## 3. 一次调用内的解析与确认

解析顺序（`resolveEffectiveParams`）：**显式覆盖 > 上游回执基（`paramsBase`，多上游按数组顺序浅合并、后者覆盖）> 声明 default > 纯 required 缺失报错 > 可选无 default 留空**。

确认判定（`params-and-chain-contract.md` 为准，此处只列触发条件）：显式非寻址改参、confirm 参数未经上游确认、topic 首次进入链（topic 行）；required 且非 confirm 的**寻址参数**（如 `targetIndex`）是调用路由，无需确认。档位 `none/standard/strict` 决定是否需要确认，完成确认（把参数表转呈用户）永远是调用方义务。

## 4. 生命周期矩阵（环节 × 参数类）

参数类（列）：

- **P1 普通带默认**：`moduleLevels`、`cfpPerSubProc`、`funcDescMaxLength`、`functionalUserRoles`（装载期不变量下 P1 永不 `overridable`——可调属性必带 `confirm`，即属 P4）
- **P2 纯 required**：`cfpTotal`（plan）、`targetIndex`（req/func/tech）
- **P3 required+default 链契约**：`topicNoPattern`（context）
- **P4 confirm 预算组**：`cfpPerFunc` / `cfpMin` / `cfpMax`（各 pack confirm）、下游 `cfpTotal` 声明（confirm 无 default）
- **P5 引擎派生**：`topicNo`
- **P6 寻址参数**：`targetIndex`（= P2 的子集，required 且非 confirm）

| 环节 | P1 普通带默认 | P2 纯 required | P3 链契约 | P4 confirm | P5 派生 | P6 寻址 |
|---|---|---|---|---|---|---|
| 装载期校验 | default 匹配 type/值域 | 结构校验 | 同 P1 | 同 P1 | 无声明要求（下游 pack 需声明以接纳继承值） | 同 P2 |
| 值解析 | default 兜底 | 显式或继承，缺失报错 | default 即现役值 | 同 P2（下游 cfpTotal 靠继承） | 引擎从 topic 名提取注入（仅 topic 级 pack；显式与继承值优先） | 同 P2 |
| prompt 注入 | 全量进 `<effective-params>`；object 型只投影 `value` | 同左 | 同左 | 同左（端点 min/max 不进 prompt——Mind the gap） | 同左（被动出现，context 无消费语义） | 同左 |
| 确认判定 | 无需确认 | 缺失进 `missingRequired`；显式传值即要求确认 | 自身不要求确认 | 未经理确认即要求确认；上游记录后豁免 | topic 首次进链时随 topic 行要求确认 | **无需确认** |
| 规则校验消费 | 值域/带校验的容差来源 | 预算对账基准 | 编号规则的提取约定 | 带端点校验（issue 文案携带端点） | funcId 编号规则、产物命名 | 三点锚定（index/funcId 对齐） |
| 回执记录 | 全量 effective 进 `receipt.params` | 同左 | 同左 | 同左（记录即下游"已确认"凭据） | 同左 | 同左 |
| 链继承 | 经 `paramsBase` 覆盖同名 default | 继承即免报错 | 继承的 pattern 供下游推导 | 继承即豁免下游确认 | 继承值优先于重新推导 | 继承不豁免寻址（每次仍必填） |
| 复用预检 | 显式改值 → 跳过复用 | 同左 | 同左 | 同左 | （派生值随 topic 定，等价寻址） | **不跳过复用** |
| 漂移处理 | `paramDriftPolicy`（regenerate 拒绝 / revalidate 确定性重验上游） | 同左 | 同左 | 同左 | — | 不参与漂移判定 |
| seal 重验 | 按回执 params 重放；显式 params 覆盖用于 what-if | 同左 | 同左 | 同左 | 同左 | 同左 |

## 5. 内置 pack 全量参数清单

**cosmic-context v0.2.0**（workspace / reuse / 无上游）

| 参数 | type | default | required | confirm | 说明 |
|---|---|---|---|---|---|
| topicNoPattern | string | `^([A-Za-z][A-Za-z0-9]*[-_ ]?[0-9]+)` | ✓ | — | 链契约（P3）：从 topic 名提取编号，沿链继承 |
| moduleLevels | number | 2 (1–3) | — | — | 模块树深度，产物规则校验，与 plan 共享 |

**cosmic-plan v0.6.1**（topic / reuse / consumes context / `materialsRoot: input`）

| 参数 | type | default | required | confirm | 说明 |
|---|---|---|---|---|---|
| cfpTotal | object | — | ✓ | ✓ | 总预算 {value, downFactor, upFactor}；用户给定，经常需要确认；**extractable**（素材明示预算可带引文抽取，如 "the expected CFPs is 70"） |
| cfpPerFunc | object | {value:30, min:15, max:45} | — | ✓ | 单功能均值目标（value 进 prompt，端点校验）；cfp* 族的链头声明（唯一生效的 default） |
| cfpMin / cfpMax | object | {10,5–20} / {70,40–100} | — | ✓ | 单功能下/上限 |
| cfpPerSubProc | number | 2.5 (1–10) | — | — | 数据移动均值，向下游传递 |
| moduleLevels | number | — | — | — | 纯继承声明（现役值来自 context 回执；0.6.1 起不填 default） |
| topicNoPattern / topicNo | string | — / — | — | — | 继承（pattern 现役值来自 context，0.6.1 起不填 default）+ 派生（P3/P5） |

**cosmic-req v0.6.1 / cosmic-func v0.5.1 / cosmic-tech v0.5.1**（topic / reuse / 逐上游链式）

共同参数：`cfpTotal`（confirm，继承）、`cfpPerFunc`/`cfpMin`/`cfpMax`（confirm，**纯继承声明，无 default**——0.6.1/0.5.1 起，现役值来自 plan 回执）、`cfpPerSubProc`（纯继承）、`topicNoPattern`/`topicNo`（纯继承）、`targetIndex`（**number，required，min 1——寻址参数**）。req 专属：`functionalUserRoles`（string 逗号清单）、`funcDescMaxLength`（number 100–2000，default 500）、`cfpsPerRule`（number 10–100，default 30）。

**cosmic-context-sync v0.1.1**（workspace / 不复用）：仅 `moduleLevels`（纯继承声明，无 default）。

## 6. 插件 Config 全量清单

| 键 | 默认 | 作用 |
|---|---|---|
| provider / model | —（首次生成前必填） | LLM 路由；进 prompt（影响 promptHash） |
| confirmPolicy | `standard` | 确认档位，调用可逐次覆盖 |
| upstreamVersionPolicy | `strict` | 上游版本错配：strict 拒绝 / warn 放行并附警告 |
| materialsRoot / outputRoot | `references` / `output` | 素材/产物根目录（pack 可用 `materialsRoot` 覆盖，如 plan=input） |
| workspaceRoot | cwd | 无会话工作区时的根 |
| packsDir | — | 额外 pack 目录（同名覆盖内置） |
| defaultLanguage | 首个 pack 首语言 | 输出语言缺省 |
| maxIterations / maxRoundsCeiling | 5 / 10 | 修复轮数上限 / 硬顶（tool arg > pack default > config，clamp 到 ceiling） |
| promptTokenBudget | 60000 | 单轮 prompt 预算，超限明确报错 |
| oscillation.{mode,stagnantRounds,decliningRounds,maxRepeats,epsilon,defaultScore} | auto/3/3/3/0/{10,3,1} | 收敛终止调参（green 恒为 0 错误，终止只提前退出） |

## 7. 面向界面管理的客观事实（设计输入，非设计）

**读取面现状**：`doc_packs` 暴露每参数 `{name, type, description, default?, required, confirm, overridable, extractable}`——**不含 `min`/`max`/`enum`**；`receipt.params` 提供每次调用的 as-run 值（含派生 topicNo）；确认表行在 `extracted` 档附 `quote`/`extractionRef`（引文出处），unset 行可附 `suggestion`。界面若要编辑约束（min/max/enum）需先扩展暴露面。

**修改影响半径**（界面每类写操作对应的事实）：

| 写操作 | 生效 | 追溯 |
|---|---|---|
| 改 Config | 立即、全局 | 不动已产物；provider/model 影响后续 promptHash |
| 改 manifest default | 下次生成起 | 已产物不变；不升版本则旧回执照常复用 |
| 改 manifest 结构（增删参数/改 type/确认属性） | 下次生成起 | **应升 packVersion**——版本校验使旧回执不可复用，强制按新契约重生成 |
| 调用级传值 | 单次 | 沿回执继承；受漂移策略约束 |
| 改回执 | **没有这个操作**——回执只能经 `doc_validate` 合格 seal 重签（内容改变 hash 才重签），参数记录不单独可改 |

**界面必须遵守的不变量**：白名单（不能创建未声明参数的值）；值校验三路统一（界面上改 default 也要过 min-max/enum 校验）；Mind the gap（object 参数只有 `value` 是生成目标，端点是校验容差——界面上两者必须视觉区分）；`overridable ⇒ confirm`（可调基线必须经用户确认，装载期不变量，界面同受约束；被规则边界引用的参数不可 `overridable`）；纯 required 缺值只能问人；确认权属于用户（agent 转呈受"不得自答"约束，**界面由本人操作，天然满足**——这是 UI 相对 agent 通道的本质优势）；结构性 manifest 改动必须伴随版本升级。

**现状没有任何运行时写 manifest / Config 的工具**——一切修改走文件编辑 + 部署。界面管理是全新的写入面，上述不变量目前全部由装载期/调用期校验兜底，界面侧需要同等强度的前置校验（或复用同一校验函数）。

## 8. 已知差距（设计阶段输入）

1. `doc_packs` 不暴露 min/max/enum——参数编辑器缺约束元数据。
2. 参数无分组/场景标签——跨 pack 共享参数（moduleLevels、cfp* 族）在 UI 上按 pack 平铺会重复呈现（关联 scenario-chains PROPOSAL 的 `scenario` 标签）。
3. 同链重复调用 plan 会再次要求确认 cfpTotal（显式 params 每次都要确认）——"会话内已确认记忆"是潜在 UI 便利点，当前契约无此状态。
4. 派生参数 topicNo 不可关闭，且会被动出现在 prompt 的参数块中（语义无作用，噪音可忽略）。
5. ~~确认表的 `source` 枚举不含出处维度~~ **已收敛（extract-params，2026-10-28）**：`source` 增 `extracted` 档，抽取值以机检引文（`quote` ⊆ 素材）自证出处，未找到是一等结果并前置拦截。仍无出处的是显式传参——显式 params 是正式入口（对话转译的意图通道），表中 `explicit` 行语义即"调用方（用户侧）给的值"，无需机制自证。
**Pattern 引用（正则参数）**：声明式 `pattern` 规则的 `pattern` 可为 ParamRef（string 型参数），装载期约束与数值边界同款——被引参数必须 string 型、有 default 或 required、**不可 `overridable`**；非空 default 必须可编译（装载期与保存通道双重强制，写坏的正则进不了盘）。**检查语义一律为：参数置空（空字符串）= 不检查；设置了 = 字段值必须匹配该正则**（正则一个即够，不分语言——两份语言规则文件引用同一参数，仅 suggestion 分语言）。函数规则（functions.js）以 `context.params` 读同一契约（cosmic-tech 的 movementSequencePattern / subprocessDescPattern）。引用默认值即"现行检查"，在参数维护界面可直接改。

6. `overridable` 的许可只进内层生成/修复 prompt（一句话提示），内层模型对参数的"调整"只物化在产物内容里——回执 `params` 与规则数值边界仍用调用级解析值，"声称的值"与"产物体现的值"可静默分叉。**基线可见性已由 `overridable ⇒ confirm` 装载期不变量收敛**（可调参数基线必须经用户确认）；**残留 = as-run 值记录**（见 §9 开放方向）。且被规则用作数值边界的参数不可 `overridable`（装载期强制——调整必撞规则，许可与校验不得扭结）。

## 9. 开放方向（原缓解提案已实施）

两条提案均已实施、语义并入机制文档：**extract-params**（素材参数抽取，收窄差距 5——机制见 `params-and-chain-contract.md` 素材参数抽取节）与 **`overridable ⇒ confirm` 装载期不变量**（可调参数基线必过人，收窄差距 6 的基线可见性——见同文档参数属性节）。残留开放方向：

### 开放方向：as-run 值记录（内层偏移的完全闭合）

`overridable` 的内层偏移发生在确认之后、生成中，回执与产物均不记录"实际生成所用值"——基线已确认（不变量），但偏移量本身仍不可见。完全闭合需让产物 JSON 或回执携带 as-run 值，由引擎对照 effective 值记差——涉及 schema 与回执契约变更，另行设计。

### 四条值来源路径（现状）

| 路径 | 现状 |
|---|---|
| 外层显式传参（模型写入工具入参） | source=explicit——正式入口语义，值由调用方（用户侧转译）负责 |
| 素材抽取（`doc_extract_params`） | source=extracted——引文机检自证，未找到前置拦截（含 suggestion 供用户认可） |
| 回执链继承 | source=upstream，链上有据 |
| 内层生成调整 | 基线已经用户确认（`overridable ⇒ confirm`）；as-run 值记录为开放方向 |
