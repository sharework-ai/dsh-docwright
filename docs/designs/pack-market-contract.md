# Pack / Suite 数据契约（三端一致）

pack 和 suite 的数据结构被三个代码库共享，**任何字段变更必须三端同步**，本文是字段的唯一事实源：

| 端 | 仓库 | 位置 |
|---|---|---|
| 插件（类型 + 装载校验） | `~/projects/lab/docwright` | `src/pack.ts`（PackManifest/Pack）、`src/pack-loader.ts`（assertManifest）、`src/pack-manage.ts`（市场 API 响应类型）、`src/market-search.ts`（搜索卡片）、`src/client/api.ts`（UI 类型） |
| 市场后端（存储 + HTTP） | `~/projects/lab/dsh-docwright-market` | `server-rs/src/api/{packs,suites,submissions,owner,admin}.rs`、`supabase/migrations/` |
| 市场前端（浏览 + 投稿） | 同上 | `web/assets/app.js`、`web/*.html` |

## Pack manifest（manifest.json）

装载期必填（`assertManifest` 校验，缺失即 fail loud）：`name`、`version`、`description`（双语，en 必有）、`languages`（非空数组）、`consumes`（数组，可为空）。可选插件语义键：`scope`、`reuse`、`fanout`、`maxRounds`、`paramDriftPolicy`、`materialsRoot`、`requiresTopic`、`artifactPrefix`、`params`。

**市场元数据（可选，loader 忽略额外键，市场投稿页读到即锁定）**：

- `author: string` — 作者显示名
- `tags: string[]` — 领域标签数组（v2 起；v1 的单选 `category` 已废弃）。白名单（服务端 `TAG_WHITELIST`，投稿/编辑/套件三入口共用）：`general`、`business`、`it`、`finance`、`education`、`entertainment`、`media`、`healthcare`、`legal`、`engineering`、`other`。至少一个。
- `license: string` — SPDX（`MIT`、`Apache-2.0`、`BSD-3-Clause`、`BSD-2-Clause`、`ISC`）
- `homepage: string` — http(s) URL

市场的 `org` 不在 manifest——来自投稿账号的发布者组织。卡片全限定名 `org/name@version`（suite 同理）。

## Suite 投稿（POST/PATCH /api/my/suites）

纯元数据表单：`name`（kebab-case）、`version`、`description`（双语，en 必填）、**`tags: string[]`**（白名单内、至少一个）、`members: string[]`（已发布的 pack 名，去重非空）。套件没有压缩包。

## 兼容性纪律

- 插件读市场 API 必须**防御式读取**：新字段缺失时按旧形状降级（见 `tagsOf` 的 category 单串回退），旧市场不能打崩新插件。
- 服务端改字段必须出迁移（`supabase/migrations/`），生产手工执行、dev 由 `deploy-dev.sh` 循环执行，两库都要跑。
- 改本文任何字段：docwright（类型+校验+测试）、server-rs（结构+SQL+测试）、web（页面+文案+fixture）、本文，**四处一起改，缺一处就是 bug**（历史教训：category→tags、软件研发→it 两轮都有静默漏改）。
