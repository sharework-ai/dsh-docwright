# 设计：修复循环收敛检测三层机制（convergence detection）

Status: IMPLEMENTED (2026-10-11)。
Date: 2026-10-11
关联: docs/designs/docwright-mvp.md 第 3.2 节、TODOS.md D2-convergence

## 现状与缺陷

现状（`src/loop.ts`）：每轮对 Issue 集合取指纹（`ruleId|jsonPath|message` 排序拼接，`src/issue.ts`），**连续两轮指纹完全相同即提前终止**（`repeatedCount >= 1`）。

该机制是双面失败：

| 场景 | 现状行为 | 影响 |
|---|---|---|
| 原地踏步（两轮 Issue 集完全相同） | 第 2 轮即终止——只重复一次就杀 | 过敏：错杀"第三轮换个思路就好了"的情况 |
| 来回改（修好 A 坏 B、修好 B 坏 C） | 指纹每轮不同 → 判为"有进展"，烧满 maxIterations（默认 5） | 失明：净收益 ≤ 0 却花光全部预算，完成率的主要杀手 |
| 微小改进 | message 内嵌实测值（如 `length 42 < min 80`），值一变指纹即变 | "不同 = 进展"的假设不成立：值变不等于在收敛 |

根因：指纹只有"相同/不同"两个状态，丢失了收敛过程的**方向**与**幅度**。它当初的合理性在于"修复 prompt 已含问题清单，产出相同问题集 = 零效果，继续烧只是烧钱"，但这只覆盖原地踏步一种形态。

## 目标 / 非目标

目标：终止决策基于收敛轨迹而非签名相同性；提高修复循环任务完成率；规则宽松化、参数可配置；终止原因可观测（进回执）。

非目标（边界钉死）：**全绿判定不变**——合格仍是 0 ERROR，评分只决定"何时放弃"，不决定"是否合格"。评分不得成为通过门槛，否则 pack 写个烂评分会把绿文档判死。

## 设计

### 三层策略（评分优先、默认评分居中、指纹兜底）

| 层 | 启用条件 | 说明 |
|---|---|---|
| 1. pack 评分 | pack 的 `functions.js` 导出 `score(artifact, issues) => number`（**0-100 百分制**，越高越好；返回越界 fail loud，与函数规则崩溃同路径） | pack 作者按文档领域定义质量分（cosmic-claude 的 0-100 审计评分是现成迁移来源）。加载期校验：`score` 若存在必须是函数；调用崩溃 fail loud 并带 `pack/score` 标识 |
| 2. 内置默认评分 | pack 未导出 `score` 时自动启用 | 严重度加权，同样百分制：`clamp(100 − wE×error − wW×warning − wI×info, 0, 100)`（默认 10/3/1，可配）。不写评分的 pack 免费获得轨迹检测 |
| 3. 指纹兜底 | Config 显式选择 fingerprint 模式时 | 规则放宽：连续 N 次指纹相同才终止（默认 N=3，现状是 2 轮即杀） |

`mode: auto`（默认）= 有 pack 评分用层 1，否则层 2；`mode: score` 强制层 1（pack 没导出 score 则调用期报错）；`mode: fingerprint` 强制层 3。

### 收敛规则（比较基准 = 历史最优，容忍单轮回撤）

- **停滞**：连续 K 轮未超过历史最优分（`score > best + epsilon` 才算改进）→ 终止，reason `stagnation`。默认 K=3。
- **阴跌**：连续 D 轮严格下降 → 终止，reason `decline`。默认 D=3。
- 单轮回撤被容忍：`30 → 25 → 32` 第 3 轮创新高即重置计数，不误杀；持续横盘/阴跌才触发。两个计数器独立运行，先到先终止。

### 评分的计算位置：checker 算，循环跟踪，不进文档

pack 的评分由 checker 每轮计算、循环内部跟踪，不进入文档。原则：**校验/终止信号不得由模型自报，as-run 值必须来自确定性代码**——最终判定由 checker 给出，回执可重放要求信号源可复现。"评分写进文档、循环提取"的替代案及后果见附录 A。

1. 评分与规则同源（都是 pack 作者的判定逻辑），信任层级一致。

"约定评分输出在文档的哪个结构位置"相应改为"**约定评分函数在 pack 的哪个位置**"（`functions.js` 的 `score` 导出）。

