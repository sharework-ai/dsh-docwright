/** UI copy, zh + en. Pack/param descriptions are author content and render verbatim; only chrome lives here. */

export type Translate = (key: string) => string

export const en = {
  nav: 'Docwright params',
  title: 'Docwright parameters',
  marketTitle: 'Docwright pack market',
  openExternal: 'Open in new window ↗',
  intro: 'Maintains the parameter values defined in the plugin and the packs. Parameters obtained during the conversation, from materials or user input, are not managed here.',
  viewGroups: 'Parameters',
  viewPacks: 'Packs',
  viewConfig: 'Plugin settings',
  loading: 'Loading parameters…',
  loadFailed: 'Could not load the parameters.',
  retry: 'Retry',
  empty: 'No parameters with declared defaults.',
  sources: 'effective source',
  scopeWorkspace: 'workspace',
  scopeTopic: 'topic',
  originBuiltin: 'built-in',
  originPacksDir: 'packsDir: {root}',
  consumed: 'upstream',
  driftPolicy: 'param drift',
  min: 'min',
  max: 'max',
  choices: 'choices',
  extractable: 'extractable from materials',
  overridable: 'adjustable by materials',
  edit: 'Edit',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved. Future generations use the new value; existing artifacts are unchanged.',
  saveConfig: 'Save settings',
  configHint: 'Changes apply immediately and survive restarts. provider and model only affect future generations.',
  inherited: 'default',
  configured: 'configured',
  unset: 'not set',
  invalidJson: 'Not valid JSON.',
  rangeTemplate: 'Must be between {min} and {max}.',
  invalidNumber: 'Not a valid number.',
  advanced: 'Advanced',
  bandValue: 'target {value}, tolerance band {min}-{max}',
  factorValue: 'target {value}, tolerance x{down}-x{up}',
  shadowedNote: 'Also declared in {packs}. The source declaration governs; details in the Packs view.',
  shadowedByNote: 'managed by {pack}, not effective here',
  // Pack lane (packsDir management): version standing + update/delete actions.
  updateCheckFailed: 'Could not reach the pack market; showing local state only.',
  upToDate: 'up to date',
  updateTo: 'update to v{version}',
  notOnMarket: 'not on the market',
  updateBtn: 'Update',
  confirmUpdate: 'Confirm update (overwrites local changes)',
  deleteBtn: 'Delete',
  confirmDelete: 'Confirm delete',
  confirmDeleteBreaks: 'Confirm delete ({packs} consume it — their chains break)',
  updatedDone: 'Updated to v{version}.',
  deletedDone: 'Deleted.',
  // Server error codes (src/coded-error.ts): what happened / why / what to do.
  'err.gateRejected': 'The request was rejected by the host (HTTP {status}): not logged in, or the origin check failed. Refresh the page and sign in again.',
  'err.crossSiteWrite': 'Write refused: the request origin does not match the deployment host (cross-site request). Operate from the dsh web UI.',
  'err.bodyTooLarge': 'The request body exceeds the {max}-byte limit; nothing was written. Reduce the request size.',
  'err.invalidJsonBody': 'The request body is not valid JSON; nothing was written.',
  'err.invalidPatchBody': 'Malformed request: expected {"patch": {...}} (an object of Config keys); nothing was written.',
  'err.invalidParamBody': 'Malformed request: non-empty pack and param names are required; nothing was written.',
  'err.valueRequired': 'Missing value (the new default). The UI edits defaults; it does not remove them.',
  'err.noProfileEntry': 'The host config editor lists no profile entry for docwright; the save was refused. Configure docwright via cordis.yml or the profile patch.',
  'err.unknownPack': 'Unknown pack "{pack}". Available: {available}. Nothing was written.',
  'err.paramNotEditable': 'Pack "{pack}" param {param} declares no default, and the UI maintains declared defaults only. Structural changes are a pack-author manifest edit with a version bump. Nothing was written.',
  'err.manifestCorrupt': 'The pack "{pack}" manifest.json is not valid JSON; nothing was written. Fix the file first.',
  'err.paramVanished': 'params.{param} no longer exists in the manifest (the file may have been edited concurrently); nothing was written. Refresh and retry.',
  'err.manifestInvalid': 'The edited manifest failed the load-time validation; nothing was written. See the detail below.',
  'err.reloadFailed': 'The manifest was written, but reloading the packs failed. Fix or revert {path}; until the reload succeeds the running tools keep the previous configuration.',
  'err.patternParamInvalid': 'The new value for {param} is not a valid regex (it drives a validation rule); nothing was written. Fix the expression, or set the empty string to disable the check.',
  // Pack lane error codes (src/pack-manage.ts).
  'err.packNotManaged': 'Pack "{pack}" is not managed here: builtin packs ship with the plugin package, managed packs live under the packsDir. Nothing was written.',
  'err.marketUnreachable': 'Could not reach the pack market; nothing was written. Retry later, or point marketUrl in cordis.yml at a reachable market.',
  'err.integrityFailed': 'Integrity check failed for "{pack}" ({why}); nothing was written. Never force-install when the market index and the download disagree.',
  'err.updateFailed': 'Pack "{pack}" update failed; the installed version is unchanged.',
  'err.absentFromMarket': 'Pack "{pack}" is not listed on the market at {url}, so there is nothing to update from; nothing was written. Publish it there first, or install it into the packsDir directly.',
}

