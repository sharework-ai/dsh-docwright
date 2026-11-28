# Pack / Suite 数据契约（三端一致）

pack 和 suite 的数据结构被三个代码库共享，**任何字段变更必须三端同步**，本文是字段的唯一事实源：

| 端 | 仓库 | 位置 |
|---|---|---|
| 插件（类型 + 装载校验） | `~/projects/lab/docwright` | `src/pack.ts`（PackManifest/Pack）、`src/pack-loader.ts`（assertManifest）、`src/pack-manage.ts`（市场 API 响应类型）、`src/market-search.ts`（搜索卡片）、`src/client/api.ts`（UI 类型） |
| 市场后端（存储 + HTTP） | `~/projects/lab/dsh-docwright-market` | `server-rs/src/api/{packs,suites,submissions,owner,admin}.rs`、`supabase/migrations/` |
| 市场前端（浏览 + 投稿） | 同上 | `web/assets/app.js`、`web/*.html` |

## 术语（三端统一用词）

| 概念 | 字段 | 说明 |
|---|---|---|
| **code** | `name` | 英文机器标识（小写 kebab-case）。字段名保留 `name`：它是 docwright 全链路的身份（目录名、`consumes`、产物命名、packsDir、suites.json），改名无收益且破坏兼容。文档与 UI 里称它为 code。 |
| **title** | `title` | 多语言显示标题（`{en, zh}`，可选）。市场标题显示它，缺省回落 `name`。pack 与 suite 都有。 |
| **description** | `description` | 多语言描述（`{en, zh}`，en 必填）。 |
| **全限定名** | — | `<org>/<name>@<version>`；org 来自投稿账号，不在 manifest 里。 |

UI 文案、市场 JSON、文档一律用这组词：不要混用 "name/标题/名字"，不要新增 `title` 以外的别名。

## Pack manifest（manifest.json）

装载期必填（`assertManifest` 校验，缺失即 fail loud）：`name`、`version`、`description`（双语，en 必有）、`languages`（非空数组）、`consumes`（数组，可为空）。可选插件语义键：`scope`、`reuse`、`fanout`、`maxRounds`、`paramDriftPolicy`、`materialsRoot`、`requiresTopic`、`artifactPrefix`、`params`。

**市场元数据（可选，loader 忽略额外键，市场投稿页读到即锁定）**：

- `author: string` — 作者显示名
- `tags: string[]` — 领域标签数组（v2 起；v1 的单选 `category` 已废弃）。白名单（服务端 `TAG_WHITELIST`，投稿/编辑/套件三入口共用）：`general`、`business`、`it`、`finance`、`education`、`entertainment`、`media`、`healthcare`、`legal`、`engineering`、`other`。至少一个。
- `license: string` — SPDX（`MIT`、`Apache-2.0`、`BSD-3-Clause`、`BSD-2-Clause`、`ISC`）
- `homepage: string` — http(s) URL
- `title: { en: string, zh?: string }` — 多语言标题（可选）
- `suite: string` — 所属套件，**写全限定名 `org/suite-code`**（作者只写 code 时，市场在发布时用 pack 自己的 org 补全；装载期只校验 code 形状）。市场在**套件发布时统一物化**：成员全部置为 `org/套件code`，`suite` 仍指向本套件但已不在成员名单的 pack 清空。套件行自带 `org` 字段（发布者组织，发布时从账号组织取），因此 `/api/suites` 与 pack 详情都能给出全限定身份。
- `assets: { icon?: string, images?: string[] }` — 展示资产（可选）。路径相对 pack 根目录，按约定放在 `assets/` 下；装载期校验形状（不得以 `/` 开头、不得含 `..`）。资产**仍随包 tgz 分发**：市场页面在浏览器里解 tgz 取图，服务端不存资产副本。
- `compatibleFrom: string` — **向后兼容下限**（插件语义键，可选）：本版本保证与自身版本不低于该值的消费方兼容。市场在投稿时从 manifest 提取进 packs 表，并随 `/api/index`、`/api/packs` 下发；插件在更新（单包与套件两条通道）时用它做兼容门槛——已安装消费方低于下限时第一次更新拒绝并列出受影响的消费方，用户确认（force）后才执行。字段缺失（老市场/老 manifest）即视为无限兼容、不做检查。

市场的 `org` 不在 manifest——来自投稿账号的发布者组织。卡片全限定名 `org/name@version`（suite 同理）。

## Suite 投稿（POST/PATCH /api/my/suites）

纯元数据表单：`name`（kebab-case）、`version`、`description`（双语，en 必填）、**`tags: string[]`**（白名单内、至少一个）、`members: string[]`（已发布的 pack 名，去重非空）。套件没有压缩包。

## 部署顺序与迁移追踪

市场部署必须**先跑数据库迁移、再滚动新镜像**（新镜像先起、DDL 后到会出现 500 窗口）。`deploy/deploy.sh` 与 `deploy/deploy-dev.sh` 都走 `<schema>.schema_migrations` 追踪表：按文件名顺序应用未记录的迁移，应用后写记录；重复执行是安全的 no-op。生产是 `public` schema，开发是 `market_dev` schema（`PGOPTIONS=-c search_path=market_dev`）；`0000_auth_stub.sql` 在真 supabase 上跳过。

## 兼容性纪律

- 插件读市场 API 必须**防御式读取**：新字段缺失时按旧形状降级（见 `tagsOf` 的 category 单串回退），旧市场不能打崩新插件。
- 服务端改字段必须出迁移（`supabase/migrations/`），生产手工执行、dev 由 `deploy-dev.sh` 循环执行，两库都要跑。
- 改本文任何字段：docwright（类型+校验+测试）、server-rs（结构+SQL+测试）、web（页面+文案+fixture）、本文，**四处一起改，缺一处就是 bug**（历史教训：category→tags、软件研发→it 两轮都有静默漏改，以及一次「镜像先行、迁移后跑」的 500 窗口）。
