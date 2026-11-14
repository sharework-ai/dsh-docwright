# 3. 工具详解

docwright 向模型注册七个工具。前五个是文档工具，市场相关两个见第 2 章。所有确定性工具（`doc_packs`、`doc_validate`、`doc_chain_status`、`doc_extract_params` 的校验部分）不调用模型。

错误语义统一为 fails loud：参数未知、取值越界、前置条件不满足时立即报错并列出可选值或缺失原因，不做静默降级。

## doc_packs

零参数发现工具，返回已安装 pack 的清单：`[{ name, version, description, languages, consumes, params }]`。`params` 逐参数给出类型、描述、可选默认值与 `required`/`confirm`/`overridable`/`extractable` 标志。

`doc_generate` 与 `doc_validate` 的工具描述内置静态提示，引导先调用 `doc_packs` 了解可用 pack；`doc_generate` 收到未知 pack 名报错时也会给出同样的提示与可用清单。工具描述不随 pack 集合变化，模型通过调用该工具拉取当前能力，而不是靠描述文本被动同步。

## doc_generate

闭环生成工具，输入 pack 与素材，产出经过全部校验的文档。参数表：

| 参数 | 类型 | 说明 |
|---|---|---|
| `pack` | string | pack 名，如 `cosmic-plan`；未知名称报错并列出可用 pack |
| `materials` | string[]? | 素材引用：相对素材根的路径，或以 `#!inline` 开头的内联文本。链式 pack 因上游产物已注入上下文可省略 |
| `language` | string? | 输出语言。默认取 Config `defaultLanguage`，否则 pack 的第一个语言；pack 不支持该语言时报错 |
| `upstream` | string[]? | 上游产物路径（工作区相对），每份须带合格回执并通过链上校验。pack 声明 `consumes` 时按需提供 |
| `artifactName` | string? | 输出基础名，仅允许文件名字符。声明了 `artifactPrefix` 的 pack 拒绝该参数，产物名由引擎按 `<PREFIX>-<topicNo>`（整需求）与 `<PREFIX>-<topicNo>-<NN>`（逐功能）生成 |
| `maxRounds` | number? | 本次调用修复循环的轮数上限，被 Config `maxRoundsCeiling` 钳制 |
| `topic` | string? | 话题目录名。给定后素材根为 `<topic>/references/`、产物根为 `<topic>/output/`。声明 `requiresTopic` 的 pack 必填；workspace 作用域 pack 忽略 |
| `force` | boolean? | 绕过复用预检，强制重建 |
| `params` | object? | pack 声明参数的覆盖值；未知名称、越界值、required 缺失均报错。改变上游已记录值的传参触发确认门 |
| `confirm` | boolean? | 确认门返回 `pendingConfirmation` 并经用户确认后，带此标志重发同一调用即执行 |

返回 `{ artifactPath, markdownPath, receipt }`。链式 per-function pack 追加 `coverage`（`{ covered, total, missing }`）；`warn` 版本策略下追加 `upstreamWarnings`。迭代耗尽时工具报错，同时把草稿与不合格回执保留在磁盘上供人工处理。

典型调用序列（COSMIC 链首个需求）：

```jsonc
// 1. 链头：项目上下文（workspace 作用域）
{ "pack": "cosmic-context", "materials": ["refs/architecture.md"] }
// 2. 规划（topic 级，消费 context）
{ "pack": "cosmic-plan", "topic": "REQ-142-favorites",
  "upstream": ["context/cosmic-context.json"],
  "params": { "cfpTotal": { "value": 100, "downFactor": 0.9, "upFactor": 1.2 } } }
// 3. 逐功能需求分析（targetIndex 必填）
{ "pack": "cosmic-req", "topic": "REQ-142-favorites",
  "upstream": ["REQ-142-favorites/output/PLAN-142.json"], "targetIndex": 1, ... }
// 4. 收工前对账（工具级调用）
doc_chain_status({ "plan": "REQ-142-favorites/output/PLAN-142.json" })
```

失败情形与报错语义：

