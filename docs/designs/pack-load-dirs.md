# Pack 装载设计

Status: PROPOSED（2026-11-14：现状盘点 + 三项提案（软链跟随、装载层级与默认安装目录、优先级与遮蔽可见性）+ 启用/禁用机制设计；均未实施，实施后更新本状态）

## 问题

创作与发布的目录混用。以 op-demo-steps 为例：包源码直接放在工作区的 `.docwright/packs/`（部署 packsDir）里，改包即改部署，包版本历史混进工作区仓库，其他工作区要用只能手工拷贝。需要明确：包源码放哪里、安装产物放哪里、调试循环怎么走。

## 现状

装载入口是 `loadPacks(builtinRoot, dirs)`（pack-loader.ts），合并顺序内置在后、extra 在前，同名包以 extra 为胜（DX-H3 语义）。配置面只有两个来源：

1. **内置 `packs/`**：插件包自带的目录（`loadBuiltinPacks` 开关，默认开）。纯市场部署关掉它，避免源码检出遮盖安装副本。
2. **`packsDir`**（单值字符串）：安装目录，市场安装（`doc_market_install`）与更新/删除的唯一写入目标。当前无默认值，由部署补丁显式指定。

已实测的边界（2026-11-14）：`listPackRoots` 用 `readdir(withFileTypes)` 后按 `isDirectory()` 过滤，**不跟随符号链接**——在 packsDir 下放软链指向创作库的单个包，装载结果为空。

两条创作 lane（行为差异摘要见 pack-authoring.md，目录与装载的事实源在本文档）：

- **仓库 lane**：包源码在 docwright 检出的 `packs/` 下，随插件版本发布，走仓库全量测试门。cosmic-* 链属此类——它们同时是变异测试、宿主冒烟与 golden 的引用基座。
- **packsDir lane**：包源码直接落在部署 packsDir。零配置可用，但创作与安装同目录。

## 职责划分（目标状态）

| 目录 | 层级 | 谁写 | 职责 |
|---|---|---|---|
| 插件仓库 `packs/` | 插件版本 | 发布时打包 | 内置场景包与测试基座（cosmic-*） |
| packsDir，默认 `$DSH_HOME/docwright/packs` | home 级（profile 共享，可配置覆盖） | 市场安装/更新/删除 | 安装缓存（含 suites.json 本地记录），gitignore |
| extraPacksDir（单值，跟随 profile） | profile 级 | 用户配置 | 附加包目录：创作库挂载、场景化目录等 |
| 当前工作区 `.docwright/packs/`（向上搜索） | 工作区级 | 会话文件工具 | 每工作区的创作调试位，随工作区走 |
| 独立创作库（如 `lab/docwright-packs`） | 仓库 | 包作者 | 域包源码事实源，配 `pack:check` CI 与 suite 投稿表单，经软链/发布接入 |
| 市场（dm-dev） | — | 审核流程 | 分发通道 |

## 背景：插件与 profile

插件装进 profile：各自的 node_modules、bundles 声明、cordis.patch.yml 配置，同一插件可以有多个副本和多份配置——本机 web 与 e2e-docwright 两个 profile 就是实例。因此"装了哪些包"的默认事实源要放在 home 级（`$DSH_HOME/docwright/packs`），不随 profile 走。profile 的配置只有两个作用：packsDir 设了就以它**替换** home 级默认安装目录（替换，不是追加）；extraPacksDir 表达"额外从哪加载"。

GUI 不暴露 profile 管理（一个进程一个 profile），用户觉得 packsDir 是糊涂账的根源在这里。解法是默认值加可见性，而不是要求用户理解 profile。

## 信任域约束（沿袭既有决策）

- pack 安装是**配置变更**，不是文档产物（pack-authoring.md"否决原则"）：packsDir 属 cordis.yml 部署配置（信任域 A），doc_generate 的 workspace 路径属信任域 B；authoring 不在 A/B 之间架桥，"素材不能静默改配置"的防线不得被模型可写面绕开。
- 生效时机分两层（decision #9 的细化）：
  - **内置 / packsDir / extraPacksDir 在 apply 期装载**。目录由插件配置或宿主发布决定，与会话无关，写入后需插件重新 apply 才可见。会话内重载通道（插件管理工具对 `include:docwright` 禁用再启用，live profile 立即重新 apply）已实测可用；操作顺序与注意事项见 guide 09"加载时机与会话内重载"：先 `pack:check` 全绿再重载。
  - **工作区 `.docwright/packs/` 是会话期动态装载**。宿主 apply 时无法预知会话落在哪个工作区，每次 `doc_generate` / `doc_packs` 调用时解析当前工作区并装载。目录小、纯 JSON 加一个 JS 模块，开销可忽略；回执逐次记录 ruleset 快照哈希，复验确定性不受影响。所以工作区层的调试循环不需要重载：改完包文件，下一次调用直接生效。需要重载的只有前三个目录层。

## 提案 P1：listPackRoots 跟随符号链接（小改动，先做）

