// Function rules for the cosmic-context-sync pack (docs/designs/cosmic-context.md
// §6): the merged artifact must be a valid project context (the four
// context/* rules) AND a faithful merge of the topic plan's module changes
// (context-sync/coverage, context-sync/preserve — both read the upstream).
// Contract: export `rules`; each check(artifact, context) returns RuleIssue[]
// ({ jsonPath, message, snapshot? }); an empty array means pass.

function isObject(value) {
  return value !== null && typeof value === 'object'
}

/** Message selector: en-US only when the artifact itself says so. */
function say(artifact, zh, en) {
  return isObject(artifact) && artifact.language === 'en-US' ? en : zh
}

function modulesAt(artifact) {
  const doc = isObject(artifact) ? artifact : {}
  return Array.isArray(doc.modules) ? doc.modules : []
}

function childrenOf(node) {
  return isObject(node) && Array.isArray(node.children) ? node.children : []
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

/** Walk the three schema-expressible levels; visits { node, level, path }. */
function* walkModules(nodes, level = 1, base = '$.modules') {
  for (const [index, node] of (nodes ?? []).entries()) {
    const path = `${base}[${index}]`
    yield { node, level, path }
    if (level < 3) {
      yield* walkModules(childrenOf(node), level + 1, `${path}.children`)
    }
  }
}

/** Deepest level holding at least one node (0 for an empty tree). */
function actualDepth(nodes) {
  let depth = 0
  for (const { level } of walkModules(nodes)) depth = Math.max(depth, level)
  return depth
}

function hasModuleAtLevel(nodes, level) {
  for (const entry of walkModules(nodes)) {
    if (entry.level === level) return true
  }
  return false
}

/** All module codes of the tree (up to three levels). */
function collectCodes(nodes) {
  const codes = new Set()
  for (const { node } of walkModules(nodes)) {
    const code = str(isObject(node) ? node.code : undefined)
    if (code !== '') codes.add(code)
  }
  return codes
}

/** All module names of the tree (up to three levels). */
function collectNames(nodes) {
  const names = new Set()
  for (const { node } of walkModules(nodes)) {
    const name = str(isObject(node) ? node.name : undefined)
    if (name !== '') names.add(name)
  }
  return names
}

function planOf(upstream) {
  return (Array.isArray(upstream) ? upstream : []).find(item => isObject(item) && item.docType === 'plan')
}

function functionsOf(plan) {
  return isObject(plan) && Array.isArray(plan.functions) ? plan.functions : []
}

export const rules = [
  // ---- the four context rules: the merged artifact is a project context ----
  {
    id: 'context/module-code-unique',
    severity: 'error',
    suggestion: '模块 code 是模块的身份（plan 阶段 funcId 的段即模块 code 链）：调整重复编号使全树（三层）唯一。',
    check: (artifact) => {
      const seen = new Map()
      const issues = []
      for (const { node, level, path } of walkModules(modulesAt(artifact))) {
        const code = str(isObject(node) ? node.code : undefined)
        if (code === '') continue
        if (seen.has(code)) {
          issues.push({
            jsonPath: `${path}.code`,
            message: say(artifact,
              `模块 code 重复：${code} 在第 ${seen.get(code).level} 级（${seen.get(code).path}）与第 ${level} 级（${path}）都存在`,
              `Duplicate module code: ${code} exists both at level ${seen.get(code).level} (${seen.get(code).path}) and level ${level} (${path})`),
            snapshot: code,
          })
        } else {
          seen.set(code, { level, path })
        }
      }
      return issues
    },
  },
  {
    id: 'context/module-depth',
    severity: 'error',
    suggestion: '调整模块树使其实际最大层级深度等于生效参数 moduleLevels（1-3）：树少一级则继续细分，多一级则合并或提升 moduleLevels 参数。',
    check(artifact, context) {
      const levels = context?.params?.moduleLevels
      if (typeof levels !== 'number') return []
      const modules = modulesAt(artifact)
      const depth = actualDepth(modules)
      if (depth === levels) return []
      return [{
        jsonPath: '$.modules',
        message: say(artifact,
          `模块树实际最大深度 ${depth} 与生效参数 moduleLevels=${levels} 不一致`,
          `The module tree's actual maximum depth ${depth} does not match the effective param moduleLevels=${levels}`),
        snapshot: `depth=${depth}`,
      }]
    },
  },
  {
    id: 'context/module-id-convention',
    severity: 'error',
    suggestion: '树用到第 N 级（N ≤ moduleLevels）就必须声明 moduleIdConventionForLevelN（numeric 数字序号或 alphabetic 字母缩写）：新增模块编号在 plan 阶段依赖该规则。',
    check(artifact, context) {
      const levels = context?.params?.moduleLevels
      if (typeof levels !== 'number') return []
      const doc = isObject(artifact) ? artifact : {}
      const modules = modulesAt(artifact)
      const issues = []
      for (let level = 1; level <= Math.min(levels, 3); level++) {
        const key = `moduleIdConventionForLevel${level}`
        if (hasModuleAtLevel(modules, level) && doc[key] === undefined) {
          issues.push({
            jsonPath: `$.${key}`,
            message: say(artifact,
              `模块树用到第 ${level} 级但未声明 ${key}（numeric 或 alphabetic）`,
              `The module tree uses level ${level} but ${key} (numeric or alphabetic) is not declared`),
            snapshot: 'missing',
          })
        }
      }
      return issues
    },
  },
  {
    id: 'context/assumptions-review',
    severity: 'warning',
    suggestion: 'assumptions 中的条目为模型假定（素材未覆盖）：采纳前请人工审阅；修正产物后可用 doc_validate 的 seal 回签重新入链。',
    check: (artifact) => {
      const assumptions = isObject(artifact) ? artifact.assumptions : undefined
      if (!Array.isArray(assumptions) || assumptions.length === 0) return []
      return [{
        jsonPath: '$.assumptions',
        message: say(artifact,
          `以下 ${assumptions.length} 条为模型假定（素材未覆盖），采纳前请审阅；修正后可用 seal 回签重新入链`,
          `The following ${assumptions.length} items are model assumptions (not covered by the materials); review them before adopting; after corrections, re-seal via doc_validate`),
        snapshot: `${assumptions.length} item(s)`,
      }]
    },
  },
  // ---- the merge-fidelity rules: upstream-driven (docs/designs/cosmic-context.md §6) ----
  {
    // Every planned module change must land in the merged tree. v1 matches by
    // the plan function's deepest name; per-segment funcId↔code reconciliation
    // is a v2 item.
    id: 'context-sync/coverage',
    severity: 'error',
    suggestion: 'plan 中每个 added/modified 功能的最深层级名称都必须出现在合并后的模块树中：把漏掉的功能作为模块（新增按 moduleIdConventionForLevelN 编号）合并进对应层级。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const upstream = context?.upstream
      const plan = planOf(upstream)
      if (plan === undefined) {
        return [{
          jsonPath: '$',
          message: say(artifact,
            '找不到上游 plan 产物（docType="plan"）：同步必须以合格回执的旧 context 与本话题 plan 为 upstream',
            'Upstream plan artifact not found (docType="plan"): sync requires the green old context and the topic plan as upstream'),
        }]
      }
      const names = collectNames(modulesAt(artifact))
      const issues = []
      functionsOf(plan).forEach((fn, index) => {
        const changeKind = fn?.changeKind
        if (changeKind !== 'added' && changeKind !== 'modified') return
        const deepest = str(fn?.l3Name) !== '' ? str(fn?.l3Name) : str(fn?.l2Name) !== '' ? str(fn?.l2Name) : str(fn?.l1Name)
        if (deepest === '' || names.has(deepest)) return
        issues.push({
          jsonPath: `$.functions[${index}]`,
          message: say(artifact,
            `plan 功能 "${deepest}"（${changeKind}）未合并进模块树：最深层级名称必须出现在合并产物的模块 name 集中`,
            `Plan function "${deepest}" (${changeKind}) is not merged into the module tree: its deepest-level name must appear in the merged artifact's module names`),
          snapshot: deepest,
        })
      })
      return issues
    },
  },
  {
    // A merge that drops pre-existing modules is suspicious: either the model
    // lost content (fix) or the module truly retired (human seals the edit).
    id: 'context-sync/preserve',
    severity: 'warning',
    suggestion: '旧 context 的模块在合并产物中缺失：若为合并丢失请补回；确属模块下线场景请人工确认后用 seal 回签裁决',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const upstream = context?.upstream
      const old = (Array.isArray(upstream) ? upstream : []).find(item => isObject(item) && item.docType === 'context')
      if (old === undefined) {
        return [{
          jsonPath: '$',
          message: say(artifact,
            '找不到上游旧 context 产物（docType="context"）：同步必须以合格回执的旧 context 为 upstream 才能对账防丢失',
            'Upstream old context artifact not found (docType="context"): sync requires the green old context upstream to reconcile against losses'),
        }]
      }
      const merged = collectNames(modulesAt(artifact))
      const issues = []
      for (const { node, level } of walkModules(modulesAt(old))) {
        const name = str(isObject(node) ? node.name : undefined)
        if (name !== '' && !merged.has(name)) {
          issues.push({
            jsonPath: '$.modules',
            message: say(artifact,
              `旧 context 的第 ${level} 级模块 "${name}" 在合并产物中缺失（防合并丢失；确属下线请人工 seal 裁决）`,
              `The old context's level-${level} module "${name}" is missing from the merged artifact (merge-loss guard; if the module truly retired, let a human decide via seal)`),
            snapshot: name,
          })
        }
      }
      return issues
    },
  },
]
