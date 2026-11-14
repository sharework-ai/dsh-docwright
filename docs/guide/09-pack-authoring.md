# 第 9 章 包作者指南

写一个包就是让五份契约（schema、规则、提示词、模板、golden 样本）与同一个领域对齐。docwright 把作者流程收敛为一个随插件分发的运行时技能 `docwright-pack-authoring`：用户提出一类新文档而已装包无法覆盖时，会话模型加载该技能，按九阶段流程产出合格的包资产。用户嘴里说的"做一个生成 X 的 skill"，落点就是这个技能，而不是文件系统的 SKILL.md。

## 九阶段流程

阶段 0-2 与 4-5 是设计阶段，3、6、7 是开发阶段，8-9 是验收阶段，设计与开发之间可以来回迭代，验收不可跳过。

- **阶段 0 场景盘点**：用一段话写清领域模型（流程每一步的核心对象是什么）和问题陈述（今天缺什么护栏）。领域概念只进包，永不进插件。
- **阶段 1 产物规划**：把场景拆成文档清单。每个产物回答三件事：docType 名称、粒度（整需求一份还是随上游逐条扇出）、和谁发生引用关系。跨需求反复使用的产物升格为独立包、workspace 作用域、`reuse: true`。
- **阶段 2 规格设计**：为每个产物写 schema.json，定义字段、enum、required 与嵌套结构，并预留包间引用键（如 funcId）。
- **阶段 3 规则开发**：schema 能表达的不做规则，单字段简单族用声明式规则，跨字段、跨产物、嵌套作用域用函数规则。error 留给必须阻断的问题（结构破坏、锚点断裂、预算越界、唯一性冲突），warning 管质量瑕疵，info 管风格建议。每条规则都要写得可变异。
- **阶段 4 输入输出分类**：区分素材（materials，进 `{{materials}}`）、上游（upstream，经 consumes 或随行注入）、产物（落哪个作用域）、可复用性（reuse 取值）。
- **阶段 5 包分解与套件设计**：决定做几个包、consumes 怎么连，以及是否把相关包定义为一个 suite。包边界跟随产物边界；链的扇出寻址：非 COSMIC 词汇的包在 manifest 声明 fanout: { array, idField, titleField? }（消费的上游数组与身份字段），引擎的 targetIndex 候选、<pack>-<id> 命名与 doc_chain_status 覆盖即按声明工作（未声明走 COSMIC 的 functions[]/funcId 原形，参考 examples/packsdir/idea-board+idea-note）；回流合并类动作用独立包。suite 的判定问题与生命周期代价见下文"套件（suite）设计"一节。
- **阶段 6 参数设计**：逐参数判定类型、required、confirm、overridable、extractable。只有参数的 value 进生成上下文，min/max 是校验容差；数值边界与正则源参数禁 overridable；沿链继承的参数不填 default。
- **阶段 7 生成与表达**：写 prompts 和 templates。提示词的硬性约束与规则集一一对应。
- **阶段 8 验证梯子**：从装载期校验、golden 全绿，逐层上到变异测试、确定性闭环测试、宿主冒烟、真实模型 e2e。日常开发以 `pack:check` 一条命令覆盖前两层。
- **阶段 9 入册**：版本从 0.1.0 起，description 双语，仓库包走 feature 分支合入，用户包发布到市场。

技能内置两道设计确认闸门：阶段 1 结束呈现产物规划表，阶段 6 结束呈现设计契约表（schema 形状、命名三元组、参数表、consumes 边、语言、作用域）。用户要求提速时可合并为一道，但不存在未经用户过目的契约就直接写包文件的情况。

## 套件（suite）设计

创作多个相关包时，suite 大概率是任务的一部分，而不是事后补记——五包一链的 COSMIC 场景就是先例。suite 是市场侧的命名集合：一次安装落全部成员，各部署上成员由 suite 统一管理（不能单独装/更/删某一个，修复要发包加升 suite 版本走审核）。

判定是否做 suite，三个问题：这些包是否服务于**同一个完整场景**？用户是否大概率想**一次装齐**？只装其中一两个是否仍能独立成立？三个都偏"是"就建议定义 suite；只有 consumes 依赖链不足以成为理由——依赖会随包自动装上，suite 的价值在"一键装齐场景全貌"。

判定结论要在阶段 5 的产出里明确呈现给用户（建议或建议不定义，附一句话理由），经用户同意才进发布清单。成员清单直接取自包分解结果；suite 本身是表单投稿不是压缩包。

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

**推荐的创作落位是工作区的 `.docwright/packs/` 目录**：它由装载层级固定承载（见 docs/designs/pack-load-dirs.md），会话期动态装载——改完包文件下一次调用直接生效，不需要插件重载，是调试体验最好的位置。包源码的长期事实源放独立创作库（或仓库 lane 的 `packs/`），经软链接入工作区目录调试，发布走市场审核；工作区目录只留调试软链和临时副本，不入 git。

cordis.yml 的 `packsDir` 指向安装目录（默认 `$DSH_HOME/docwright/packs`），装载时与内置包合并，同名包以此处为准——改内置包行为时复制一份到安装目录再改即可，不必 fork 仓库。

## 加载时机与会话内重载

装载分两层：**内置 / 安装目录 / extraPacksDir 在插件 apply 时装载**——改完这些目录的包文件后，插件必须重新 apply，新包才可见；**工作区的 `.docwright/packs/` 会话期动态装载**——改完包文件下一次调用直接生效，不需要任何重载。推荐把创作落位放在工作区目录，正是为了吃到这条调试路径。

对前三层，验证与生效的固定顺序：

1. **先 `pack:check`**：`pnpm run pack:check -- <packs-root>` 全绿再谈生效。它绕过插件、直接用真实的装载期校验和校验服务跑 golden，包文件有加载期错误时不会把插件带挂。
2. **再触发重载**，三选一：
   - **会话内开关重载**（推荐）：用插件管理工具对 `include:docwright` 先禁用再启用，live profile 立即重新 apply，新包当轮会话即可用。注意两点：禁用期间本会话的 `doc_*` 工具不可用，不要在 `doc_generate` 调用到一半时做；该 profile 下其他会话若正在跑 docwright 生成会被打断。如果重载后包列表没刷新，说明包有加载期错误，回到第 1 步看 `pack:check` 的报错。
   - **市场通道**：包发布到市场后用安装工具装一遍，市场安装自带受控热重载，装完当轮会话可见。
   - **重启宿主**：兜底，代价是杀掉该 profile 的所有会话。

从市场安装的包走安装工具的热重载，不走开关。目录职责划分与加载器改进提案（软链跟随、extraPacksDir、工作区自动装载）见 `docs/designs/pack-load-dirs.md`。
