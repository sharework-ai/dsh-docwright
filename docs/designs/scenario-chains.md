# 设计：场景链与两级能力发现（scenario chains）

Status: PROPOSAL（未实施；触发条件见"实施触发"节）
Date: 2026-10-14
关联: docs/designs/capability-discovery.md（D1 拉式发现的延伸）、docs/designs/docwright-mvp.md 第 3.1 节、TODOS.md

## 问题

pack 按平铺命名空间装载与发现。单一场景（cosmic，4 pack）下无歧义；当多场景包共存（如 cosmic 文档链 + 视频脚本链 + 合同审查）时，平铺发现失效：

- `doc_packs` 全量返回所有 pack 明细，选择空间随 pack 总数线性膨胀；LLM 对列表的选择可靠性在数十条后衰减，模型可能在无关场景的 pack 上浪费往返。
- 场景归属只靠 `cosmic-` 这类命名前缀约定，无机制承载；`consumes` 引用全局名，跨场景的链归属、任务聚焦都没有显式表达。
- 产品定位中的核心概念 **scenario（场景 = 生成方法 + 检查方法的配套）** 在实现层缺失——链（consumes DAG）存在，但"这条链是哪个场景、面向什么任务"没有实体。

同时须保住既有结论（capability-discovery 已定案）：pack 清单不得进入每轮必付的工具描述；发现走拉式。两级发现是拉式的自然延伸——第一级拉场景，第二级拉场景内的 pack。

## 目标 / 非目标

目标：多场景共存时，模型按任务域聚焦选择——先辨场景、再选 pack；场景归属由 manifest 机制承载而非命名约定；单场景体验不退化。

非目标：会话内热加载（维持决策 #9）；pack 在线市场与分发（OQ4）；scenario 上升为 dsh 宿主概念（scenario 是 docwright 插件内部概念）；跨场景的 pack 编排（一个场景的链只由本场景 pack 构成，见 D-2）。

## 概念模型

- **Scenario**：面向一类文档任务的 pack 编组，有名字与一句话描述。一个场景内的 pack 由 `consumes` 构成一条（或少数几条）**场景链**（DAG）。
- **入口（entry）**：场景内无 `consumes` 的 pack，即链头。单入口单链是常态（cosmic），允许多入口（一个场景多条并行链，如"审查链 + 修订链"）。
- **扇出**：链的中后段 per-function pack 按 `targetIndex` 1:N:N:N 展开（已实现，D6）。scenario 层不新增编排原语——协调能力已由 consumes 图 + 三点锚定 + `doc_chain_status` 覆盖矩阵承载，scenario 只是把"哪些 pack 属于同一任务域"显式化，让模型的每次选择都在场景边界内进行。

## 设计

### D-1 scenario 是标签，不是命名空间

manifest 增加必填字段 `scenario`（非空 kebab-case；加载期校验，misconfiguration fails loud）。pack `name` 保持现状：全局唯一、平铺解析，`doc_generate(pack: ...)` 签名不变。

否决"scenario/name 复合主键或强制 `${scenario}-` 前缀"的原则：**强制 scope 使跨场景复用变成命名撒谎**——"视频场景复用 cosmic 的审查 pack"是正当需求，pack 声明自己的主场景，被其他场景的链经全局名 `consumes` 引用即可；名字属于 pack，场景属于编组。

（前置依赖：loader 已强制同一 root 内 pack 名唯一，fail loud——跨 root 覆盖是 packsDir 既定合并语义，不受影响。）

### D-2 doc_packs 恒定分组 shape

`doc_packs` 返回改为按 scenario 分组的恒定结构：

```json
{
  "scenarios": [
    {
      "name": "cosmic",
      "description": "<场景一句话，见 D-3>",
      "packs": [
        { "name": "cosmic-plan", "version": "0.2.0", "description": "...", "consumes": [], "languages": ["zh-CN", "en-US"] }
      ]
    }
  ]
}
```

- **shape 恒定，数据内嵌**：单场景就是一个分组（与现状信息量等价，无第二次调用）；多场景时结构化分组本身提供两级阅读——模型先按场景 `description` 排他，再在组内选 pack。JSON 的层级就是注意力边界。
- 不引入 `scenario` 查询参数、不做"单场景直通 / 多场景汇总"的行为切换——同一工具两种返回形态是模型误用的温床。pack 总数越过数十条、内嵌明细确证成为上下文负担时，再评估按需展开参数（见开放问题）。
- 场景分组按 `name` 字典序稳定输出。

