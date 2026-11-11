// Cross-field rules for the cosmic-plan pack, migrated from
// cosmic-claude cosmic_core/auditors/plan_auditor.py (E204 funcId unique,
// E205 path unique, E200 family) plus the shared-budget rules
// plan/cfp-func-range, plan/cfp-avg-band and plan/cfp-total-band
// (docs/designs/params-and-chain-contract.md), the upstream-context
// reconciliation rule plan/context-alignment (by module NAME: a leaf
// module may carry several functions, so funcId no longer encodes module
// codes), the topicNo-numbering rule plan/func-id-numbering and the
// moduleLevels-driven plan/name-hierarchy (docs/designs/cosmic-context.md).
// Contract: export `rules`; each check(artifact) returns RuleIssue[]
// ({ jsonPath, message, snapshot? }); an empty array means pass.

function getFunctions(artifact) {
  const doc = typeof artifact === 'object' && artifact !== null ? artifact : {}
  return Array.isArray(doc.functions) ? doc.functions : []
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

/** Message selector: en-US only when the artifact itself says so. */
function say(artifact, zh, en) {
  return isObject(artifact) && artifact.language === 'en-US' ? en : zh
}

/** All module names of the upstream context tree (up to three levels). */
function contextModuleNames(contextArtifact) {
  const names = new Set()
  const walk = (nodes, level) => {
    if (!Array.isArray(nodes) || level > 3) return
    for (const node of nodes) {
      if (!isObject(node)) continue
      if (typeof node.name === 'string' && node.name !== '') names.add(node.name)
      walk(node.children, level + 1)
    }
  }
  walk(contextArtifact?.modules, 1)
  return names
}

/** Two-digit right-aligned ordinal: 01-99 zero-padded, 100+ unpadded. */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n)
}