export const zh: Record<string, string> = {
  nav: 'Docwright 参数',
  title: 'Docwright 参数',
  marketTitle: 'Docwright pack 市场',
  openExternal: '在新窗口打开 ↗',
  intro: '此处维护插件和包中定义的参数值，不包括那些在会话中从素材或用户输入中获得的参数。',
  viewGroups: '参数',
  viewPacks: '包',
  viewConfig: '插件设置',
  loading: '正在载入参数…',
  loadFailed: '参数载入失败。',
  retry: '重试',
  empty: '没有声明默认值的参数。',
  sources: '生效源',
  scopeWorkspace: '工作区级',
  scopeTopic: '话题级',
  originBuiltin: '内置',
  originPacksDir: '自定义目录：{root}',
  consumed: '上游',
  driftPolicy: '参数漂移',
  min: '下限',
  max: '上限',
  choices: '可选项',
  extractable: '可从素材抽取',
  overridable: '可被素材调整',
  edit: '编辑',
  cancel: '取消',
  save: '保存',
  saving: '保存中…',
  saved: '已保存。之后的生成使用新值，已有产物不变。',
  saveConfig: '保存设置',
  configHint: '改动即时生效，重启后仍保留。provider 和 model 只影响之后的生成，不影响已有产物。',
  inherited: '默认',
  configured: '已配置',
  unset: '未设置',
  invalidJson: '不是合法 JSON。',
  rangeTemplate: '必须在 {min} 到 {max} 之间。',
  invalidNumber: '不是合法数字。',
  advanced: '高级',
  bandValue: '目标 {value}（容差带 {min}–{max}）',
  factorValue: '目标 {value}（容差 ×{down}–×{up}）',
  shadowedNote: '同名参数还声明于：{packs}（以生效源为准，详见包视图）。',
  shadowedByNote: '由 {pack} 管理，此处声明不生效',
  // pack 管理（packsDir）：版本对比 + 更新/删除操作。
  updateCheckFailed: '无法连接 pack 市场，仅显示本地状态。',
  upToDate: '已是最新',
  updateTo: '可更新到 v{version}',
  notOnMarket: '市场未收录',
  updateBtn: '更新',
  confirmUpdate: '确认更新（将覆盖本地改动）',
  deleteBtn: '删除',
  confirmDelete: '确认删除',
  confirmDeleteBreaks: '确认删除（{packs} 消费它，删除将断链）',
  updatedDone: '已更新到 v{version}。',
  deletedDone: '已删除。',
  // 服务端错误码（src/coded-error.ts）：发生了什么 / 为什么 / 怎么办。
  'err.gateRejected': '请求被宿主拒绝（HTTP {status}）：未登录或来源校验未通过。刷新页面重新登录后再试。',
  'err.crossSiteWrite': '写入被拒绝：请求来源与部署主机不一致（跨站请求）。请从 dsh web 界面发起操作。',
  'err.bodyTooLarge': '请求体超过 {max} 字节上限，未写入任何内容。请缩小请求内容。',
  'err.invalidJsonBody': '请求体不是合法 JSON，未写入任何内容。',
  'err.invalidPatchBody': '请求格式错误：应为 {"patch": {...}}（Config 键的对象），未写入任何内容。',
  'err.invalidParamBody': '请求格式错误：需要非空的 pack 与 param 名称，未写入任何内容。',
  'err.valueRequired': '缺少 value（新的默认值）。界面只支持修改默认值，不支持删除。',
  'err.noProfileEntry': '宿主配置编辑器没有列出 docwright 的 profile entry，无法保存。请通过 cordis.yml 或 profile patch 配置 docwright。',
  'err.unknownPack': '找不到 pack「{pack}」。可用：{available}。未写入任何内容。',
  'err.paramNotEditable': 'pack「{pack}」的参数 {param} 没有声明默认值，界面只维护已声明的默认值。结构性改动请由 pack 作者编辑 manifest 并升版。未写入任何内容。',
  'err.manifestCorrupt': 'pack「{pack}」的 manifest.json 不是合法 JSON，未写入任何内容。请先修复该文件。',
  'err.paramVanished': 'manifest 中已不存在参数 {param}（文件可能被同时编辑过），未写入任何内容。请刷新后重试。',
  'err.manifestInvalid': '修改后的 manifest 未通过装载期校验，未写入任何内容。请按下方详情修正。',
  'err.reloadFailed': 'manifest 已写入，但重新装载 pack 失败。请修复或还原 {path}；装载成功之前，运行中的工具仍使用旧配置。',
  'err.patternParamInvalid': '参数 {param} 的新值不是合法正则表达式（它驱动一条校验规则），未写入任何内容。请修正表达式，或置空字符串以停用该检查。',
  // Pack lane error codes (src/pack-manage.ts).
  'err.packNotManaged': 'pack「{pack}」不在此处管理范围：内置 pack 随插件发行，可管理的 pack 在 packsDir 目录下。未写入任何内容。',
  'err.marketUnreachable': '无法连接 pack 市场，未做任何改动。可稍后重试，或在 cordis.yml 用 marketUrl 指向可达的市场。',
  'err.integrityFailed': '「{pack}」完整性校验失败（{why}），未写入任何内容。市场索引与下载内容不一致时请勿强行安装。',
  'err.updateFailed': 'pack「{pack}」更新失败，已装版本未变。',
  'err.absentFromMarket': 'pack「{pack}」不在市场 {url} 的收录中，没有可更新的来源，未写入任何内容。先在市场投稿该 pack，或直接把 pack 放进 packsDir。',
}

export function translate(dict: Record<string, unknown>): Translate {
  return (key: string) => {
    const value = dict[key]
    return typeof value === 'string' ? value : key
  }
}

/** Fill a {key}-templated locale string. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`))
}

/** A save/load failure as the UI renders it: the localized catalog entry for
 * known codes, the raw server sentence otherwise, plus the raw detail line. */
export function renderError(error: { message: string; code?: string; params?: Readonly<Record<string, string | number>>; detail?: string }, lang: 'zh' | 'en'): { text: string; detail?: string } {
  const dict: Record<string, string | undefined> = lang === 'zh' ? zh : en
  const template = error.code === undefined ? undefined : dict[`err.${error.code}`]
  const text = typeof template === 'string' ? fill(template, { ...(error.params ?? {}) }) : error.message
  return { text, ...(error.detail === undefined ? {} : { detail: error.detail }) }
}
