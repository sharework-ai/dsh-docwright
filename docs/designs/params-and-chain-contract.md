# 参数治理与链契约（params & chain contract）

Status: implemented（2026-10-13 定稿并当日落地：D5 参数治理 / D6 扇出契约与覆盖账目 / D7 seal 与 API 便利性；packs v0.2.0；scripts/e2e-real-llm.ts 真实模型全链 PASS）

参数的层级归属、属性全集、生命周期矩阵与全量清单见 `param-object-model.md`（界面管理设计地基）；本文负责机制语义（确认、漂移、Mind the gap、topic 确认）。

## 问题

真实 web 会话（session-b4ff21a7，收藏夹 COSMIC 全链）暴露四类缺口：

- **参数通道缺失**：用户硬约束（单功能 ≤15 CFP、总量 ≥90）只能进 materials 散文，与模板写死的"推荐 20-50"竞争注意力，两次生成违约且校验全绿——护栏对用户约束不设防。
- **确认缺失**：执行前无人核对生效参数；参数是否存在、取值多少，调用方与用户均不可见。
- **扇出无契约**：req/func/tech 为 per-function 粒度，但 `index` 静默默认"未指明选 index 1"，9 个功能只生成 1 份且校验全绿；覆盖（每个 plan 功能都有对应产物）是集合性质，规则引擎逐产物校验天然表达不了，收工时无人对账。
- **外部编辑死路**：手工/人工修改产物后 hash 与回执失配，`doc_validate` 通过也不回写 sidecar，重新认证的唯一手段是整体重跑生成，摧毁外部修改。

## 共享参数

四阶段共用一组参数，取代 cosmic-tech 现有 `cfpMinRatio`/`cfpMaxRatio`：

```jsonc
{
  "cfpPerFunc":    { "value": 30,  "min": 15,  "max": 45 },  // 单功能均值：目标 + 均值校验带
  "cfpMin":        { "value": 10,  "min": 5,   "max": 20 },  // 单功能下限：目标 + 声明值校验带
  "cfpMax":        { "value": 70,  "min": 40,  "max": 100 }, // 单功能上限：目标 + 声明值校验带，超出应拆分模块
  "cfpTotal":      { "value": 100, "downFactor": 0.9, "upFactor": 1.2 },  // 总量：目标 + 相对偏离带 → [90, 120]
  "cfpPerSubProc": { "value": 2.5 }                                  // 子过程平均 CFP
}
```

- `cfpTotal.value` **必填且无默认**：缺失即拒绝执行，错误信息引导调用方向用户确认后经 params 传入。预算只从用户意图来，不从素材文本来。
- 各阶段接线：plan 按 `cfpMin.value`/`cfpMax.value` 约束单功能取值（规则 plan/cfp-func-range）、按 `cfpPerFunc.{min,max}` 校验跨功能均值（规则 plan/cfp-avg-band）、按 `cfpTotal` 偏离带校验总量；func/tech 按锚点与 `cfpPerSubProc` 引导过程/子过程规模，总量按偏离带校验。单功能体量天然允许异构——{10, 60} 均值 35 合规，1×70 均值 70 违规。

## Mind the gap：只有 value 进生成上下文

参数对象里只有 `value` 是生成目标，渲染进 prompt 的 `<effective-params>`（`{value, min, max}` 投影为 `{value}`）；`min`/`max`/`downFactor`/`upFactor` 等区间端点是校验容差，只活在规则与回执里，经修复回路的 issue 消息到达模型（渲染投影见 `src/prompt.ts` generationParams）。

为什么：模型会把上下文中出现的数值当作写作目标贴合。校验带入词有两种失败——带太宽时违约值合法通过（历史案例：`cfpPerFunc {30,10,100}` 入词，1×70 的单功能规划全绿通过）；带收紧后模型会压缩估算凑带宽而不是拆分模块。生成语义与校验语义必须分家。

若某个 min/max 本身就是生成语义（如"单功能不低于 10、不超过 70"），把它升级为独立参数的 `value`（`cfpMin`/`cfpMax`），而不是把外层参数的校验端点暴露进上下文。判断标准一句话：**这个数描述"文档应该长什么样"（进上下文），还是"离目标多远必须打回"（留在规则）？**

## 参数属性与解析顺序

每个参数声明三个属性：

| 属性 | 语义 |
|---|---|
| `required` | 无默认值时：未经显式 params 提供即拒绝执行；带默认值时：链级必备契约参数——默认值即现役值、永远可解析、沿回执继承，自身不要求确认 |
| `overridable` | prompt 中渲染"素材内容可调整此参数"提示（内层生成许可，一句话提示；不是解析层覆盖，不放松任何校验）。显式 params（对话转译/CLI）是正式入口，不需要任何属性许可 |
| `confirm` | 进执行前确认表；参数总数超过 10 时确认表只列 `confirm: true` 项 |
| `extractable` | 可由 `doc_extract_params` 从素材抽取：模型提 `{value, quote}`，引擎机检引文后值入解析第三档。装载期必须同时 `confirm: true`（抽取值的自证通道就是确认表的引文列；扇出寻址参数无需确认故不可抽取） |

