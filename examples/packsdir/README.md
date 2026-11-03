# task-card —— 外层 pack 消费内置链产物（示例 / 设计记录）

本目录是一个**非内置 pack 的可运行样例**：用户在自己的 packsDir（约定 `<workspace>/.docwright/packs/`，`config.packsDir` 指向）放置一个自定义 pack，消费内置 cosmic 链的绿产物，按**自己的模板**生成文档。它同时回答一个问题：

> 内置技能（pack）的运行参数和产物，能够被非内置 pack 使用吗？

**能。** 衔接是引擎既定契约，无需引擎改动，跨"内置 / packsDir"边界成立：

| 机制 | 事实源 | 跨边界语义 |
|---|---|---|
| pack 解析 | `src/pack-loader.ts` `loadPacks` | 内置根与 packsDir 根合并进**同一个 Map**，`consumes` 按包名解析，与出处无关 |
| 上游产物校验 | `src/tools.ts` `verifyUpstreamReceipts` | 按回执的 `pack` 字段回查已装载 pack：绿回执 + 哈希吻合 + 版本对账，全是名称寻址 |
| 参数继承 | `src/tools.ts` `mergeUpstreamParams` | 下游声明同名参数（**不填 default**）即从上游回执 as-run params 继承——topicNo/topicNoPattern/targetIndex 等内置链参数原样流入外层 pack |
| 确认门 | `src/tools.ts` 门控判定 | 外层 pack 自身无 confirm 参数、topicNo 已被链记录 → **不再立门**（"全链一次交互"跨边界成立） |
| 扇出寻址与命名 | `planCandidates` + `artifactPrefix` | per-function 上游（含 index/funcId）照样驱动 `CARD-<topicNo>-<NN>` 引擎命名；targetIndex 沿回执继承 |
| 覆盖账目 | `doc_chain_status` 阶段游走 | 沿 consumes 边从 plan 向下游扩展，packsDir pack **自动入册**为链阶段并参与覆盖对账 |
| 复用预检 | `findReusableArtifact` | 上游锚点多重集比对 + 素材清单 + 确定性命名，跨出处照常工作 |

## pack 设计（九阶段要点）

- **场景**（阶段 0-1）：COSMIC 估算链产出的是"给评审批次的产物"；开发团队领用需要另一种版式——**任务卡**。一功能一卡（per-function 扇出），消费两个内置上游。
- **链**（阶段 5）：`consumes: ["cosmic-func", "cosmic-tech"]`——func 供给功能概述与过程清单，tech 供给逐数据移动的 CFP 账目。多上游参数合并按声明序 BFS。
- **参数**（阶段 6）：`targetIndex`（required 无 default，寻址）、`topicNo`/`topicNoPattern`（继承，无 default——继承声明最佳实践）+ 自有部署旋钮 `effortHoursPerCfp`（default 4，CFP→人时折算）。
- **规则**（阶段 3）：声明式 5 条（cardId 格式 / summary 长度与禁词 / 任务描述长度 / 验收要点长度）+ 函数规则 5 条——跨产物锚点对齐、任务行与上游数据移动 1:1 覆盖（多重集比对）、CFP 合计 == 上游 desiredCfps、人时折算公式、summary 措辞落地（warning）。上游缺失一律响亮报错。
- **模板**（阶段 7）：卡片版式（概述 / 任务清单表 / 验收要点），与 tech 的 Function-Point Breakdown 表判然有别——这就是"按自己的模板生成"。

## 使用与验证

```sh
# 装载门 + golden 全绿（golden 上游 = 内置 pack 的 golden，--with 合并内置根）
pnpm run pack:check -- examples/packsdir --with packs

# 真实模型 e2e：scripts/e2e-real-llm.ts 会把本 pack 复制进沙箱工作区的
# .docwright/packs/（即真实 packsDir lane），在 context→plan→req→func→tech
# 全链之后追加：零参数调用 task-card（全继承）→ 断言不立门、绿、自有版式、
# 引擎命名、回执上游锚点指向内置 pack、chain-status 入册、复用命中。
ZAI_CODING_CN_API_KEY=… node --import tsx/esm scripts/e2e-real-llm.ts
```

真实部署：把 `task-card/` 目录放进 `<workspace>/.docwright/packs/`，cordis.yml 的 docwright `packsDir` 指向该目录，插件重载后 `doc_packs` 可见。会话调用：`doc_generate` pack=`task-card`、topic 沿链、upstream 传 func + tech 产物路径——**params 完全省略**，targetIndex/topicNo 全部从内置链回执继承。
