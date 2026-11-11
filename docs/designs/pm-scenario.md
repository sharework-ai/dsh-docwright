# 设计：pm 场景（pack-authoring S2 实证）—— 驱动测试协议与观察记录

Status: IN PROGRESS（2026-10-30 立项；测试协议见下，观察记录随驱动滚动追加）
Date: 2026-10-30
关联: docs/designs/pack-authoring.md（九阶段方法论，被测对象）、scenario-chains.md（本设计满足其触发条件：第二个真实场景包立项）、`~/projects/lab/product-management/`（原型参考，Codeup mosip/product-management）

## 测试协议（用户定稿，2026-10-30）

**被测对象是 pack-authoring 技能本身**。驱动方式：

- 驱动者（agent）只依据 **ddp-tracking 的意图**（需求分析与跟踪 → 产出概要设计文档）提供提示词，不预授分解结论、不代写 pack 资产。
- authoring 工作由真实 dsh web 会话模型（glm-5.3-flash）按 `docwright-pack-authoring` 技能执行；驱动者扮演用户：给意图、答确认、在阶段边界跑 `pack:check`、在装载点重启宿主。
- 每轮交互记录：技能哪一步指引不足/缺失/误导（观察记录节）；驱动结束回修 guide（fix 记录节）。
- 产出落 `packsDir` lane：`<workspace>/.docwright/packs/`（本测试即该 lane 的首航）。
- 验收：产出的 pack 家族过 `pack:check` + 真实模型生成收敛；**观察记录非空且 guide 已回修**（技能被证明可优化、且已优化）。

## 预研对照基准（驱动者私有，不入会话提示词）

驱动者预先研读原型后的期望分解（仅作会话产出的评估 rubric——机制决策点清单：链头 / 扇出 / 参数确认 / 跨产物对账 / 复用 / 继承参数 / 正则参数各至少行使一次；不作为正确答案灌输给会话）：

- 四 pack 形态：context（workspace 链头）→ requirements（需求清单，整批）→ plan（epic 规划，整批，确认型参数）→ design（per-epic 卡片，扇出）。
- **引擎扇出寻址硬耦合 `functions`/`funcId` 字段名**（`planCandidates`，src/tools.ts:307）：领域词汇不同构时扇出走「寻址参数 + 确定性 artifactName」模式 B；引擎泛化是后续增强候选，S2 不做。
- storiesPerEpic 型 {value,min,max} 参数是 cfp 族的自然对位；epicCode 是 targetIndex 的寻址对位。

## 观察记录（滚动追加）

**R1（2026-10-30，意图提示词见 pack-authoring.md 驱动测试协议；会话 22m47s / 61 步 / 3.3M tok，glm-5.3-flash）**：
- 发现链路：模型自发调 doc_packs 判定"没有这类 pack"→ 主动加载 docwright-pack-authoring 技能——邀请链路自燃 ✅。
- **O1（宿主契约，插件侧修复）**：技能加载即失败 `loaded skill "..." source must be a string`——宿主 skill 工具加载路径（dsh-skill `validateDefinition`）要求 `source` 必填，而注册路径（`validateRuntimeSkill`）不查、注册 API 无默认值，校验不对称；缺 `source` 只有到模型首次加载才爆。修复：注册补 `source: 'bundled'`。属宿主契约缺口而非 guide 缺口；dsh 上游不对称记录在案（只读上游）。
- 方向性提问（ask_user 4 问）质量好：lane（自己推荐 packsDir，引 guide write-path）、分解（2 pack 精简闭环 vs 独立追踪矩阵）、覆盖严格度（可配置策略 vs 写死 error）、语言。**guide 的判断判据被正确消费**：粒度判据推出"本场景无扇出"（设计为整批追踪矩阵）、可复用性判据推出"无 workspace 级产物"（用户未表达项目级复用诉求）——判据工作正常，未需求化的机制点不强塞 ✅。
- **O2（guide 缺口，已修）**：`pack:check <dir>` 语义不明——模型先指向单个 pack 目录，报错费解（`prompts/manifest.json` ENOENT），烧 4 次工具调用才悟到要指 packs 根。guide Verify 节已明确 `<packs-root>` = 子目录为 pack 的目录。
- **O3（guide 缺口，已修）**：会话环境无 pnpm/corepack，`pnpm run pack:check` 不可用；模型自寻路径改为直跑 `node --import tsx/esm scripts/pack-check.ts`。guide 已补免 pnpm 调用式。
- **O4（guide 缺口，已修）**：packsDir lane 的变异自测无成法——模型自造 `.docwright/mutate-test.mts`（loadPacks + DocService 直驱，24/24 命中，质量不错但踩了 URL 百分号编码坑）。guide 阶段 8 已补 recipe（导入路径、validate 签名、upstream 传 consumed golden）。
- **O5（guide 缺口，已修；引擎语义发现）**：模型想实现 coveragePolicy（strict=error / tolerant=warning）先在单规则内按条目降级 severity，被引擎打回——函数规则 issue 的 severity 钉死为规则声明值（rule-engine.ts:126），条目级覆盖被忽略。模型读引擎源码确诊后改为双规则（blocking/gap，参数选择走哪条）。guide 阶段 3 已写明"severity 是规则级"+ 双规则配方。
- **O6（guide 缺口，已修）**：模型声明了 artifactPrefix（REQ/DES）但链头未声明 topicNoPattern → 无 topicNo → 引擎命名静默降级为时间戳名（落盘产物 `req-analysis-1793374028425.json` 实证）。guide 阶段 4 已写明"prefix 与 topicNoPattern 契约成对声明，否则降级时间戳"。
- **O7（guide 缺口，已修）**：`doc_chain_status` 对非 functions[] 链返回"declares no functions[]"——模型正确理解并改用逐条对账表代替，但如果作者在 description/prompt 里承诺链对账矩阵就会落空。guide 阶段 5 已写明模式 A/B 与 chain_status 的适用边界。
- 正面观察（guide 已覆盖、无需改）：写资产前先读 cosmic 同构文件作格式模板；模板里 Handlebars 无 eq helper 被自查发现并改写（"cosmic templates avoid such"——guide 的"跟随 schema 形状"起效）；确认两次拦截均转呈用户未自答；doc_extract_params 附逐字引文抽取 reqCount；重载纪律自述正确（"本会话内不可用，需重载"）；交付记录 packs-record.md 自发产出（guide 阶段 9 的 health sheet 要求）。
- 引擎/工具观察（非缺口）：todo 工具两报参数错（purpose/revision 未声明属性）——dsh 宿主侧问题，与 docwright 无关，记录备查。