解析顺序：**显式 params > 上游回执继承 > 抽取值（仅 `extractable` 项，须过引文复验）> 声明默认值 > required 缺失即 fail loud**。对话中用户陈述的意图由 agent 转译为显式 params——这是意图的正道；materials 散文默认无权配置 pack，防止素材内容静默改写配置。

**继承参数的声明最佳实践（pack 作者）**：设计为沿链继承的参数（下游 pack 声明上游已声明的参数名），**声明不填 default**——链上运行时回执继承永远优先，default 永不生效，写了只是误导性的死数据。default 的剩余语义是"该链式 pack 独立使用（上游缺失该键）时的兜底值"——确需支持此形态才填。内置 cosmic 链已按此对齐：req/func/tech 的 cfp* 族、plan 的 moduleLevels/topicNoPattern 等继承声明均无 default（版本 0.6.1/0.5.1）。参数维护界面把这一语义显式化：被遮蔽的声明以删除线展示并标注"由 X 管理——此处声明不生效"。

**装载期不变量（可调参数基线必过人）**：`overridable: true` 必须同时 `confirm: true`，违者 pack 加载即报错。确认语义（confirm 参数未经上游确认时即要求确认）由此保证：任何可被素材调整的参数，其基线值至少一次呈现在用户面前并被确认——"采用的值不是声称的值"从不透明收敛为仅剩内层偏移量不可见（as-run 值记录是开放方向）。`confirmPolicy: "none"` 的无人通道从不要求确认，此不变量在其上不提供保证。配套约束：被声明式规则引用（数值边界 `resolveBound` 或 pattern 正则源）的参数**禁 `overridable`**——内层调整必然撞自身规则进修复循环，许可与校验不得扭结；`overridable` 只对生成目标型参数（值是软目标而非硬边界，如角色清单、均值目标）有意义。

## 素材参数抽取（extract-params）

确认表的 `explicit` 档分不清"素材明示的值"与"模型断言的值"（差距：两档同表同权）。抽取步骤把"读素材 → 提值"从模型的不可见推理变成引擎可机检的证据链：

- **声明面**：pack 在 ParamSpec 上声明 `extractable: true`（装载期必须同时 `confirm: true`），`doc_packs` 逐参数标注；`doc_extract_params` 只接受声明过的参数名。
- **机检**：模型对每个抽取参数提 `{ value, quote }`，引擎校验 quote 是素材的逐字子串（两侧空白归一后包含）且值满足参数 spec；`{ notFound: true }` 可附 `suggestion`（+`rationale`，须与 suggestion 同现）——建议值过同一 spec 校验，但**永不自动生效**，用户认可的唯一通道是显式 params。
- **未找到是一等结果**：引文不在任何素材中、模型未提出、素材没写——都记 `notFound`，不报错、不代答。required 参数 notFound 时前置检查在花费生成成本之前拦截，请用户给出或明确认可建议值（fail-loud 错误逐参数携带抽取结果与建议）。**素材缺值被模型代答必须防止，不以模型能力提升为豁免理由。**
- **持久化与缓存**：抽取结果落 `outputRoot/<pack>.extracted.json`（pack、packVersion、素材清单 anchors、逐参数记录），重抽取整体覆盖；文件损坏/缺失 = 无抽取层（与损坏回执照常生成同语义）。
- **消费侧复验**：`doc_generate` 解析前对**本次调用的素材**重验每条引文——素材变了/引文失配/spec 收紧（pack 升版）的值一律丢弃，落回下一档解析。抽取文件是缓存，不是契约。
- **确认表**：`source` 增 `extracted` 档，行带 `quote` + `extractionRef`（引文自证）；unset 行可带 `suggestion`/`suggestionRationale`。确认不新增确认类型——extractable 必 confirm，链头首调照旧要求确认，抽取值在表中以引文自证，继承豁免照旧。
- **复用对账**：复用预检额外比对抽取值与回执 as-run params——重抽取出不同值即拒绝复用，新值经链头 确认流程到用户面前（抽取层在解析序中位于回执继承之下，故上游已记录的参数不受抽取影响；抽取值的变化面就在复用预检 + 链头确认）。
- **链路位置**：抽取发生在链头生成之前、扇出之前，一次抽取保护整条链（抽取值经链头回执 as-run params 沿链继承）。

## 参数确认

```
需要用户确认 ⟺ (本次调用显式传了 params) ∨ (存在 confirm: true 的参数且未经上游回执确认)
```