### 可观测性

- 回执 `rounds[]` 每轮增加 `score?: number`（0-100 百分制）；
- 终止原因进回执/循环结果：`reason: 'green' | 'stagnation' | 'decline' | 'fingerprint-repeat' | 'max-iterations' | 'llm-error'`——收敛过程从不可见变为可审计。
- 回执 formatVersion 维持 1：新增字段全部为可选附加项，老读者读新回执不受影响，新读者把缺失字段视为"无"。

### Config 字段（no hardcoded tunables）

```yaml
oscillation:
  mode: auto              # auto | score | fingerprint
  stagnantRounds: 3       # 连续未超历史最优的终止阈值
  decliningRounds: 3      # 连续严格下降的终止阈值
  maxRepeats: 3           # 指纹兜底：连续 N 次相同才终止
  epsilon: 0              # 改进判定容差
  defaultScore:           # 内置默认评分权重
    error: 10
    warning: 3
    info: 1
```

（键名与嵌套形态实现时可按 schemastery 习惯微调，语义以本节为准。）

## 验收标准（草案）

1. 带 `score` 的 pack：脚本化轨迹（升/平/降）断言终止轮次与 reason 正确。
2. 无 `score` 的 pack：默认评分权重下的轨迹同上。
3. 单轮回撤不终止（30→25→32→全绿）。
4. 指纹模式：连续 N−1 次重复不终止，第 N 次终止。
5. 回归：0 ERROR 即 green，评分不参与合格判定；迭代耗尽仍保留草稿 + 红回执。
6. 回执 rounds 带分数、终止带 reason；doc_validate 行为不变。
7. 全部 Config 字段生效性测试（确定性脚本 LlmPort，无真实模型）。

## 开放问题

1. stagnantRounds/decliningRounds 阈值（K=D=3）的真实 LLM 校准不可达：glm-5.3 级模型对三种违规素材均一轮修复（模型优先 pack 规则，护栏按设计工作），默认阈值对强模型安全偏松；如需真实停滞观测，需更弱模型或规则不可满足的 pack。实测数据见 docs/testing/e2e-real-llm.md。
2. epsilon 对浮点评分的合理默认（0 对整数评分足够，浮点评分 pack 需自配）。
4. 百分制触底饱和：严重坏文档（默认权重下 ≥10 个 error）会触 0 分，层 2 随后无法区分"小步改善"与"原地踏步"，退化为横盘检测（按 stagnantRounds 终止，不会空转烧钱）。是否需要计数维度补偿或权重细化，待 cosmic-claude 历史产物实测后定；对严重坏文档早停本就符合成本护栏意图。

## 附录 A：已否决（已定案，不再重开）

### 评分写进文档、循环从文档提取（模型自报质量分）

- 否决原则：**校验/终止信号不得由模型自报**——模型有动机打高分骗过终止机制，"最终判定由 checker 给出"被绕开。
- 附加后果：文档是交付物，嵌入循环遥测会污染 schema 语义与回执哈希（每轮分数变 → 产物变）；信号源非确定性，回执不可重放。
- 正解：评分与规则同源（都是 pack 作者的判定逻辑），经 `functions.js` 的 `score` 导出由 checker 计算。

## 决策记录

- 2026-10-11 用户指出指纹机制对"修好 A 坏了 B"过于敏感、提出评分机制优先 + 指纹宽松兜底 + 参数可配置的分层设计，采纳为总体框架。
- 2026-10-11 用户补充：评分统一采用百分制（0-100），pack 评分契约与内置默认评分同标。
- 修正两点（经讨论确认）：现状指纹实际抓不住"修好 A 坏了 B"（那是失明侧，恰是评分要补的）；评分改由 checker 计算而非嵌入文档（防作弊/产物纯净/信任层级），"文档内约定位置"改为"functions.js 约定导出"。
- 2026-10-12 真实多轮运行对账默认权重：score = 100 − 10×error 精确吻合，两轮 promptHash 各异（数据见 docs/testing/e2e-real-llm.md Calibration 节）。
- 2026-10-12 每轮轨迹（score/promptHash）经回执 rounds 进入审计流；独立 doc-gen-round session 事件类型延后（dsh 插件事件写侧 ignorable 缺口，见 TODOS Deferred）。