export const rules = [
  {
    id: 'plan/func-id-unique',
    severity: 'error',
    suggestion: '重新编号使 funcId 唯一',
    check: (artifact) => {
      const functions = getFunctions(artifact)
      const seen = new Map()
      const issues = []
      functions.forEach((fn, index) => {
        const funcId = str(fn?.funcId)
        if (funcId === '') return
        if (seen.has(funcId)) {
          issues.push({
            jsonPath: `$.functions[${index}].funcId`,
            message: `功能ID重复：${funcId} 在功能 ${seen.get(funcId) + 1} 和 ${index + 1} 中都存在`,
            snapshot: funcId,
          })
        } else {
          seen.set(funcId, index)
        }
      })
      return issues
    },
  },
  {
    id: 'plan/l1-path-unique',
    severity: 'error',
    suggestion: '调整功能层级名称，使 l1Name/l2Name/l3Name 组合路径互不相同',
    check: (artifact) => {
      const functions = getFunctions(artifact)
      const seen = new Map()
      const issues = []
      functions.forEach((fn, index) => {
        const l1Name = str(fn?.l1Name)
        const l2Name = str(fn?.l2Name)
        const l3Name = str(fn?.l3Name)
        const hasL3 = l3Name !== ''
        const key = hasL3 ? `${l1Name}|${l2Name}|${l3Name}` : `${l1Name}|${l2Name}`
        const display = hasL3 ? `${l1Name} > ${l2Name} > ${l3Name}` : `${l1Name} > ${l2Name}`
        if (key === '|') return
        if (seen.has(key)) {
          issues.push({
            jsonPath: `$.functions[${index}].l1Name`,
            message: `功能路径重复：${display} 在功能 ${seen.get(key) + 1} 和 ${index + 1} 中都存在`,
            snapshot: display,
          })
        } else {
          seen.set(key, index)
        }
      })
      return issues
    },
  },
  {
    // Individual-range rule driven by the shared params cfpMin/cfpMax
    // {value, min, max}: a single function may sit anywhere inside
    // [cfpMin.value, cfpMax.value] — granularity is governed by the MEAN
    // (plan/cfp-avg-band), not by forcing uniform sizes. Skips when params
    // are absent (programmatic misuse); required chain-head params
    // guarantee presence.
    id: 'plan/cfp-func-range',
    severity: 'error',
    suggestion: '调整该功能的 estimatedCfps 到生效参数 cfpMin.value 与 cfpMax.value 之间；超出上限说明模块体量过大，应拆分为多个模块功能而不是压缩估算',
    check(artifact, context) {
      const cfpMin = context?.params?.cfpMin
      const cfpMax = context?.params?.cfpMax
      if (typeof cfpMin !== 'object' || cfpMin === null || typeof cfpMin.value !== 'number') return []
      if (typeof cfpMax !== 'object' || cfpMax === null || typeof cfpMax.value !== 'number') return []
      const issues = []
      getFunctions(artifact).forEach((fn, index) => {
        const cfps = fn?.estimatedCfps
        if (typeof cfps === 'number' && Number.isFinite(cfps) && (cfps < cfpMin.value || cfps > cfpMax.value)) {
          issues.push({
            jsonPath: `$.functions[${index}].estimatedCfps`,
            message: say(artifact,
              `单功能CFP超出允许范围：${cfps}，允许 [${cfpMin.value}, ${cfpMax.value}]（cfpMin/cfpMax）`,
              `Per-function CFP out of range: ${cfps}, allowed [${cfpMin.value}, ${cfpMax.value}] (cfpMin/cfpMax)`),
            snapshot: String(cfps),
          })
        }
      })
      return issues
    },
  },
  {
    // Average-band rule driven by the shared param cfpPerFunc {value, min,
    // max}: value is the target MEAN size per function; [min, max] validates
    // the mean across functions — a plan of one function absorbing the whole
    // budget fails here even though each size could be individually legal.
    id: 'plan/cfp-avg-band',
    severity: 'error',
    suggestion: '拆分或合并模块功能，使平均单功能体量接近生效参数 cfpPerFunc.value；如需调整预算请向用户确认后修改 params',
    check(artifact, context) {
      const budget = context?.params?.cfpPerFunc
      if (typeof budget !== 'object' || budget === null || typeof budget.value !== 'number' || typeof budget.min !== 'number' || typeof budget.max !== 'number') return []
      const functions = getFunctions(artifact)
      if (functions.length === 0) return []
      const total = functions.reduce((sum, fn) => {
        const cfps = fn?.estimatedCfps
        return typeof cfps === 'number' && Number.isFinite(cfps) ? sum + cfps : sum
      }, 0)
      const avg = total / functions.length
      if (avg < budget.min || avg > budget.max) {
        const rounded = Math.round(avg * 100) / 100
        return [{
          jsonPath: '$.functions',
          message: say(artifact,
            `平均单功能CFP偏离目标：实际均值 ${rounded}，目标 ${budget.value}，允许均值区间 [${budget.min}, ${budget.max}]（cfpPerFunc）`,
            `Average per-function CFP misses the target: actual mean ${rounded}, target ${budget.value}, allowed mean band [${budget.min}, ${budget.max}] (cfpPerFunc)`),
          snapshot: String(rounded),
        }]
      }
      return []
    },
  },
  {
    // Band rule driven by the shared param cfpTotal {value, downFactor,
    // upFactor}: the total must stay inside [value*downFactor, value*upFactor].
    id: 'plan/cfp-total-band',
    severity: 'error',
    suggestion: '调整各功能的 estimatedCfps，使 totalCfps 落在生效参数 cfpTotal 的 [value×downFactor, value×upFactor] 区间内；如需调整预算请向用户确认后修改 params',
    check(artifact, context) {
      const budget = context?.params?.cfpTotal
      if (typeof budget !== 'object' || budget === null || typeof budget.value !== 'number' || typeof budget.downFactor !== 'number' || typeof budget.upFactor !== 'number') return []
      const total = getFunctions(artifact).reduce((sum, fn) => {
        const cfps = fn?.estimatedCfps
        return typeof cfps === 'number' && Number.isFinite(cfps) ? sum + cfps : sum
      }, 0)
      const floor = budget.value * budget.downFactor
      const ceil = budget.value * budget.upFactor
      if (total < floor || total > ceil) {
        return [{
          jsonPath: '$.functions',
          message: `CFP总数超出预算区间：实际 ${total}，允许 [${floor}, ${ceil}]（cfpTotal.value=${budget.value}）`,
          snapshot: String(total),
        }]
      }
      return []
    },
  },
  {
    // Thresholds migrated from plan_auditor.py: per-function recommended
    // 20-50 (W101), schema hard bounds 5-100; without desiredCfps the
    // total band is [20, 1000]. Also verifies totalCfps === sum.
    id: 'plan/total-cfps-range',
    severity: 'error',
    suggestion: '调整各功能的 estimatedCfps（单项建议 20-50、硬边界 5-100），使总和落在 20-1000 区间，并保证 totalCfps 等于各项之和',
    check: (artifact) => {
      const doc = typeof artifact === 'object' && artifact !== null ? artifact : {}
      const functions = getFunctions(artifact)
      const issues = []
      let total = 0
      for (const fn of functions) {
        const cfps = fn?.estimatedCfps
        if (typeof cfps === 'number' && Number.isFinite(cfps)) total += cfps
      }
      if (total < 20 || total > 1000) {
        issues.push({
          jsonPath: '$.functions',
          message: `CFP总数超出合理范围：实际总和 ${total}，允许区间 [20, 1000]`,
          snapshot: String(total),
        })
      }
      if (typeof doc.totalCfps === 'number' && doc.totalCfps !== total) {
        issues.push({
          jsonPath: '$.totalCfps',
          message: `totalCfps 与 estimatedCfps 之和不一致：${doc.totalCfps} != ${total}`,
          snapshot: String(doc.totalCfps),
        })
      }
      return issues
    },
  }
,
  {
    // Module-change reconciliation against the upstream context
    // (docs/designs/cosmic-context.md): modified functions must reference a
    // module code that already exists in the context tree; added functions
    // must NOT collide with an existing code and must follow the ID
    // convention of their level. v1 reconciles the leaf code (the last
    // funcId segment) against the whole-tree code set; per-segment alignment
    // of the full code chain is a v2 item.
    id: 'plan/context-alignment',
    severity: 'error',
    suggestion: '以合格回执的 cosmic-context 产物为 upstream 重新生成：修改类功能的模块名（l2Name）必须已存在于 context 模块树；新增类功能的模块名不得与已有模块重名；doc_validate 复验需传入相同 upstream 路径。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const upstream = Array.isArray(context?.upstream) ? context.upstream : []
      const project = upstream.find(item => isObject(item) && item.docType === 'context')
      if (project === undefined) {
        return [{
          jsonPath: '$',
          message: say(artifact,
            '找不到上游 context 产物（docType="context"）：生成时必须以合格回执的 cosmic-context 产物为 upstream；doc_validate 复验需传入相同 upstream 路径',
            'Upstream context artifact not found (docType="context"): generate with a green cosmic-context artifact as upstream; pass the same upstream paths when revalidating with doc_validate'),
        }]
      }
      const names = contextModuleNames(project)
      const levels = typeof context?.params?.moduleLevels === 'number' ? context.params.moduleLevels : undefined
      const issues = []
      getFunctions(artifact).forEach((fn, index) => {
        const changeKind = fn?.changeKind
        if (changeKind !== 'added' && changeKind !== 'modified') return // schema rejects other values
        const moduleName = levels >= 2 ? str(fn?.l2Name) : str(fn?.l1Name)
        if (moduleName === '') return
        if (changeKind === 'modified') {
          if (!names.has(moduleName)) {
            issues.push({
              jsonPath: `$.functions[${index}].l2Name`,
              message: say(artifact,
                `修改类功能的模块 "${moduleName}" 不存在于 context 模块树（修改必须指向已有模块）`,
                `The modified function's module "${moduleName}" does not exist in the context module tree (a modification must target an existing module)`),
              snapshot: moduleName,
            })
          }
          return
        }
        if (names.has(moduleName)) {
          issues.push({
            jsonPath: `$.functions[${index}].l2Name`,
            message: say(artifact,
              `新增类功能的模块 "${moduleName}" 与 context 已有模块重名（新增模块须用新名称）`,
              `The added function's module "${moduleName}" collides with an existing context module name (new modules need a fresh name)`),
            snapshot: moduleName,
          })
        }
      })
      return issues
    },
  },
  {
    // funcId is engine-numbered: <topicNo>-<NN>, NN two-digit right-aligned
    // (01-99 zero-padded, 100+ unpadded) and equal to the function's
    // position. The topicNo is extracted from the topic name by the engine
    // (param topicNoPattern) and injected as a param; skips when absent
    // (no topic or no match) — graceful degradation to free-form ids.
    id: 'plan/func-id-numbering',
    severity: 'error',
    suggestion: 'funcId 必须为 `<topicNo>-<序号>`：序号两位右对齐（01-99，100 起无引导零）且等于该功能在 functions 数组中的位置；topicNo 由 topic 名经参数 topicNoPattern 提取',
    check(artifact, context) {
      const topicNo = context?.params?.topicNo
      if (typeof topicNo !== 'string' || topicNo === '') return []
      const issues = []
      getFunctions(artifact).forEach((fn, index) => {
        const expected = `${topicNo}-${pad2(index + 1)}`
        if (str(fn?.funcId) !== expected) {
          issues.push({
            jsonPath: `$.functions[${index}].funcId`,
            message: say(artifact,
              `funcId 应为 ${expected}（topicNo-序号，序号两位右对齐且等于数组位置），实际 ${str(fn?.funcId) || '（空）'}`,
              `funcId should be ${expected} (topicNo-NN, ordinal = array position), got ${str(fn?.funcId) || '(empty)'}`),
            snapshot: str(fn?.funcId),
          })
        }
      })
      return issues
    },
  },
  {
    // moduleLevels parameter coupling (docs/designs/cosmic-context.md): the
    // schema keeps l2Name/l3Name optional (static structure); the effective
    // depth policy is enforced here — l2Name required from level 2, l3Name
    // from level 3. funcId no longer encodes the module chain (a module may
    // carry several functions), so the old segment-count floor is gone.
    id: 'plan/name-hierarchy',
    severity: 'error',
    suggestion: '按生效参数 moduleLevels 补齐层级命名：levels≥2 时 l2Name 必填、levels=3 时 l3Name 必填。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const levels = context?.params?.moduleLevels
      if (typeof levels !== 'number') return []
      const issues = []
      getFunctions(artifact).forEach((fn, index) => {
        if (levels >= 2 && str(fn?.l2Name) === '') {
          issues.push({
            jsonPath: `$.functions[${index}].l2Name`,
            message: say(artifact,
              `moduleLevels=${levels} 时 l2Name 必填`,
              `l2Name is required when moduleLevels=${levels}`),
          })
        }
        if (levels >= 3 && str(fn?.l3Name) === '') {
          issues.push({
            jsonPath: `$.functions[${index}].l3Name`,
            message: say(artifact,
              `moduleLevels=${levels} 时 l3Name 必填`,
              `l3Name is required when moduleLevels=${levels}`),
          })
        }
      })
      return issues
    },
  },
]