过滤条件改为 `isDirectory() || isSymbolicLink()`，对 symlink 条目做 `realpathSync` 后复验是目录再装载。

无死循环风险：装载只扫 packs 根的直接子项、读包目录内的已知文件，不递归展开；软链先解析为绝对真实路径再判定，环状软链解析结果仍是确定目录，读文件即结束。两条守卫随实现带上：同根内多个软链解析到同一真实目标时按 realpath 去重只装一次（origin 注明）；origin 展示解析后的真实路径——软链可把包源指到工作区之外，这个可见性是必须的。

Windows 注记：创建符号链接需要管理员或开发者模式（`mklink` 不带 /J 时），但目录联接（junction，`mklink /J`）不需要特权，且 Node 的 readdir 把 junction 报告为普通目录——junction 形态的包软链在现有代码下就能装载，P1 对它是锦上添花。realpath 去重用 `realpath.native`（返回磁盘真实大小写，路径大小写不敏感环境下去重才可靠）。另有一层 git 现实：authoring 仓库在 Windows 上 clone 默认 `core.symlinks=false`，符号链接退化为含目标路径的文本文件——Windows 检出的调试循环用 junction 或同步脚本，不依赖 git 带软链。

解锁的调试循环：

```
创作库 packs/<name>/ 为源码事实源
  → 工作区 .docwright/packs/<name> 放软链
  → 改完即用（工作区层动态装载），另开终端跑 pack:check 把关
```

源码始终在创作库，安装目录不脏，调试副本与源码零漂移。同名覆盖语义不变：软链包就是所在根里的普通条目。市场安装写入的是真实目录，与软链互不干扰。

## 提案 P2：装载层级、extraPacksDir 与默认安装目录

保留 `packsDir` 现状不动（单值字符串，市场安装/更新/删除的写入目标），新增 `extraPacksDir`（同为单值字符串，跟随 profile），并把当前工作区的 `.docwright/packs/` 升级为固定装载层（不再只是 packsDir 的约定路径）。加上默认安装目录，三项合起来构成新的装载层级：

```
内置 packs/  <  packsDir  <  extraPacksDir  <  工作区 .docwright/packs
```

**默认安装目录**：packsDir 默认空、路径由用户随手指定，是三个糊涂账的根源——默认工作区换了包就失效、不同用户路径不一致、配置藏在看不见的补丁文件里。改为 packsDir 未配置时，插件解析 `$DSH_HOME/docwright/packs` 为默认安装目录（DSH_HOME 是宿主既有的家目录概念，凭据/附件/会话已在此，整体迁移时包目录随之走）。配置项降级为高级覆盖，多 profile 需要差异化包集时才用；工作区级目录由固定工作区层承载，不再依赖 packsDir 指路。guide 里"packsDir 指向约定目录"的说法更新为"不配即默认，配了即覆盖"。

**决策理由**：

- 工作区层固定化恢复了每工作区零配置的调试位。packsDir 是 profile 级配置，把创作目录塞进去要改全局配置，这正是原来别扭的地方；工作区层语义固定后，创作调试随工作区自然走
- extraPacksDir 与 packsDir 一样保持单值字符串：语义只是"再加一个目录"，创作库挂载、场景化目录各占其一够用。真需要同时挂多个检出时，由 P1 软链降维——在一个目录里并排软链即可，配置面保持两个字符串不变
- 工作区层排在最高：工作内的调试副本必须能遮盖一切

**向上搜索**：`searchWorkspacePacksUpward`（布尔，默认 `false`）。开启后从工作区目录逐级向根搜索 `.docwright/packs`（与 `.git`、`.editorconfig` 同一心智），命中的多个目录内层胜出——monorepo 仓库根放一套包，子目录工作区直接继承，子目录可局部覆盖。

默认关的理由：向上搜索意味着装载来自工作区祖先目录、会话文件工具可写的包源，这是未声明的信任放宽——用户只打开了子目录工作区，包却可能来自几层之上的目录。默认关闭时，装载面只有内置、home 级安装目录、extraPacksDir 和工作区自身四处，全部是用户显式放置或显式配置的，不需要额外信任决策。设置面：该选项归入高级分组，默认折叠不展示。

工作区自身层的信任定位：工作区是用户自己打开、自己创建 `.docwright/packs/` 的地方，自动装载它等同于工作区技能（workspace skills）的既有信任模型——打开工作区即信任其内容，不需要首载确认门。需要额外信任决策的只有向上搜索这一处，所以它是默认关的选项。

## 提案 P3：同名包的优先级与遮蔽可见性

多来源后，同名包可能同时存在于内置 `packs/`、packsDir、extraPacksDir、工作区多处。现在唯一的规则是"后装载者静默胜"——谁在生效不可见，调试时会出现"我改了这个包为什么没生效"（改的副本被另一处遮盖）。

装载顺序固定为全序，从低到高（即 P2 的层级）：

```
内置 packs/  <  packsDir  <  extraPacksDir  <  工作区 .docwright/packs（向上搜索，内层胜）
```

