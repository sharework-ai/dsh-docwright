# 第 9 章 包作者指南

写一个包就是让五份契约（schema、规则、提示词、模板、golden 样本）与同一个领域对齐。docwright 把作者流程收敛为一个随插件分发的运行时技能 `docwright-pack-authoring`：用户提出一类新文档而已装包无法覆盖时，会话模型加载该技能，按九阶段流程产出合格的包资产。用户嘴里说的"做一个生成 X 的 skill"，落点就是这个技能，而不是文件系统的 SKILL.md。

## 九阶段流程

阶段 0-2 与 4-5 是设计阶段，3、6、7 是开发阶段，8-9 是验收阶段，设计与开发之间可以来回迭代，验收不可跳过。

- **阶段 0 场景盘点**：用一段话写清领域模型（流程每一步的核心对象是什么）和问题陈述（今天缺什么护栏）。领域概念只进包，永不进插件。
- **阶段 1 产物规划**：把场景拆成文档清单。每个产物回答三件事：docType 名称、粒度（整需求一份还是随上游逐条扇出）、和谁发生引用关系。跨需求反复使用的产物升格为独立包、workspace 作用域、`reuse: true`。
- **阶段 2 规格设计**：为每个产物写 schema.json，定义字段、enum、required 与嵌套结构，并预留包间引用键（如 funcId）。
- **阶段 3 规则开发**：schema 能表达的不做规则，单字段简单族用声明式规则，跨字段、跨产物、嵌套作用域用函数规则。error 留给必须阻断的问题（结构破坏、锚点断裂、预算越界、唯一性冲突），warning 管质量瑕疵，info 管风格建议。每条规则都要写得可变异。
- **阶段 4 输入输出分类**：区分素材（materials，进 `{{materials}}`）、上游（upstream，经 consumes 或随行注入）、产物（落哪个作用域）、可复用性（reuse 取值）。
- **阶段 5 包分解与链设计**：决定做几个包、consumes 怎么连。包边界跟随产物边界；链的扇出按上游数组条目对应；回流合并类动作用独立包。
- **阶段 6 参数设计**：逐参数判定类型、required、confirm、overridable、extractable。只有参数的 value 进生成上下文，min/max 是校验容差；数值边界与正则源参数禁 overridable；沿链继承的参数不填 default。
- **阶段 7 生成与表达**：写 prompts 和 templates。提示词的硬性约束与规则集一一对应。
- **阶段 8 验证梯子**：从装载期校验、golden 全绿，逐层上到变异测试、确定性闭环测试、宿主冒烟、真实模型 e2e。日常开发以 `pack:check` 一条命令覆盖前两层。
- **阶段 9 入册**：版本从 0.1.0 起，description 双语，仓库包走 feature 分支合入，用户包发布到市场。

技能内置两道设计确认闸门：阶段 1 结束呈现产物规划表，阶段 6 结束呈现设计契约表（schema 形状、命名三元组、参数表、consumes 边、语言、作用域）。用户要求提速时可合并为一道，但不存在未经用户过目的契约就直接写包文件的情况。

## rules/functions.js 写法

函数规则是 Node 原生 ESM JavaScript，无构建步骤、无 TypeScript、无 npm 依赖。文件导出 `rules` 数组：

```js
export const rules = [
  {
    id: 'my-pack/budget-band',
    severity: 'error',
    suggestion: '把 totalCfps 调整到 [value*downFactor, value*upFactor] 区间内',
    check(artifact, context) {
      const params = context?.params ?? {}
      // ... 返回 issue 数组，空数组表示通过
    },
  },
]
```

`check` 的第二个参数 `context` 可选，携带三个字段：`upstream`（解析后的上游产物数组）、`materials`(素材原文数组)、`params`（本次调用生效的参数）。单参数规则继续工作不变。规则必须是纯函数：输出只依赖 artifact 与 context，禁止读写文件、时钟、随机数和环境变量，保证同输入同结果、可离线复验。

缺上游时跨产物规则应明确报错，不静默跳过。

## pack:check 校验

`pack:check` 是包作者的日常校验命令，跑真实的装载期校验（manifest、参数不变量、正则可编译性、prompt 槽位、语言覆盖），再用真实的校验服务逐语言验证 golden 样本，输出健康清单（规则清单、严重度分布、参数表）：

```sh
pnpm run pack:check -- <packs-root>                # 校验一个包目录
pnpm run pack:check -- <packs-root> --with packs   # 包消费了其他目录的包时合并解析
```

`<packs-root>` 是以包为子目录的那个目录，不是单个包目录。退出码 0 为全绿；任何一条红都意味着立即修复，错误消息带规则 ID 和修复提示。作者每完成一个资产就跑一次，不要积压到最后。

pnpm 不可用时可直接调运行脚本：`node --import tsx/esm /path/to/docwright/scripts/pack-check.ts <packs-root>`。

调试期的输出物（变异测试脚本、临时产物、e2e 中间拷贝）放工作区的 `tmp/` 子目录，不要散落在包目录或仓库里；工作区受 git 管控时把该目录加进 `.gitignore`。包资产本身（packs/ 与文档）正常入 git。

## 本地安装与同名覆盖

写好的包装到本地只需一处配置：cordis.yml 的 `packsDir` 指向一个包根目录，约定用 `<workspace>/.docwright/packs/`。装载时该目录与内置包合并，同名包以 packsDir 为准——改内置包行为时复制一份到 packsDir 再改即可，不必 fork 仓库。

## 加载时机与会话内重载

包在插件 apply 时装载。写完或改完包文件后，插件必须重新 apply，新包才可见；刚写完的包不能在写它的同一会话里直接用于 `doc_generate`。

验证与生效的固定顺序：

1. **先 `pack:check`**：`pnpm run pack:check -- <packs-root>` 全绿再谈生效。它绕过插件、直接用真实的装载期校验和校验服务跑 golden，包文件有加载期错误时不会把插件带挂。
2. **再触发重载**，三选一：
   - **会话内开关重载**（推荐，不动其他会话之外的东西）：用插件管理工具对 `include:docwright` 先禁用再启用，live profile 立即重新 apply，packsDir 的新包当轮会话即可用。注意两点：禁用期间本会话的 `doc_*` 工具不可用，不要在 `doc_generate` 调用到一半时做；该 profile 下其他会话若正在跑 docwright 生成会被打断。如果重载后包列表没刷新，说明包有加载期错误，回到第 1 步看 `pack:check` 的报错。
   - **市场通道**：包发布到市场后用安装工具装一遍，市场安装自带受控热重载，装完当轮会话可见。
   - **重启宿主**：兜底，代价是杀掉该 profile 的所有会话。

从市场安装的包走安装工具的热重载，不走开关；packsDir 里的裸文件变更只有上面第一、三条覆盖。