## 生成 e2e（R1 后驱动者发起，协议的终局验收）

素材 `input/requirement-sample.md`（6 条工单系统需求，文档写明条数）。新会话单一提示词（生成两步 + 对账）：

- doc_packs 可见新 pack（重载生效）✅；模型读素材 → 发现 extractable reqCount → doc_extract_params 附逐字引文（"本批需求共 6 条（REQ-2026-001 至 REQ-2026-006）"）✅。
- **确认**：pendingConfirmation 参数表呈现（topic 显式 / reqIdPattern 默认 / reqCount 抽取值带引文引文出处），模型 ask_user 转呈未自答，用户签字后执行 ✅。
- 生成：req-analysis 合格回执（1 iteration 收敛）；req-design 以登记册为 upstream，回执 upstreamHashes 锚定 ✅；6/6 需求覆盖对账（模型自制的逐条表）✅。
- 落盘核验（驱动者）：双回执 `isValid: true`、各 1 轮、抽取缓存 `req-analysis.extracted.json`、话题目录产物+markdown+回执齐全 ✅。

## 结论（S2 验收对照）

- 真实会话经 doc_packs 邀请发现并加载技能、按九阶段产出 pack 资产 ✅（验收标准 1）。
- packsDir lane 全流程首航成功：write-path 判读、pack:check 自读自修、变异自测、交付记录 ✅。
- pack:check 双 pack 全部合格 + 真实模型生成收敛合格产物 + 覆盖对账 ✅（验收标准 2/3 的 packsDir 版）。
- 观察记录非空（O1-O7），guide 已回修 6 处 ✅（"技能被证明可优化且已优化"）。
- 机制决策点行使情况：参数确认（confirm+extractable+确认转呈）✅、跨产物对账（引用存在 + 覆盖 + 三方一致）✅、继承（design 读 analysis 回执锚定）✅、正则参数（reqIdPattern）✅；扇出与 workspace 复用未需求化（分解判据正常工作，不强塞）——引擎扇出寻址泛化（functions[] 耦合）记为后续增强候选。

## fix 记录（驱动结束回修 guide）

| 缺口 | guide 修订位置 |
|---|---|
| O2 pack:check 目录语义 | Verify 节：`<packs-root>` 指明"子目录为 pack"，指单个 pack 会报糊涂错 |
| O3 免 pnpm 调用 | Verify 节：`node --import tsx/esm .../scripts/pack-check.ts <root>` 直跑式 |
| O4 packsDir 变异自测无成法 | 阶段 8 第 2 层：throwaway 脚本 recipe（loadPacks + DocService.validate + upstream 传 consumed golden + 两条引擎事实） |
| O5 severity 规则级 | 阶段 3：severity 是规则级不是条目级 + 可配置严格度 = 双规则配方（参数选择走哪条） |
| O6 prefix 无 topicNoPattern 静默降级 | 阶段 4：prefix 与 topicNoPattern 契约成对声明，否则时间戳名 |
| O7 chain_status 适用边界 | 阶段 5：模式 A/B 寻址 + mode B 下覆盖对账住跨产物规则、chain_status 报 no functions[] |
| O1 注册契约（非 guide） | authoring-skill.ts 补 `source: 'bundled'` + 注释 + 单测断言 |
