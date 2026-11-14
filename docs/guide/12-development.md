# 第 12 章 开发与测试

docwright 不是一个独立构建的包：它通过 `link:` 依赖旁边检出的 deepseek-harness 仓库，很多类型与测试设施直接来自宿主源码。开发机需要同时检出两个仓库，目录为兄弟关系（`docwright/` 与 `deepseek-harness/` 并排）。

## 环境准备

`devDependencies` 里的 `@deepseek-ai/dsh-*` 包以 `link:` 指向 `../deepseek-harness/` 下的源码目录（裸符号链接；用 `file:` 会让 pnpm 试图解析 dsh 内部的 `workspace:*` 依赖，那些只在 dsh 自己的 workspace 里能解析）。这些 link 包的 exports 指向各自的 `lib/` 构建产物，所以宿主要先构建一次：

```sh
# 在 ../deepseek-harness 下，一次性
corepack pnpm install && corepack pnpm run build:lib:host

# 在 docwright 下
corepack pnpm install
```

`pnpm-workspace.yaml` 的 overrides 把 `cordis`/`cosmokit`/`schemastery` 对齐到 dsh 的 vendored 版本，保证一个进程里每个包只加载一份实例。这些依赖对运行时使用者是 peerDependencies，由宿主 dsh 安装解析，不会装进插件消费者。

## 常用命令

```sh
corepack pnpm test            # vitest；覆盖率门槛 100% lines/functions/statements
corepack pnpm run build       # tsc + tsdown
corepack pnpm run smoke:host  # 发布前冒烟：打 tarball → 真实 dsh 宿主启动 → 工具断言，无模型调用
corepack pnpm run pack:check -- packs   # 包健康检查（第 9 章）
```

**测试与覆盖率门**：vitest 运行全部单元与闭环测试，覆盖率配置把 lines、functions、statements 全部钉在 100%。测试描述行为而不是实现正确性，模型可见的行为变更配快照（keyless snapshot）。包的变异测试（每条规则至少一种故意损坏样本必须被抓）内建在 cosmic 系列的 spec 里。

**宿主冒烟**：`scripts/host-smoke.ts` 把插件打成 tarball，在临时 DSH_HOME 里建一个 headless profile 并 `dsh plugin add`，进程内启动这个 profile，断言四个工具（doc_generate、doc_validate、doc_packs、doc_chain_status）和两个技能（authoring、install）都已注册，全程无 API key。发布前必跑，验证"打包出来的插件在真实宿主里能加载"。

## 真实模型 e2e

闭环在真实 LLM 上的行为（确认门、预算带、扇出寻址、自动命名、覆盖对账）由 `scripts/e2e-real-llm.ts` 覆盖，需要真实 API key（环境变量注入，key 不入仓）。运行手册在 `docs/testing/e2e-real-llm.md`：构建并 pack 插件 tarball、沙箱化一个临时 DSH_HOME 和 profile、写最小 boot 补丁（模型路由）、然后启动真实宿主跑多轮生成断言。手册里记录了踩过的坑（`--profile` 的位置、同版本 tarball 重复 add 不刷新、跨 cwd 运行 dsh 源码需要 `TSX_TSCONFIG_PATH` 等），复现前先通读。

## 限制与已知取舍

- **回执防篡改，不防伪造**。回执绑定产物内容 hash，意外改动能被发现（复验 hash 不匹配即红）；但没有签名，刻意攻击者可以同时伪造产物和回执。信任模型是"防手滑，不防恶意"。
- **素材是可信输入**。素材文本会进入生成 prompt，恶意素材可以引导生成结果。这一信任边界在评审时已明确接受，分隔符加固是后续可选项。
- **修复循环的可观测性住在回执里**。每轮的 issue 计数与 prompt hash 都记录在回执并随工具返回值原样进入会话日志；没有独立的会话事件类型（dsh 目前没有让插件标记事件可忽略的写侧机制）。
- **包装载是 apply 期动作**。写完包文件必须重载插件才可见，没有会话内热加载（见第 9 章）。
- **pack authoring 不会为规则再造一层 meta 校验器**。装载期校验就是规则的 linter，`pack:check` 与它同源；双重校验实现只会漂移。
