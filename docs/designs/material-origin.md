# 素材来源打标与 runtime 素材设计

Status: PROPOSED（2026-11-22：设计定稿未实施；实施后更新状态。起因是 WT-BD-DISTANCE 走查链实跑中撞到的两个真实问题：素材冲突导致的修复循环空转，和中间素材可能被当成原始输入重跑链头。）

## 问题

链路跑到中段后，话题目录里会同时存在两类素材：用户提供的原始素材（需求简报、截图坐标），和前面阶段生成、又作为后面阶段输入的中间素材（走查记录简报、演示步骤简报）。目前两类文件混在同一个 `input/` 里，带来两个真实发生过的麻烦：

1. **模型层冲突**。prompt 的素材块是无标签的内容堆——不带路径、不带来源。走查记录生成时，record 简报里写的 `course` 与上游 plan 产物不一致，修复循环在"信素材"还是"信产物"之间摇摆了五轮。模型看不见素材的来源和角色，冲突时没有裁决依据。
2. **误用风险**。没有任何机制阻止把中间素材喂给链头 pack 当成原始输入，从头重跑一条链。用户手动重跑、或模型整理会话时的误操作，都会静默地产出一份"看似新鲜、实则被中间结论污染"的链头产物。

引擎层本身是干净的：materials 是显式 refs，不扫目录，reuse 按 manifest 的 hash 比对，加文件不影响旧链。风险全部在模型可见信息和调用约束这两层。

## 目标

- 模型能看到每份素材的来源（人的原始素材，还是链路中间产物），冲突时有裁决依据。
- 链头 pack（`consumes` 为空）拒绝 runtime 素材——中间产物不允许充当原始输入。
- 目录语义诚实：原始输入、链路工作数据、发布物三个位置分开。
- 不迁移存量话题；新约定只影响之后的链。

## 目录：runtime/ 与 input/ 平级

话题目录变成三个语义位置：

```
<topic>/
├── input/      # 人的原始素材，origin=user
├── runtime/    # 链路中间素材，origin=runtime；子目录随意归堆
└── output/     # 发布物与产物
```

要点：

- **不改名 `input/`**。改名是全量破坏性迁移（materials root、各 pack prompt、存量话题、reuse 锚定路径），收益只有语义好看；歧义问题由打标解决，不靠目录名。
- **`runtime/` 平级而不是 `input/runtime/` 嵌套**。语义上 runtime 素材本来就不是"input"；三个位置读起来就是流程本身（人给素材 → 链路工作 → 发布）。子目录归堆不受影响，`runtime/walkthrough-process/…` 照用——origin 只看素材落在哪个 root，root 下的子目录结构引擎不关心。
- 嵌套方案（`input/runtime/`）作为放弃项记录：少注册一个 root，但把"不是输入的东西"放在 input 目录里，长期看是在给目录名撒谎。

## 引擎改动

| 位置 | 改动 |
|---|---|
| `materials.ts` | materials 候选 root 增加 `<topic>/runtime/`，排在 `input/` 之后（同名文件时 `input/` 优先——人写的东西不被 runtime 副本遮蔽）；`MaterialEntry` 增加 `origin: "user" \| "runtime"`，按命中的 root 判定；`references/` 与 inline text 维持现状（不参与本机制，不标 origin） |
| `prompt.ts` | 素材块从裸 `<material>` 改为带标签：`<material path="input/plan-brief.md" origin="user">`（inline text 不带 path）；渲染前校验素材文本不含会破坏标签的字符串（沿用现有 `{{materials}}` 替换防护） |
| `tools.ts`（doc_generate 调用入口） | 新增链头闸门：pack 的 `consumes` 为空且任一 material 的 origin 为 runtime 时，调用直接报错，报错文案写明"链头 pack 不接受 runtime 素材（origin=runtime）；如需重跑链头，请只用 input/ 下的原始素材" |
| `prompt-receipt`（若素材块进回执） | 回执记录每份素材的 ref + origin，保持"模型可见 ⟺ 日志可重建" |

不做的事：

- 不给 `references/` 和 inline text 引入 origin 概念——它们语义上都是"给这次生成看的知识"，与链路状态无关。
- 不做 runtime/ 的自动写入或自动搬运。谁把中间简报放进 runtime/ 依旧是人或模型的手工动作，引擎只负责"标对、拦住误用"。

## 校验与测试

- `materials.spec`：root 优先级（同名 input 胜 runtime）、origin 判定、inline/references 不标 origin。
- `prompt.spec`：素材块标签渲染、含特殊字符串素材的防护不回退。
- `tools.spec`：链头 pack + runtime 素材 → 报错；带 upstream 的 pack + runtime 素材 → 通过；consumes 非空但调用未传 upstream 时维持现有报错不变。
- 既有 cosmic 链 golden 全绿（它们只用 input/，行为应完全不变）。

## pack-authoring guide 增补（同一提交）

两节短文，纯文档：

1. **素材放哪里**：人的原始素材进 `input/`，链路中间简报进 `runtime/<stage>/`；素材来源标签模型可见，冲突时以上游产物回执为准。
2. **扇出与归集模式**：现状 walkthrough-doc 已是完整实例（fan-out 源 + `doc/matches-merge` 确定性拼装 + `doc_chain_status` 覆盖矩阵兜底）。写明模式要点——归集逻辑写成纯函数规则而不是让模型抄数据；新场景先复用该模式，出现第二个真实需求再评估是否抽引擎公共层（rule of three，现在不抽）。

## 迁移与兼容

- 存量话题不迁移。`runtime/` root 不存在时等于没有该 root，行为与现状一致。
- 已有 green 产物的 reuse 不受影响：manifest 锚定的是文件内容 hash，origin 是调用期判定的展示信息，不进 hash。
- 链头闸门只对"显式传了 runtime 素材"的新调用生效，无存量路径可触发。

## 风险与取舍

- **runtime/ 排在 input/ 之后**意味着同名文件用户素材胜出。反过来（runtime 胜出）会更"新鲜"，但那是拿人的原始素材让位给机器生成的副本，方向反了，选保守的一侧。
- **闸门按 `consumes` 为空判定链头**是启发式：将来若出现"consumes 非空但语义上也是入口"的 pack，闸门会漏。可接受——它挡的是本次真实发生的误用形态（给根 pack 喂中间素材），不为假想形态加复杂度。
- **模型可能绕开标签自说自话**（素材内容里自称"这是原始输入"）。不防：内容层的谎话属于素材质量问题的老范畴（web 内容同理），标签提供的是链路事实，两者并存已足够裁决。

## 已定事项

1. 平级 `runtime/`，不改名 `input/`；嵌套方案放弃。
2. origin 只区分 user / runtime 两值；references 与 inline 不参与。
3. root 优先级 input 在前。
4. 链头闸门按 `consumes` 为空判定，调用期报错。
5. guide 增补素材放置约定与扇出归集模式；归集引擎公共层现在不做。

## 未定的小事

1. runtime/ 下是否给默认子目录约定（`<stage>/`）写进 guide——倾向写，但不做强制校验。
2. `doc_chain_status` 的输出是否要带上 runtime 素材的存在提示（"该话题有 runtime 素材 N 份，属于阶段 X"）——等实跑看有没有价值。
