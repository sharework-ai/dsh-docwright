import z from '@deepseek-ai/schemastery'

/** Single source of truth for tunable defaults (config.ts, not call sites). */
export const DEFAULT_MAX_ITERATIONS = 5
export const DEFAULT_PROMPT_TOKEN_BUDGET = 60_000
export const DEFAULT_MATERIALS_ROOT = 'references'
export const DEFAULT_OUTPUT_ROOT = 'output'
/** Convergence defaults (docs/designs/convergence-detection.md). */
export const DEFAULT_STAGNANT_ROUNDS = 3
export const DEFAULT_DECLINING_ROUNDS = 3
export const DEFAULT_MAX_REPEATS = 3
export const DEFAULT_EPSILON = 0
export const DEFAULT_SCORE_WEIGHTS = { error: 10, warning: 3, info: 1 } as const
/** Absolute round cap no override can pierce (docs/designs/dynamic-parameters.md). */
export const DEFAULT_MAX_ROUNDS_CEILING = 10

/** Upstream pack-version mismatch policy for chained generation. */
export type UpstreamVersionPolicy = 'strict' | 'warn'
export const DEFAULT_UPSTREAM_VERSION_POLICY: UpstreamVersionPolicy = 'strict'

/** Confirmation-gate policy: 'none' never gates (headless/CI), 'standard' gates on param changes or unconfirmed confirm-params, 'strict' gates every call with a param table to show (docs/designs/params-and-chain-contract.md). */
export type ConfirmPolicy = 'none' | 'standard' | 'strict'
export const DEFAULT_CONFIRM_POLICY: ConfirmPolicy = 'standard'

/** Convergence/oscillation tuning; every field optional, defaults above. */
export interface OscillationConfig {
  /** 'auto' (default): pack score if exported else built-in default score; 'score' forces the pack score; 'fingerprint' uses the loose fallback only. */
  mode?: 'auto' | 'score' | 'fingerprint'
  /** Terminate after this many consecutive rounds without beating the best score. */
  stagnantRounds?: number
  /** Terminate after this many consecutive strictly-decreasing rounds. */
  decliningRounds?: number
  /** Fingerprint fallback: terminate after this many consecutive identical fingerprints. */
  maxRepeats?: number
  /** Minimum improvement that counts as progress. */
  epsilon?: number
  /** Severity weights for the built-in default score. */
  defaultScore?: { error?: number; warning?: number; info?: number }
}

/** Plugin configuration, overridable from cordis.yml (no hardcoded tunables). */
export interface Config {
  /** Install directory: market install/update/delete write here; loads over the builtin packs/ (same-name wins). Defaults to $DSH_HOME/docwright/packs when unset (docs/designs/pack-load-dirs.md). */
  packsDir?: string
  /** One additional load root (profile-owned): authoring checkouts, scenario-specific dirs. Loads after packsDir, before the workspace tier (same-name wins). */
  extraPacksDir?: string
  /** Disabled pack names (a suite name expands to its members via the local suites.json record). Disabled packs do not load. */
  disabledPacks?: string[]
  /** Search parent directories of the workspace for .docwright/packs tiers (inner wins). Default false: it loads model-writable sources from above the opened workspace, an undeclared trust relaxation. */
  searchWorkspacePacksUpward?: boolean
  /** Cross-root same-name packs: 'allow' (default) shadows with records, 'error' fails loud at load. */
  packShadowPolicy?: 'allow' | 'error'
  /** Pack market base URL the params UI checks pack updates against (default: https://dm.shrwk.com). */
  marketUrl?: string
  /** Register the doc_market_search tool and advertise it in the discovery prompts (default: true). False removes the market-search discovery channel entirely. */
  marketSearch?: boolean
  /** Load the plugin package's own packs/ directory (default: true). Set false for market-only deployments so a source checkout's packs/ does not shadow packsDir installs. */
  loadBuiltinPacks?: boolean
  /** Workspace root when no session workspace drives the call (default: cwd). */
  workspaceRoot?: string
  /** Root material references resolve against (default: <workspace>/references). */
  materialsRoot?: string
  /** Root artifacts are written to (default: <workspace>/output). */
  outputRoot?: string
  /** Default language; falls back to the first pack's first language when unset. */
  defaultLanguage?: string
  /** Repair-loop round cap. */
  maxIterations?: number
  /** Rough token budget for one repair prompt; oversized artifacts fail loud. */
  promptTokenBudget?: number
  /** Chained upstream pack-version mismatch: 'strict' rejects stale upstreams, 'warn' proceeds and surfaces upstreamWarnings (default strict). */
  upstreamVersionPolicy?: UpstreamVersionPolicy
  /** Confirmation-gate policy: 'none' never gates (headless/CI; required params still fail loud), 'standard' gates on param changes or unconfirmed confirm-params (default), 'strict' gates every call that has a param table to show. Per-call tool arg overrides this. */
  confirmPolicy?: ConfirmPolicy
  /** Repair-loop convergence tuning (termination is early-exit only; green stays 0 errors). */
  oscillation?: OscillationConfig
  /** Absolute round cap for doc_generate; tool args and pack defaults clamp to it (hard ceiling, host-operator owned). */
  maxRoundsCeiling?: number
  /** Provider/model route for the LLM seam; required at first generate call. */
  provider?: string
  model?: string
}

