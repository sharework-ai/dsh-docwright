# 1. 产品总览

## docwright 是什么

docwright 是 deepseek-harness（dsh）的文档生成插件，npm 包名 `@sharework-ai/dsh-docwright`。它提供一组工具，让 agent 按照预定义的文档类型生成结构化 JSON 文档，每次生成都经过强制校验与自动修复，合格产物附带可离线复验的验证回执。

## 要解决的问题

AI 批量生成文档时，质量不可控、结果不可验证。结构化输出框架（instructor、BAML、Guardrails AI 等）只能校验结构，即字段是否齐全、类型是否正确；无法校验内容合格性。"功能描述不少于 80 字""名称不得使用'管理/系统'等泛化词""估算值总和须落在业务区间"这类标准因文档类型而异。

docwright 在内容合格性这一层提供三方面能力：

1. **场景包（pack）**：每类文档的 schema、领域规则、生成 prompt 与渲染模板打包为可安装的内容单元，更换文档类型无需修改代码。
2. **验证回执（receipt）**：每份文档附带机器可读的回执文件，"全部合格"成为可以事后复核的产物。
3. **闭环修复（repair loop）**：校验不通过时自动把问题清单回传给模型重写，直到全部合格或明确失败；失败时保留红标草稿供人工处理，不会静默采用最后一轮结果。

## 核心机制

### JSON 为中心

文档以 JSON 表示，每个 pack 配一份 JSON Schema，因此所有文档都能被机器校验，校验失败可定位到具体字段。Markdown 渲染只是表达层：每次生成落盘产物 JSON、回执文件、Markdown 渲染结果三个文件，事实源是 JSON。

### 场景化配套

一个 pack 对应一类文档，包含 schema（文档结构）、规则（合格标准）、按语言的 prompt（生成方法）与 Handlebars 模板（渲染方法）以及一份必须全合格的 golden 样例。pack 通过 `consumes` 声明串联成多阶段场景链，例如 COSMIC 功能点估算链由 `cosmic-context`、`cosmic-plan`、`cosmic-req`、`cosmic-func`、`cosmic-tech` 五个阶段组成，另有 `cosmic-context-sync` 把规划结果合并回项目上下文。相关的 pack 由市场组织为 suite，一步安装整套。插件本身不含文档领域知识，领域内容全部来自 pack。

### 闭环校验

每次生成在轮次上限内反复执行生成、校验、修复。全部合格的判定标准始终是 0 条 ERROR，warning 与 info 不拦截。修复循环带收敛检测，在轮数耗尽之前识别修复无进展的情形并提前终止，终止原因写入回执。

## 能力获取方式

模型按需找到合适的 pack，分三层：`doc_packs` 列出已安装的 pack；没有合适的时 `doc_market_search` 查询 pack 市场（dm.shrwk.com，部署参数 `marketSearch` 控制开启），`doc_market_install` 在用户确认后安装，安装后当期会话即可使用；市场也没有时，加载随包的 `docwright-pack-authoring` 技能编写新 pack。

## 术语表

| 术语 | 含义 |
|---|---|
| pack（场景包） | 一类文档的完整配套：manifest、schema、规则、prompt、模板、golden 样例，安装于 packsDir |
| suite（套件） | 市场对相关 pack 的命名组合，安装 suite 等于一步装齐全部成员及其依赖的上游 pack |
| artifact（产物） | 生成的文档 JSON 文件，位于 outputRoot（默认 `<workspace>/output/`，链式 pack 为 `<topic>/output/`） |
| receipt（回执） | 与产物同目录的 `<产物名>.receipt.json`，记录校验结论与依据，可由 `doc_validate` 离线复验 |
| sealing（封章） | `doc_validate` 复验合格时为当前产物内容重新签发回执，人工修改过的产物借此重新加入链 |
| topic（话题目录） | 一个工作项一个目录（如 `REQ-142-favorites`），链式 pack 的素材与产物都归入该目录 |
| materials（素材） | 生成时提供的参考材料，默认在 `<workspace>/references/`；可传文件路径或以 `#!inline` 开头的内联文本 |
| upstream（上游） | 链式 pack 消费的上游产物路径，须带合格回执；不在 `consumes` 清单内的合格产物可作为随行上游（rider）注入上下文 |
| params（参数） | pack 声明的可调项，带类型、描述、默认值与 `required`/`confirm`/`overridable`/`extractable` 标志 |
| confirmation gate（确认门） | 参数变更或 confirm 参数未经确认时，`doc_generate` 返回 `pendingConfirmation` 参数表，用户确认后带 `confirm: true` 重发才执行 |
| repair loop（闭环修复） | 生成、校验、将问题清单回传模型重写的循环 |
| issue | 统一格式的校验发现，含规则 ID、严重度、字段路径、消息与修复建议；schema 违规与领域规则输出统一归并为此格式 |
| ruleset snapshot | 回执中保存的规则快照，pack 升级后历史回执仍能说明当时的判定依据 |
| pack 市场 | https://dm.shrwk.com ，pack 内容的分发渠道；插件不含内置 pack |
| scope（作用域） | pack 声明素材与产物的归属：`workspace` 级固定使用 `references/` 与 `context/`，`topic` 级（默认）随话题目录走 |
| reuse（复用预检） | `doc_generate` 生成前检查同一批输入是否已产出合格产物，命中则零模型调用直接返回（`reused: true`），`force: true` 强制重建 |

## 阅读路线

第 2 章说明插件的组成与外部关系，第 3 章逐个说明五个工具的用法，第 4 章说明生成闭环的行为，第 5 章说明回执与复用，第 6 章说明参数模型与确认门。pack 的编写方法见 guides/pack-authoring.md。
