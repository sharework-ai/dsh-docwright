# docs

本目录是 docwright 的文档根：`guide/` 是面向使用者的系统化中文文档，`designs/` 与 `testing/` 是面向开发者的设计与测试记录，`assets/` 存放文档引用的图片。

## guide/ —— 使用文档

| 章节 | 内容 |
|---|---|
| [01-overview.md](guide/01-overview.md) | docwright 是什么、解决什么问题、核心概念一览 |
| [02-architecture.md](guide/02-architecture.md) | 插件在 dsh 宿主中的位置、组成与外部关系 |
| [03-tools.md](guide/03-tools.md) | 工具详解：五个文档工具与两个市场工具的入参与返回 |
| [04-generation-loop.md](guide/04-generation-loop.md) | 生成闭环：生成、校验、修复循环与终止行为 |
| [05-receipts.md](guide/05-receipts.md) | 回执与复用：回执内容、复验与 seal |
| [06-params.md](guide/06-params.md) | 参数与确认门：参数来源、确认流程与沿链继承 |
| [07-chains.md](guide/07-chains.md) | 场景链：COSMIC 六包链路、topic 目录、按功能扇出与覆盖对账 |
| [08-packs.md](guide/08-packs.md) | 包结构与包契约：各文件职责、加载期不变量、作用域与复用 |
| [09-pack-authoring.md](guide/09-pack-authoring.md) | 包作者指南：九阶段流程、函数规则写法、pack:check、本地安装 |
| [10-market.md](guide/10-market.md) | 市场发现与安装：两个市场工具、三层发现顺序、套件 |
| [11-config.md](guide/11-config.md) | 配置参考：每个配置键控制什么行为、默认值、何时需要改 |
| [12-development.md](guide/12-development.md) | 开发与测试：依赖关系、测试与覆盖率门、冒烟、真实模型 e2e、已知取舍 |

## designs/ —— 设计文档

机制事实源。各文档记录一项设计的语义、验收标准与已否决备选，正文以实现后的现状视角书写：

- [docwright-mvp.md](designs/docwright-mvp.md) — 功能说明书：工具语义、闭环与回执细节、插件与包的职责边界。
- 其余文档按主题拆分：包发现（capability-discovery）、收敛检测（convergence-detection）、参数对象模型与链契约（param-object-model、params-and-chain-contract、dynamic-parameters、function-rule-context）、作用域与上下文链头（cosmic-context）、场景链（scenario-chains）、包工坊（pack-authoring）、套件（pack-suites）、参数界面（param-management-ui）、产品管理场景实证（pm-scenario）。

设计与使用文档冲突时以 designs/ 为准，并回修 guide。

## testing/ —— 测试文档

- [test-plan.md](testing/test-plan.md) — 测试计划：关键交互、边界用例与关键路径。
- [e2e-real-llm.md](testing/e2e-real-llm.md) — 真实模型端到端手册：复现闭环所需的环境、命令与已知坑。

## assets/

文档引用的静态资源；`assets/images/` 下的 SVG 由正文以相对路径引用（如 `guide/07-chains.md` 引用 `../assets/images/cosmic-chain.svg`）。