同名包永远只有一份生效，确定性可复验（回执已记录 packVersion，补记来源后可逐字节复现）。排序语义：安装目录可遮内置包（用户显式覆盖），工作区层排最高，工作内的调试副本必须能遮盖一切。

**遮蔽必须可见，不允许静默**（fail-loud 的延伸）：

1. `doc_packs` 输出每个包增加 `origin` 字段（`builtin` / `packsDir` / `extraPacksDir` / `workspace` / `workspace:<层级深度>`，向上搜索命中时标注相对深度）与 `shadowed` 字段（被谁遮盖、各副本的路径与版本）——用户随时能回答"现在生效的是哪一份"。
2. 装载期对同名多副本出一条 info 级装载报告（不阻断，在 doc_packs 健康清单里列全）。
3. 回执记录生效包的 `origin`：`doc_validate` 复验时若同名包的生效来源变了（比如开发目录删了软链、落回安装目录），回执的 ruleset 快照哈希天然不一致，复验会红——机制上已经闭环，只需把 origin 记进去让诊断信息可读。

**严格模式**：`packShadowPolicy: "allow" | "error"`（默认 allow）。设为 error 时，装载期发现跨来源同名直接报错退出——适合"我只要市场安装、不玩覆盖"的纯使用者部署，把意外的遮盖变成响亮的失败。实现沿用 manifest 校验的装载期闸门位置。

## 启用与禁用

设置界面为每个独立 pack 和每个 suite 提供启用开关。存储方案：docwright 配置层级新增一个**禁用名称数组**：

```yaml
- id: docwright
  config:
    disabledPacks: ["weekly-report", "cosmic"]   # pack 名或 suite 名
```

语义：

- 数组元素可以是 pack 名，也可以是 suite 名——suite 名由装载器经本地 `suites.json` 展开为成员包名；直接写成员包名同样生效。展开在装载期完成，市场不可达不影响（suites.json 就是为此存在的本地事实）。
- **禁用即不装载**：禁用的包不进 `doc_packs` 清单、不能被 `doc_generate` 调用。不选"装载但标灰"的形态，因为半装载状态会让回执与链校验出现第三种口径。
- 遮蔽与禁用的组合语义：禁用的是"名字"，生效的"那份"由层级优先级决定。禁用高层的包后，低层同名副本自动转为生效——用户关掉调试副本的开关，安装副本立即接上，这个组合是有用的，写进测试。
- **链上禁用要响亮**：被禁用的包若出现在某条链的 consumes 上，装载期直接报错（沿用 fail loud），不静默跳过——缺上游静默跳过会让下游包以残缺配置进入会话。
- **前置检查与提示复用单包删除的既有逻辑**（pack-manage.ts），两条守卫同款语义：
  - suite 成员守卫（`suiteManaged`）：禁用一个 suite 成员包时，开关路由到 suite——写 suite 名（装载器展开为成员），提示语与删除一致："成员包经 suite 通道管理，请在设置页的 Suites 区操作"。
  - 在用守卫（`packInUse`）：被其他启用中的包 consumes 时，直接禁用会打断对方的链——提示消费者名单，要求 `force: true` 才写入数组，或建议保持启用。与删除不同的是**不做物理删除**，所以 force 的后果轻一档：包还在磁盘上，重新打开开关即恢复。
- **删除联动清理**：禁用名单的语义是"这些包不装载"，包都没了条目就成了死数据——删除流程（单包删除、suite 删除展开成员）在成功后把对应名字从 `disabledPacks` 移除，数组变更与删除同批提交。装载期对指向已不存在包的条目不报错（容忍竞态：手工删除目录、换工作区等），只在设置页渲染时静默跳过；不做装载期自动清洗，避免"换个工作区打开就动了全局配置"的意外写入。
- 设置界面的开关即对数组的读写：关一个 pack = 把名字写进数组，开 = 移除；suite 开关展开为成员名批量读写。数组变更走现有插件配置通道，需要重新 apply 才对装载生效（工作区层包不受影响，它动态装载时同样查数组）。

## 不做的事

- **运行时文件监听热重载**：重载通道已有（开关/市场安装），watch 带来的半装载状态与回执一致性成本大于收益。
- **packsDir 指向创作库整目录**（现状可配但不推荐）：市场安装会写进 git 仓库，创作与安装重新混用；层级方案落地后没有存在必要。

## 迁移清单（创作库落地时执行）

1. 建 `lab/docwright-packs` 仓库，op-demo-steps 源码迁入，`packs/<name>/` 布局，CI 跑 `pack:check`
2. suite 投稿表单（suites.json 的市场侧定义）随创作库管理
3. 工作区仓库 `.docwright/` 入 `.gitignore`：安装缓存已上移到 `$DSH_HOME/docwright/packs`；工作区的 `.docwright/packs/` 退化为创作调试位（软链或临时副本），不值得入库
4. 包投稿 dm-dev 审核通过后，各工作区改走市场安装；过渡期用软链（P1 后）或同步脚本
