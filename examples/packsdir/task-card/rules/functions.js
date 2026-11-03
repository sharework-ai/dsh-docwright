// Function rules for the task-card pack: cross-artifact integrity against the
// built-in COSMIC chain artifacts it consumes (cosmic-func + cosmic-tech).
// Contract: export `rules`; each check(artifact, context) returns RuleIssue[]
// ({ jsonPath, message, snapshot? }); an empty array means pass. `context`
// carries upstream (parsed artifacts), materials (raw texts), and effective
// params. Messages follow the artifact's `language` field (zh-CN default,
// en-US variant) so one rule serves both language rule files.

function isObject(value) {
  return value !== null && typeof value === 'object'
}

/** Message selector: en-US only when the artifact itself says so. */
function say(artifact, zh, en) {
  return isObject(artifact) && artifact.language === 'en-US' ? en : zh
}

/** The consumed tech artifact (docType "tech") among the upstream records. */
function techOf(context) {
  const upstream = Array.isArray(context?.upstream) ? context.upstream : []
  return upstream.find(item => isObject(item) && item.docType === 'tech') ?? undefined
}

/** The consumed func artifact (docType "func") among the upstream records. */
function funcOf(context) {
  const upstream = Array.isArray(context?.upstream) ? context.upstream : []
  return upstream.find(item => isObject(item) && item.docType === 'func') ?? undefined
}

/** Upstream movements as comparable records: process name, data group, movement type, cfp. */
function movementsOf(tech) {
  const rows = []
  if (!isObject(tech) || !Array.isArray(tech.processes)) return rows
  for (const process of tech.processes) {
    if (!isObject(process) || !Array.isArray(process.subProcesses)) continue
    for (const movement of process.subProcesses) {
      if (!isObject(movement)) continue
      rows.push({
        process: process.name,
        dataGroup: movement.dataGroup,
        movementType: movement.dataMovementType,
        cfp: movement.cfp,
        description: movement.description,
      })
    }
  }
  return rows
}

