# Docwright 文档生成插件

pack 定义一种文档类型（JSON Schema + 校验规则 + 生成提示），pack 可链成多阶段场景；生成参数经用户确认后才开始生成，每份文档附带可复验的校验回执。完整说明见 npm 或 GitHub 上的 README。

- **参数维护**：本页下方的"Docwright 参数"卡片，或 设置 → Docwright 参数。
- **pack 市场**：插件页的"Docwright 市场"标签页（地址由部署配置 `marketUrl` 决定，默认 [dm.shrwk.com](https://dm.shrwk.com/)）。
- **自定义 pack**：`cordis.yml` 的 `config.docwright.packsDir`（惯例 `<workspace>/.docwright/packs/`），同名 pack 覆盖内置。