### D-3 场景声明与校验

- 场景的 `description` 取自该场景**入口 pack** manifest 的 `description`（不新增场景清单文件、不新增场景级配置——一个实体一个家：pack 自己说话）。
- loader 校验：`scenario` 必填、非空 kebab-case；同场景内 `consumes` 引用链在装载后可完整解析（既有 unknown-pack 报错已覆盖全局解析，无需场景内重复校验）。
- 内置四个 cosmic pack 声明 `scenario: "cosmic"`。

### D-4 工具文案

- `doc_packs` 描述更新为 "List installed document packs grouped by scenario ..."，保持祈使句闭环（Call this before doc_generate）。
- `doc_generate.pack` 参数描述保持现状（全局名解析，不感知场景）。

## 风险与缓解

- 场景 description 质量决定第一级选择质量：加载期只强制非空，质量靠 pack 作者契约（与 D1 对 pack description 的处理一致）。
- 模型无视分组、跨场景乱选：既有 fail loud 网不变（unknown pack / upstream 合格回执校验 / docType 校验 / 三点锚定），最坏多一轮往返。
- 一个 pack 服务多个场景的真实需求出现时，`scenario` 单值字段不够：届时升级为独立场景清单（pack → 多场景映射），属加法演进。

## 实施触发与切分

**触发条件**：第二个真实场景包立项之时（或内置 pack 总数越过 ~15 个）。在此之前维持现状——单场景下两级结构与平铺信息等价，提前实施只会引入没有真实输入校准的抽象。

实施切分（届时按仓库惯例走独立 `feat/` 分支）：

- **S1 契约**：manifest `scenario` 必填 + loader 校验 + 四个内置 pack 补声明 + doc_packs 分组返回 + 文案。packs 契约未对外发布，manifest 变更无兼容包袱。
- **S2 编排面**：说明书 3.1/4.x 与 README 同步；多入口场景（若第二个场景需要）的 `doc_chain_status` 场景标注。

## 验收标准（草案）

1. 缺 `scenario` 或格式非法的 manifest 加载期报错，错误含 pack 名与修复提示。
2. `doc_packs` 返回恒定分组 shape；单场景返回单组，组内 pack 明细字段与现行为等价。
3. 两个分属不同场景的 pack 共存装载时，`doc_packs` 分组可辨、无串组。
4. 既有测试全部合格；工具描述快照同步更新。

## 开放问题

1. pack 总数数十条以上时是否给 `doc_packs` 加按需展开参数（默认仅场景汇总）——等真实规模反馈再定，不为想象中的规模建机制。
2. scenario 级参数（跨 pack 的场景默认值）——链内参数继承已覆盖（cfpTotal 沿回执传递），拒绝在无第二场景输入时预设场景级参数机制。
3. ~~场景级素材约定（每场景默认 materials root）~~ 已由 cosmic-context 定案（docs/designs/cosmic-context.md）：项目知识是 workspace 级**产物**（context pack，`scope: "workspace"` + `references/` 备料目录 + 复用预检），不是每场景的素材约定——素材目录按 workspace/topic 两级作用域通用解析，不按场景配置。

## 已否决（已定案，不再重开）

> 重新提议备选前先读否决原则；触及原则的变体视为已答。

### 已否决：scenario 作为强制命名空间（复合主键 / 强制前缀）

- 否决原则：**名字属于 pack，场景属于编组**——强制 scope 把跨场景复用变成命名撒谎，且 `doc_generate` 签名、artifact 命名、回执 pack 字段全部随 namespace 漂移，收益只有冲突隔离，而冲突已由"全局名唯一 + 同 root fail loud"机制覆盖。

### 已否决：scenario 独立清单文件作为起步形态

- 否决原则：**一个事实一个家**——场景描述与入口信息在 pack manifest 已有承载，独立清单在"单 pack 多场景"需求出现前是重复事实源。

### 已否决：doc_packs 双形态返回（单场景直通明细 / 多场景汇总）

- 否决原则：**同一工具的返回 shape 必须恒定**——模型对工具契约只学一次；结构化分组已提供两级阅读，行为切换只增加误用面。