/**
 * Bilingual schema description (schemastery meta `description: string |
 * Dict<string>`): the single home of Config copy — the params UI resolves
 * the locale browser-side; no other surface hardcodes copy about a key.
 */
const bi = (en: string, zh: string): { en: string; zh: string } => ({ en, zh })

export const Config: z<Config> = z.object({
  packsDir: z.string().extra('description', bi('Install directory: market install/update/delete write here and it loads over the builtin packs/ (same-name wins). Defaults to $DSH_HOME/docwright/packs when unset', '安装目录：市场安装/更新/删除写在这里，装载时覆盖内置 packs/（同名者胜）。未设置时默认 $DSH_HOME/docwright/packs')),
  extraPacksDir: z.string().extra('description', bi('One additional load root after the install dir (authoring checkouts, scenario dirs; same-name wins)', '安装目录之外的另一个装载根（创作库挂载、场景目录；同名者胜）')),
  disabledPacks: z.array(z.string()).extra('description', bi('Disabled pack names (a suite name expands to its members); disabled packs do not load', '禁用的 pack 名单（suite 名会展开为成员）；禁用的 pack 不装载')),
  searchWorkspacePacksUpward: z.boolean().extra('description', bi('Search parent directories of the workspace for .docwright/packs tiers, inner wins (default: off — parent dirs are an undeclared trust relaxation)', '向工作区的上级目录搜索 .docwright/packs 层，内层胜出（默认：关闭——上级目录属于未声明的信任放宽）')),
  packShadowPolicy: z.union(['allow', 'error']).extra('description', bi('Cross-root same-name packs: allow shadows with records (default), error fails loud at load', '跨根同名 pack：allow 遮蔽并记录（默认），error 在装载期响亮报错')),
  marketUrl: z.string().extra('description', bi('Pack market base URL the params UI checks pack updates against (default: https://dm.shrwk.com)', '参数界面检查 pack 更新所用的市场地址（默认：https://dm.shrwk.com）')),
  marketSearch: z.boolean().default(true).extra('description', bi('Register the doc_market_search tool and advertise market lookup in the discovery prompts when no installed pack fits (default: true)', '注册 doc_market_search 工具，并在已装 pack 无一契合时提示去市场查找（默认：开启）')),
  loadBuiltinPacks: z.boolean().default(true).extra('description', bi('Load the plugin package\'s own packs/ directory (default: true). Set false for market-only deployments so a source checkout\'s packs/ does not shadow packsDir installs', '加载插件包自带的 packs/ 目录（默认：开启）。纯市场部署设为 false，避免源码 checkout 里的 packs/ 遮盖 packsDir 安装的副本')),
  workspaceRoot: z.string().extra('description', bi('Workspace root when no session workspace drives the call (default: the process cwd)', '调用无会话工作区时使用的工作区根（默认：进程 cwd）')),
  materialsRoot: z.string().extra('description', bi('Root material references resolve against (default: <workspace>/references)', '素材引用的解析根目录（默认：<workspace>/references）')),
  outputRoot: z.string().extra('description', bi('Root artifacts are written to (default: <workspace>/output)', '产物写入根目录（默认：<workspace>/output）')),
  defaultLanguage: z.string().extra('description', bi('Default output language; falls back to the first pack\'s first language when unset', '默认输出语言；未设置时回退到首个 pack 的首个语言')),
  maxIterations: z.number().default(DEFAULT_MAX_ITERATIONS).extra('description', bi('Repair-loop round cap for doc_generate (tool args and pack defaults clamp to maxRoundsCeiling)', 'doc_generate 修复循环的轮数上限（工具入参与 pack 缺省都被 maxRoundsCeiling 钳制）')),
  promptTokenBudget: z.number().default(DEFAULT_PROMPT_TOKEN_BUDGET).extra('description', bi('Rough token budget for one repair prompt; oversized materials fail loud', '单次修复 prompt 的粗略 token 预算；超长素材直接报错')),
  upstreamVersionPolicy: z.union(['strict', 'warn']).default(DEFAULT_UPSTREAM_VERSION_POLICY).extra('description', bi('Chained upstream pack-version mismatch: strict rejects stale upstreams, warn proceeds and surfaces upstreamWarnings', '链式上游 pack 版本不一致：strict 拒绝过期上游，warn 继续并在 upstreamWarnings 提示')),
  confirmPolicy: z.union(['none', 'standard', 'strict']).default(DEFAULT_CONFIRM_POLICY).extra('description', bi('Confirmation policy: none never asks (headless/CI; required params still fail loud), standard asks for confirmation when params change or confirm-params are unconfirmed, strict asks on every call that has a param table; per-call tool arg overrides this', '确认策略：none 无需确认（headless/CI；required 参数仍会报错），standard 在参数变化或有未确认参数时要求用户确认，strict 每次调用都先让用户确认参数表；调用级工具入参可覆盖')),
  oscillation: z.object({
    mode: z.union(['auto', 'score', 'fingerprint']).default('auto').extra('description', bi('auto (default): pack score if exported else the built-in default score; score forces the pack score; fingerprint uses the loose fallback only', 'auto（默认）：pack 导出了 score 就用 pack score，否则用内置默认评分；score 强制用 pack score；fingerprint 只用宽松兜底')),
    stagnantRounds: z.number().default(DEFAULT_STAGNANT_ROUNDS).extra('description', bi('Terminate after this many consecutive rounds without beating the best score', '连续这么多轮未超过最佳评分即终止')),
    decliningRounds: z.number().default(DEFAULT_DECLINING_ROUNDS).extra('description', bi('Terminate after this many consecutive strictly-decreasing rounds', '连续这么多轮评分严格下降即终止')),
    maxRepeats: z.number().default(DEFAULT_MAX_REPEATS).extra('description', bi('Terminate after this many consecutive identical fingerprints', '连续这么多轮指纹完全相同即终止')),
    epsilon: z.number().default(DEFAULT_EPSILON).extra('description', bi('Minimum improvement that counts as progress', '算作有进展的最小提升量')),
    defaultScore: z.object({
      error: z.number().default(DEFAULT_SCORE_WEIGHTS.error).extra('description', bi('Severity weight for the built-in default score', '内置默认评分中该严重度的权重')),
      warning: z.number().default(DEFAULT_SCORE_WEIGHTS.warning).extra('description', bi('Severity weight for the built-in default score', '内置默认评分中该严重度的权重')),
      info: z.number().default(DEFAULT_SCORE_WEIGHTS.info).extra('description', bi('Severity weight for the built-in default score', '内置默认评分中该严重度的权重')),
    }).extra('description', bi('Severity weights for the built-in default convergence score', '内置默认收敛评分的严重度权重')),
  }).extra('description', bi('Repair-loop convergence tuning (termination is early-exit only; green stays 0 errors)', '修复循环收敛调参（只影响提前终止；green 仍是 0 error）')),
  maxRoundsCeiling: z.number().default(DEFAULT_MAX_ROUNDS_CEILING).extra('description', bi('Absolute round cap for doc_generate; tool args and pack defaults clamp to it (hard ceiling, host-operator owned)', 'doc_generate 的绝对轮数上限；工具入参与 pack 缺省都被它钳制（硬上限，宿主运维所有）')),
  provider: z.string().extra('description', bi('Provider route name in the host LLM composition (e.g. deepseek-official); required at the first generate call', '宿主 LLM 组合中的 provider 路由名（如 deepseek-official）；首次生成调用前必须配置')),
  model: z.string().extra('description', bi('Model name for the LLM seam; required at the first generate call', 'LLM 接缝的模型名；首次生成调用前必须配置')),
})
