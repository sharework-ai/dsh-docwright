# 第 11 章 配置参考

docwright 的全部配置都在插件配置块里（cordis.yml 的 `- id: docwright` 下的 `config`）。配置键是唯一的调参入口，代码里没有写死的默认值之外的第二处可调面。默认值由 `src/config.ts` 声明。

```yaml
- id: docwright
  config:
    packsDir: ""
    marketSearch: true
    loadBuiltinPacks: true
    marketUrl: ""
    workspaceRoot: ""
    materialsRoot: ""
    outputRoot: ""
    defaultLanguage: "zh-CN"
    maxIterations: 5
    maxRoundsCeiling: 10
    promptTokenBudget: 60000
    upstreamVersionPolicy: "strict"
    confirmPolicy: "standard"
    oscillation:
      mode: auto
      stagnantRounds: 3
      decliningRounds: 3
      maxRepeats: 3
      epsilon: 0
      defaultScore: { error: 10, warning: 3, info: 1 }
    provider: "deepseek-official"
    model: "deepseek-chat"
```

## 包装载

**packsDir**（默认空）。额外包目录，装载时与内置 `packs/` 合并，同名包以此处为准。装市场包和本地开发包都落在这里，约定 `<workspace>/.docwright/packs/`。改动需要插件重载后生效。本地自用包、覆盖内置包行为时配置它；纯使用者装市场包用会话内 `doc_market_install`，它会写这个目录。目录职责划分、软链调试的限制与改进提案见 `docs/designs/pack-load-dirs.md`。

**loadBuiltinPacks**（默认 `true`）。是否装载插件包自带的 `packs/` 目录。纯市场部署（不想要源码检出里的包）设为 `false`，避免开发副本遮盖 `packsDir` 里装的市场版本。

**marketSearch**（默认 `true`）。是否注册 `doc_market_search` 工具并在发现提示里引导市场查找。关闭后发现链只剩已装包和创作技能两层。离线或纯内网部署关闭它。

**marketUrl**（默认 `https://dm.shrwk.com`）。pack 市场地址，`doc_market_search`、`doc_market_install` 和参数界面的更新检查共用。指向自建或测试市场时配置它。

## 工作区与路径

每次调用的根目录取会话工作区（dsh 会话选定的目录）；没有会话工作区时依次回退到 `workspaceRoot`、进程 cwd。

**workspaceRoot**（默认空）。无会话工作区时的根目录回退。脚本化调用、宿主冒烟这类没有会话上下文的场景需要配置它；普通 dsh 会话留空。

**materialsRoot**（默认 `<workspace>/references`）。素材引用的解析根，`doc_generate`/`doc_validate` 的 materials 相对路径都落在它下面。项目素材不放在惯例位置时配置它。

**outputRoot**（默认 `<workspace>/output`）。产物与回执的写入根，返回的 artifactPath 都在这个目录下。产物归档位置有别的约定时配置它。

路径约束：两个根可以是相对路径（相对工作区根拼接）或绝对路径，但解析后必须落在工作区根之内，越界直接报错。这个约束保证素材读取、产物写入和上游链校验始终有同一个可信边界。在 Linux 宿主上，任何路径参数里的 Windows 盘符路径（`D:\x\y`、`d:/x/y`）会经 `wslpath`（尊重自定义挂载点）归一化成 WSL 挂载路径，`wslpath` 不可用时退回 `/mnt/<盘符>/` 的默认规则。WSL 下从 Windows 侧传路径的场景由此直接可用。

## 生成行为

**defaultLanguage**（默认 `zh-CN`）。`doc_generate` 不传 `language` 时的输出语言；配置为空时回退到包声明的第一个语言。

**maxIterations**（默认 5）。修复循环的默认轮数上限。`doc_generate` 的 `maxRounds` 入参和包 manifest 的 `maxRounds` 都被 `maxRoundsCeiling` 钳制。默认值对多数文档够用；修复经常耗尽轮数才收敛的包可以在 manifest 提高自己的默认值。

**maxRoundsCeiling**（默认 10）。绝对轮数上限，任何入参和包默认都不能突破。宿主运维所有的硬闸门，防止个别调用把修复循环拖到失控。一般不动。

**promptTokenBudget**（默认 60000）。单次修复 prompt 的粗略 token 预算，素材加产物超限时生成前直接报错，避免把超大输入无声推进模型。素材普遍很长或模型窗口更大时调高。

**upstreamVersionPolicy**（默认 `strict`）。链式生成时上游产物回执记录的 pack 版本与当前安装版本不一致的处理：`strict` 拒绝这次调用（要求重生成上游），`warn` 继续执行并在返回里附 upstreamWarnings。上游包频繁升版但不希望整链重跑的环境可改 `warn`，代价是下游产物可能按旧版规则生成。

**confirmPolicy**（默认 `standard`）。参数确认门的档位，调用级 `confirmPolicy` 入参可覆盖单次行为：

- `none`：从不要求确认，适合 headless 和 CI；required 参数缺失仍然报错，as-run 参数照常记录。
- `standard`：显式传了 params、或存在未经上游确认的 confirm 参数时要求确认。交互会话的默认档。
- `strict`：只要有参数表就要求确认，每次生成都过一遍用户。审计要求高的部署用这一档。

**oscillation**。修复循环的提前终止策略，只影响何时停止，不影响合格标准（合格永远是 0 error）：

- `mode`（默认 `auto`）：`auto` 按包导出的 score 评分、无导出用内置默认评分；`score` 强制用包评分；`fingerprint` 只用宽松兜底（比较两轮 issue 指纹）。
- `stagnantRounds`（默认 3）：连续这么多轮未超过历史最佳评分即终止。
- `decliningRounds`（默认 3）：连续这么多轮评分严格下降即终止。
- `maxRepeats`（默认 3）：fingerprint 兜底下连续这么多轮指纹相同即终止。
- `epsilon`（默认 0）：算作"有进展"的最小提升量。
- `defaultScore`（默认 error 10 / warning 3 / info 1）：内置评分的各严重度扣分权重。

只有当真实生成观察到修复循环空转浪费轮数或提前放弃时才调它。

## 模型路由

**provider**（必填，无默认）。宿主 LLM 组合里的 provider 路由名，首次生成调用前必须配置。注意路由名是适配器注册的名字，不是厂商名：dsh-llm-deepseek 适配器注册的名字是 `deepseek-official`（不是 `deepseek`），dsh-llm-pi-ai 按配置的每个 provider profile 各注册一个路由。写错路由名不会立刻报错——调用表现为空流（错误码 `NO_ADAPTER`），`doc_generate` 在第 1 轮报 llm-error 时应首先核对适配器实际注册的路由名。

**model**（必填，无默认）。provider 下的模型名，例如 `deepseek-chat`。