| 情形 | 行为 |
|---|---|
| 未知 pack / 未配置 provider | 报错，列出可用值 |
| materials 与 upstream 均缺失 | 报错，说明两条可用路径 |
| requiresTopic pack 未传 topic | 报错 |
| targetIndex 缺失（req/func/tech） | 报错，列出上游全部候选（index、funcId、l2Name） |
| 上游产物无回执、不合格、内容被改、类型不符、版本过期 | 报错，指明哪项检查未过 |
| 修复循环耗尽 | 报错并终止；草稿与红标回执保留在磁盘 |
| 确认门命中 | 返回 `pendingConfirmation` 参数表，零模型调用，不执行生成 |

## doc_extract_params

素材参数抽取工具，配合声明了 `extractable` 参数的 pack 在 `doc_generate` 之前使用。参数表：

| 参数 | 类型 | 说明 |
|---|---|---|
| `pack` | string | pack 名；该 pack 未声明 extractable 参数时报错 |
| `materials` | string[] | 抽取来源，语义同 `doc_generate`；空列表拒绝 |
| `topic` | string? | 话题目录名，决定抽取结果存放位置 |
| `extractions` | object | 逐参数提案：`{ value, quote }` 或 `{ notFound: true }` |

每个提案的 `quote` 必须是素材的逐字片段（忽略两端空白后比对），引擎验证后该值才被接受；验证不通过按未找到处理。`{ notFound: true }` 是一等结果，可附 `suggestion` 与 `rationale` 供用户参考，建议值永不自动生效。required 参数处于 notFound 状态时，生成在开始前被拦截并要求用户给出值或明确认可建议值。

返回 `{ pack, extractionPath, extractable, results, hint }`，`results` 逐参数给出 `extracted`（含 quote）或 `notFound`（含原因）。结果持久化为 `<pack>.extracted.json`，重复抽取整体覆盖。素材变化后原抽取值失效，需要重新抽取。

## doc_validate

确定性复验工具，对已有产物按当前安装的 pack 规则重跑校验，不调用模型。参数表：

| 参数 | 类型 | 说明 |
|---|---|---|
| `artifactPath` | string | 产物路径（工作区相对，如 `output/plan-142.json`） |
| `pack` | string | pack 名 |
| `language` | string? | 显式传参时必须与回执记录一致，否则报错 |
| `params` | object? | 缺省时按回执记录的 as-run 参数复验；显式传参做 what-if 检查 |
| `upstream` | string[]? | 链式 pack 复验时传入与生成时相同的上游路径，跨产物规则随之复验 |

返回 `{ artifactPath, receipt, hashMatches, packVersionStale, sealed?, summary }`：

- `hashMatches`：`true` 产物与回执一致；`false` 产物在生成后被改动过；`null` 没有回执（如手工拷入的样例）。
- `packVersionStale`：`true` 表示回执由另一个 pack 版本写入，绿色结论证明的是旧规则，应重新生成；`null` 表示无回执。
- `sealed: true` 表示本次为合格复验并已重新签发回执（封章）。
- `summary` 提供产物关键计数与 totalCfps，免除调用方回读文件。

链式 pack 复验时省略 `upstream` 会使跨产物规则（如 plan 对齐）按缺失报错并提示补传。

## doc_chain_status

扇出覆盖对账工具，确定性、零模型调用。参数：`plan`（工作区相对路径，须带合格回执）。工具从 plan 的 pack 出发按 `consumes` 关系逐层展开链，扫描产物根下各阶段合格产物，按 `funcId` 与 plan 的 `functions[]` 对齐。

返回 `{ plan, stages, functions, coverage, orphaned? }`：`functions` 逐功能给出各阶段覆盖产物名或缺失；`coverage` 按阶段给出 `{ covered, total }`；`orphaned` 列出 funcId 不属于任何 plan 功能的合格产物。在收工呈现前调用一次即可确认整条链是否跑满。

典型输出形态：

```jsonc
{
  "coverage": {
    "req":  { "covered": 9, "total": 9 },
    "func": { "covered": 7, "total": 9 },
    "tech": { "covered": 7, "total": 9 }
  },
  "orphaned": []
}
```