- 确认命中且未确认时，`doc_generate` 返回结构化 `pendingConfirmation`（附生效参数表，零 LLM 成本，不执行）；调用方带 `confirm: true` 重发同一调用即执行。
- 确认面**只有生效参数表**：每行含生效值（尚无值的行省略 `value` 字段——显式 `undefined` 不是 lossless JSON，会令整个工具返回值被 dsh 运行时拒绝；缺失态由来源标注 `unset` 与必填缺失标记承载）、来源标注（pack 默认 / 显式传入 / 上游继承 / 抽取引文——抽取行附 `quote` 与 `extractionRef`，unset 行可附 `suggestion`/`suggestionRationale`）、必填缺失标记、参数漂移影响预判。注入的校验规则清单与 prompt 骨架哈希不进用户视野，仅存在于工具返回值与回执（审计可重建）。
- **沿链继承**：共享参数在链头声明一次，执行后写入上游回执 as-run params；下游阶段从上游回执继承，继承不是新的参数输入，不再触发确认。全链用户交互恰一次，位置在链头。下游显式传 params 且与上游回执不一致视为改参数，重新触发确认；与回执完全一致（键序无关）视为继承回显，无需确认。

### topic 确认（链首次进入）

`requiresTopic` pack 的调用若满足：传了 `topic`、且**尚无任何上游回执记录其 `topicNo`**（topic 首次进入链），则 `topic` 本身按 confirm 参数处理：`pendingConfirmation` 的参数表以 topic 行开头（`confirm: true`），调用方必须转呈用户确认或纠正（用户未命名 topic 时调用方可从输入推断缺省值，但由用户签字）——实现"用户给 topic 直接用，没给默认一个再确认"。上游回执记录 `topicNo` 后，下游阶段继承值、此后不再要求确认（全链一次交互）。workspace 级 pack 忽略 topic，也绝不把某个 topic 的编号写进共享回执（派生只在 topic 级 pack 发生）。

### 确认档位（confirmPolicy）

插件配置 `confirmPolicy`（每次调用可用同名入参覆盖，未知取值 fail loud）决定**是否需要确认**；怎么完成确认（把参数表转呈用户）始终是调用方的职责，不得自答用户未见过的确认：

- `"standard"`（默认）：显式改参或 confirm 参数未经上游确认时要求确认；required 且非 confirm 的参数（如扇出寻址的 `targetIndex`）是调用路由而非策略，其出现无需确认。
- `"none"`：无需确认（headless/CI）。required 缺失仍 fail loud；as-run params 照常入回执，审计性不变。
- `"strict"`：只要有参数表可展示就要求确认，每阶段都过一遍用户确认。

确认的可信度由"模型可见 ⟺ 日志可重建"兜底：谁批的、批了什么，session log 可完整重建；standard 档下模型未转呈用户就 `confirm: true` 属调用方违规，凭日志审计追责。
- 确认不命中的 pack（无 params、无 confirm 参数）单次调用直接执行，零额外往返。

## 参数漂移

pack 级参数 `paramDriftPolicy`：

- `"regenerate"`（**默认**）：参数漂移即要求重新生成上游产物，fail loud 并指明变更的参数。质量优先。
- `"revalidate"`：按新参数对上游产物做确定性重验（规则引擎，零 LLM），绿则链继续并记录漂移，红则 fail loud 列出未通过的具体规则。产物昂贵、漂移确证无害的 pack 可选此档。

确认表的参数漂移影响预判行在用户确认前给出后果（严格档："确认后将重新生成上游"；宽松档："新参数下重验 ✅ 仍合规 / ❌ 将重新生成"）。

## prompt 接线

生效参数以 value 投影视（见"Mind the gap"）渲染进 prompt 的"生效参数"节（既有机制）。模板中写死的推荐值（如 plan 的"estimatedCfps 推荐 20-50"）在对应参数存在时不得渲染，避免模板推荐与用户预算竞争；参数缺席时维持现有默认行为。

## seal——回执回签

不变式：凡被下游引用的产物，其当前内容一定以绿色状态通过过校验；hash 把合格证绑定到具体内容版本，不是缓存。`doc_validate` 对当前内容完整校验，**绿色时把新回执写入 sidecar**——发证渠道从"只有生产线（doc_generate）"扩展为"生产线 + 质检站（doc_validate）"。防伪性质不变：过不了校验就补不了证，改坏的产物照样进不了下游。人工/外部编辑由此获得续链通道。

## 链扇出契约（1:N:N:N）

plan 整需求一份；req/func/tech 与 plan 的 functions **一一对应，份数相等**；每个功能一条平行微链 req→func→tech，无树形组合扇出。

