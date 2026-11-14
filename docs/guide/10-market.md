# 第 10 章 市场发现与安装

pack 市场按关键词分发场景包和套件。安装产物落在部署配置的 `packsDir`，下载逐个做完整性校验，安装完成后包在本会话立即可用，无需重启。市场地址由部署配置的 `marketUrl` 决定（默认 `https://dm.shrwk.com`）；工具不内置任何市场地址，测试与生产市场共用同一套工具。

## 两个市场工具

**doc_market_search**：按关键词搜索市场。查询词由模型把用户意图拆成领域词加文档体裁（英文命中最好，如 "cosmic function point CFP"）；市场在名称、分类和双语描述上做关键词匹配，不做向量检索。返回包卡片（name、version、description、languages、consumes、suites、install 提示）和套件卡片（name、members、install 提示）。市场不可达时报错并给出市场地址，不编造目录内容。limit 参数默认 20，上限 50。

**doc_market_install**：安装一个包（`{ "pack": "<name>" }`）或一整套（`{ "suite": "<name>" }`）。不带 `confirm` 的首次调用只返回安装计划表：包安装列出该包及其 consumes 闭包里的全部上游包，套件安装列出全部成员包加上成员带入的上游；每行标明是请求目标还是被带入的上游、市场版本、来源市场和目标 `packsDir`，已就绪的成员标注跳过。用户确认后带 `confirm: true` 重调同一调用，安装执行：校验（sha256 + manifest 名 + 内容 hash）、按依赖顺序落盘、最后一次热重载。同名包按市场版本原地更新；中途失败保留已落盘部分，重试只补缺失成员。

## 三层发现顺序

会话内遇到文档需求时按顺序走三层：

1. **已安装包**：先调 `doc_packs` 看已装包能否覆盖。能覆盖就直接生成。
2. **市场查找**：没有包契合时，若部署开启 `marketSearch`（默认开），用 `doc_market_search` 按意图查找，命中则走 `doc_market_install` 安装。工具描述和未命中报错都会提示这一层。
3. **现场创作**：市场上也没有合适的包时，加载 `docwright-pack-authoring` 技能创作新包（第 9 章）。

三层都是拉式：工具描述只放静态邀请，包清单按需查询，不随包数量膨胀上下文。

## 套件：一次装一组

suite 是市场侧的一组命名包，例如 `cosmic` 套件收纳 COSMIC 场景的全部六个包。套件本身没有 tarball 和生成逻辑，只是成员名单；成员包仍然独立参与链路消费。

归属套件的成员包由套件管理：不能单独安装、更新或删除，单包通道会拒绝并指明所属套件。用户点名一个成员包时，搜索返回的是套件卡片而不是包卡片，按套件安装即可把整组连同上游一次装齐。成员带入的上游包仍是普通包，可以单独管理。市场不支持套件时单包通道照常工作。

`doc_packs` 永远先行：整套已装齐就直接使用，装了一部分就做补齐安装，确认表会标出跳过的成员。

## 确认门

`doc_market_install` 的确认门不可跳过：首次调用返回 `pendingConfirmation`，调用方必须把安装计划表转呈用户，用户批准后才能带 `confirm: true` 执行。模型不得代替用户确认。安装是配置变更，确认门保证写进 `packsDir` 的内容用户过目过。

## 配置入口

- `marketSearch`（默认 `true`）：关闭后 `doc_market_search` 不注册，发现链只剩 `doc_packs` 和创作技能两层。
- `marketUrl`（默认 `https://dm.shrwk.com`）：两个市场工具与参数界面的更新检查共用此地址。

## install.mjs

仓库根的 `install.mjs` 是市场服务端的旧版命令行安装器（`node install.mjs <pack> --index <marketUrl>/api/index`），不属于 dsh 插件，仅在会话工具不可用时兜底使用。会话内优先用 `doc_market_install`：同一套校验管线，外加确认门。