/** Multiset tally: key -> count. */
function tally(keys) {
  const counts = new Map()
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

export const rules = [
  {
    // Chain anchor: the card inherits the identity of the function it hands off.
    id: 'taskcard/anchor-alignment',
    severity: 'error',
    suggestion: 'index/funcId/reqNo/reqTitle/l1Name 必须与上游 tech 产物完全一致（上游声明了 l2Name/l3Name 时同样原样复制），均不得改写；doc_validate 复验时请传入与生成时相同的 upstream 路径。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const tech = techOf(context)
      if (tech === undefined) {
        return [{
          jsonPath: '$',
          message: say(artifact,
            '找不到上游 tech 产物（docType="tech"）：生成时必须以绿回执的 cosmic-tech 产物为 upstream；doc_validate 复验需传入相同 upstream 路径',
            'Upstream tech artifact not found (docType="tech"): generate with a green cosmic-tech artifact as upstream; pass the same upstream paths when revalidating with doc_validate'),
        }]
      }
      const issues = []
      for (const field of ['index', 'funcId', 'reqNo', 'reqTitle', 'l1Name']) {
        const expected = tech[field]
        if (expected !== undefined && artifact[field] !== expected) {
          issues.push({
            jsonPath: `$.${field}`,
            message: say(artifact,
              `${field} 与上游 tech 产物不一致：任务卡是 ${String(expected)}，卡片写了 ${String(artifact[field])}`,
              `${field} mismatches the upstream tech artifact: card carries ${String(artifact[field])}, upstream says ${String(expected)}`),
            snapshot: `${field}=${String(artifact[field])}`,
          })
        }
      }
      for (const field of ['l2Name', 'l3Name']) {
        const expected = tech[field]
        if (typeof expected === 'string' && expected !== '' && artifact[field] !== expected) {
          issues.push({
            jsonPath: `$.${field}`,
            message: say(artifact,
              `${field} 与上游 tech 产物不一致：任务卡是 ${expected}，卡片写了 ${String(artifact[field])}`,
              `${field} mismatches the upstream tech artifact: card carries ${String(artifact[field])}, upstream says ${expected}`),
            snapshot: `${field}=${String(artifact[field])}`,
          })
        }
      }
      return issues
    },
  },
  {
    // Coverage: the card's task list must be the upstream movement list 1:1 —
    // same rows (process, data group, movement type, cfp), same multiplicity.
    id: 'taskcard/task-coverage',
    severity: 'error',
    suggestion: 'tasks 必须逐行对应上游 tech 的每个数据移动（process/dataGroup/movementType/cfp 与上游一致，顺序一致），不得遗漏、合并或杜撰任务行。',
    check(artifact, context) {
      if (!isObject(artifact) || !Array.isArray(artifact.tasks)) return []
      const tech = techOf(context)
      if (tech === undefined) return [] // anchor-alignment already reports the missing upstream
      const expected = movementsOf(tech)
      const actualKeys = artifact.tasks.map(task => isObject(task)
        ? `${task.process}|${task.dataGroup}|${task.movementType}|${task.cfp}`
        : String(task))
      const expectedCounts = tally(expected.map(m => `${m.process}|${m.dataGroup}|${m.movementType}|${m.cfp}`))
      const actualCounts = tally(actualKeys)
      const issues = []
      for (const [key, count] of expectedCounts) {
        const got = actualCounts.get(key) ?? 0
        if (got < count) {
          const [process, dataGroup, movementType, cfp] = key.split('|')
          issues.push({
            jsonPath: '$.tasks',
            message: say(artifact,
              `任务清单缺少上游数据移动对应的任务行：过程「${process}」名下应有 { process: "${process}", dataGroup: "${dataGroup}", movementType: "${movementType}", cfp: ${cfp} } 这样的行 ${count} 行、实际 ${got} 行——按上游顺序原样补入缺失行，不要合并或省略（上游不同过程下数据组相同的行各自保留）`,
              `The task list is missing the row for an upstream data movement: under process "${process}" the row { process: "${process}", dataGroup: "${dataGroup}", movementType: "${movementType}", cfp: ${cfp} } must appear ${count} time(s), found ${got} — insert the missing row(s) verbatim in upstream order; do not merge or drop rows (identical data groups under different processes each keep their own row)`),
            snapshot: key,
          })
        }
      }
      for (const [key, count] of actualCounts) {
        if ((expectedCounts.get(key) ?? 0) < count) {
          issues.push({
            jsonPath: '$.tasks',
            message: say(artifact,
              `任务清单含上游不存在的任务行：${key.replaceAll('|', ' / ')}（多余 ${count} 行）——任务行只能来自上游 tech 的数据移动`,
              `Task list contains rows absent from the upstream: ${key.replaceAll('|', ' / ')} (${count} extra) — task rows may only come from upstream tech movements`),
            snapshot: key,
          })
        }
      }
      return issues
    },
  },
  {
    // Size fidelity: the card preserves the chain's CFP accounting exactly.
    id: 'taskcard/cfp-total',
    severity: 'error',
    suggestion: '全部任务的 CFP 合计必须等于上游 tech 产物的 desiredCfps；任务行 cfp 从上游数据移动原样复制，不得改写或凑数。',
    check(artifact, context) {
      if (!isObject(artifact) || !Array.isArray(artifact.tasks)) return []
      const tech = techOf(context)
      if (tech === undefined) return [] // anchor-alignment already reports the missing upstream
      const expected = typeof tech.desiredCfps === 'number' ? tech.desiredCfps : undefined
      if (expected === undefined) return []
      const total = artifact.tasks.reduce((sum, task) => (isObject(task) && typeof task.cfp === 'number' ? sum + task.cfp : sum), 0)
      if (total !== expected) {
        return [{
          jsonPath: '$.tasks',
          message: say(artifact,
            `任务 CFP 合计 ${total} 与上游 desiredCfps ${expected} 不一致：核对每行 cfp 是否与上游数据移动一致`,
            `Task CFP total ${total} mismatches the upstream desiredCfps ${expected}: check each row's cfp against the upstream movements`),
          snapshot: `total=${total}`,
        }]
      }
      return []
    },
  },
  {
    // Deployment math: hours convert from CFP via the effective parameter.
    id: 'taskcard/hours-math',
    severity: 'error',
    suggestion: '每个任务的 hours 必须等于 cfp × 生效参数 effortHoursPerCfp：按公式重算，不要手填估算。',
    check(artifact, context) {
      if (!isObject(artifact) || !Array.isArray(artifact.tasks)) return []
      const factor = context?.params?.effortHoursPerCfp
      if (typeof factor !== 'number' || !Number.isFinite(factor)) return []
      const issues = []
      for (const [index, task] of artifact.tasks.entries()) {
        if (!isObject(task) || typeof task.cfp !== 'number' || typeof task.hours !== 'number') continue
        const expected = task.cfp * factor
        if (Math.abs(task.hours - expected) > 1e-9) {
          issues.push({
            jsonPath: `$.tasks[${index}].hours`,
            message: say(artifact,
              `任务 ${index + 1} 的人时折算不正确：cfp ${task.cfp} × effortHoursPerCfp ${factor} 应为 ${expected}，实际 ${task.hours}`,
              `Task ${index + 1} hour conversion is wrong: cfp ${task.cfp} × effortHoursPerCfp ${factor} = ${expected}, got ${task.hours}`),
            snapshot: `hours=${String(task.hours)}`,
          })
        }
      }
      return issues
    },
  },
  {
    // Summary grounding: the brief must reflect the function the chain designed.
    id: 'taskcard/summary-grounding',
    severity: 'warning',
    suggestion: 'summary 应提炼自上游 func 产物的 funcDesc 与功能过程清单：概述里点到的行为必须在上游功能过程中真实存在，不要引入上游没有的承诺。',
    check(artifact, context) {
      if (!isObject(artifact) || typeof artifact.summary !== 'string') return []
      const func = funcOf(context)
      if (func === undefined) return [] // coverage path owns missing-upstream reporting
      const processNames = Array.isArray(func.processes)
        ? func.processes.map(process => (isObject(process) && typeof process.name === 'string' ? process.name : '')).filter(name => name !== '')
        : []
      if (processNames.length === 0) return []
      const mentioned = processNames.filter(name => artifact.summary.includes(name))
      if (mentioned.length === 0) {
        return [{
          jsonPath: '$.summary',
          message: say(artifact,
            `summary 未提到任何上游功能过程（${processNames.slice(0, 4).join('、')}…）：概述应概括这些过程承载的行为`,
            `summary mentions none of the upstream functional processes (${processNames.slice(0, 4).join(', ')}…): the brief should summarize the behaviors those processes carry`),
          snapshot: truncate(artifact.summary),
        }]
      }
      return []
    },
  },
]

function truncate(text) {
  return typeof text === 'string' && text.length > 60 ? `${text.slice(0, 57)}…` : String(text)
}