- `targetIndex`（req/func/tech）**必填参数**，无默认；缺失即 fail loud，错误信息列出上游全部候选（index、funcId、l2Name）。prompt 中"未指明时选 index 1"删除。
- **命名契约**：声明了 `artifactPrefix` 的 pack 命名权全在引擎（整需求产物 `<PREFIX>-<topicNo>`、per-function 产物 `<PREFIX>-<topicNo>-<NN>`），显式传 `artifactName` 响亮报错；per-function 产物命名权在引擎，（真实会话手起名撞车、一份产物被静默覆盖），同名覆盖在机制上不可能发生，重生成幂等。声明了 `artifactPrefix`（REQ/FUNC/TECH/PLAN）的 pack，产物名 = `<PREFIX>-<topicNo>-<NN>`（NN = targetIndex 两位右对齐）；未声明的保持 `<pack>-<funcId>`。
- **funcId 编号**：funcId = `<topicNo>-<序号>`（规则 plan/func-id-numbering）——topicNo 由引擎按参数 `topicNoPattern`（默认提取 topic 名中字母开头、截至数字段，如 `KERQ-352-favorites` → `KERQ-352`）从 topic 名提取并注入派生参数；pattern 声明在链头 cosmic-context（confirm: true，链头参数表可见、随回执全链继承——编号规范属项目级知识，应源于项目参考素材）；序号两位右对齐（01-99，100 起无引导零）且等于功能在 plan 数组中的位置。提取不到编号时优雅降级（规则跳过、命名回退 `<pack>-<funcId>`）。funcId 不再承载模块编号链——一个模块可承载多个功能，模块对账改按模块名（l2Name，规则 plan/context-alignment）。
- 锚定规则（三点对齐 index/funcId/desiredCfps）保持不变，逐产物照常校验。

## 覆盖账目

覆盖是产物集合的性质，检查职责归链级账目，不塞进单产物规则引擎（引擎边界保持一次一产物）。

- 新增确定性工具 `doc_chain_status`（零 LLM）：扫描工作区回执与 plan 产物，输出覆盖矩阵——每个 plan 功能在 req/func/tech 层的覆盖情况（covered artifactName / missing）与各层计数。
- `doc_generate` 对 per-function pack 的成功返回附覆盖进度行："req 层已覆盖 4/9，缺 FAV-ITEM-02、…"——agent 每一步都被账目引导跑满 N 份；收工呈现前查一次 `doc_chain_status` 对账。

## 编号参数与背景素材

- **编号规则参数化**：`reqNoPattern`、`funcIdPattern` 等可选参数（带默认值），渲染进 prompt 并接线对应校验规则；未提供不阻塞，沿用默认。`REQ-UNKNOWN` 类乱编由此收口。
- **背景素材指引分两层，各一个家**：引擎层在 `doc_generate` 工具描述加一句通用指引（工作区 `references/` 下存在项目背景素材——架构、模块、编号规范、术语——应纳入 materials）；pack 层在 prompt 素材节写场景化清单（对 COSMIC 估算有用的素材类型）。事实各归其家。
- **`defaultMaterials` 为预留机制**（第二迭代）：按存在性注入惯例路径素材，铁律三条——非阻塞、确定性、回执可审计（注入了什么必须可重建）。惯例被实践证明靠不住时才机制化。
- **代码探索不在 docwright 职责内**：素材中记录代码位置，dsh agent 以自身工具阅读后以 `#!inline` 供给成品素材；docwright 保持文件沙箱边界。

## API 便利性修订

- 链式 pack 提供 `upstream` 时 `materials` 改为可选（上游产物文本已入 prompt），消除"两次确认各得一条线索"的调用摩擦。
- `doc_generate`/`doc_validate` 返回值增加产物摘要：关键计数（功能数/过程数/子过程数）、totalCfps、得分、各严重度 issue 数，免除调用方回读产物文件。

## 已否决（不再重开）

- **req 收拢为 all-functions 单产物**：覆盖确可降为普通规则，但违背 1:N:N:N 对应形态；req 与 func/tech 粒度分裂的认知成本高于一个确定性覆盖工具。正解：扇出契约 + `doc_chain_status` 集合级对账。
- **独立 preflight 工具**：要求 agent 预先声明链，链作为执行计划可能中途伸缩；参数解析逻辑被复制到 doc_generate 之外。正解：确认机制内建于 `doc_generate`，参数沿回执继承，全链一次交互。
- **`contextOverridable` 命名**：语义方向易读反（像"覆盖上下文"）。正解：`overridable`，属性只管"素材可否覆盖该参数"一条旁路；显式 params 永远是正式入口。
- **`revalidate` 作为漂移默认档**：产品立场质量优先于效率。`regenerate` 为默认，`revalidate` 是产物昂贵 pack 的显式选择。
- **required 无默认时强制 overridable**：二者正交——`required` 管来源（必须显式提供），`overridable` 管素材权限（可否覆盖）；预算类参数的正确组合恰是 required + 不可覆盖。
