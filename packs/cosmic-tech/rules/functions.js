// Function rules for the cosmic-tech pack: data-movement sequence checks
// migrated from cosmic-claude auditors/tech_auditor.py and tightened to the
// three audit-safe movement patterns ERX / EW / EX (review boards reject other
// shapes, e.g. EWRX/ERRX). One pattern rule subsumes the former E101 (first
// movement E), E102 (ends with W/X), E103/E107/E109 (movement counts), E105
// (no adjacent repeats) and E108 (entry after exit) — all implied by the
// pattern set. Remaining checks migrated as-is: W103 duplicate movements,
// W101 subprocess description keywords, W102 data property count, plus the CFP
// budget check (E101/W100/E200/W200 family, parametrized by the shared
// cfpTotal downFactor/upFactor factors) and the chain-alignment
// pattern generalized from the req pack (E303): index/funcId/desiredCfps and
// process-name coverage against the upstream func artifact.
// Contract: export `rules`; each check(artifact, context) returns RuleIssue[]
// ({ jsonPath, message, snapshot? }); an empty array means pass. `context`
// carries upstream (parsed artifacts), materials (raw texts), and effective
// params — see docs/designs/function-rule-context.md. Messages follow the
// artifact's `language` field (zh-CN default, en-US variant) so one rule
// serves both language rule files.

function isObject(value) {
  return value !== null && typeof value === 'object'
}

/** Message selector: en-US only when the artifact itself says so. */
function say(artifact, zh, en) {
  return isObject(artifact) && artifact.language === 'en-US' ? en : zh
}

function getProcesses(artifact) {
  return isObject(artifact) && Array.isArray(artifact.processes) ? artifact.processes : []
}

function getMovements(proc) {
  return isObject(proc) && Array.isArray(proc.subProcesses) ? proc.subProcesses : []
}

/** W101 keyword list: technical-implementation words that belong in designs, not in subprocess descriptions. */
const DESC_KEYWORDS = ['计算', '转化', '转换', '拆分', '日志', '解析', '编码', '缓存', '临时', '筛选', '排序']

/**
 * Param-driven regex helpers (docs/designs/param-object-model.md): the
 * manifest declares `movementSequencePattern` / `subprocessDescPattern`
 * (string, default = the shipped check). Effective params are always
 * complete (defaults guarantee it), so a missing param falls back to the
 * shipped default only for standalone callers; an EMPTY string disables the
 * check (unset = no check); an invalid regex throws — the rule crashes loud,
 * never silently passes.
 */
function paramRegex(context, param, fallbackSource) {
  const raw = context?.params?.[param]
  const source = typeof raw === 'string' && raw !== '' ? raw : fallbackSource
  if (typeof raw === 'string' && raw === '') return null
  return new RegExp(source)
}

/** Tolerance band around desiredCfps, from the shared cfpTotal {downFactor, upFactor}; defaults tighten the old [0.9, 1.5] to [0.9, 1.2]. */
// The tech stage never totals below the planned estimate (2026-10-14 real-session
// review): downFactor does NOT loosen tech — the floor is exactly desiredCfps,
// and upFactor keeps the upper tolerance only.
function budgetFactors(context) {
  const shared = context?.params?.cfpTotal
  const up = typeof shared?.upFactor === 'number' ? shared.upFactor : 1.2
  return { down: 1, up }
}

export const rules = [
  {
    // E303 pattern (generalized in the req pack): index/funcId/desiredCfps
    // plus process-name coverage against the upstream func artifact;
    // reqNo/reqTitle/l1Name/l2Name/l3Name carry the display context and must
    // be copied verbatim — compared only when the upstream declares them
    // (l2Name/l3Name follow the plan's moduleLevels and may be absent).
    id: 'tech/func-alignment',
    severity: 'error',
    suggestion: 'index/funcId/desiredCfps 必须与上游 func 产物完全一致（原样复制），reqNo/reqTitle/l1Name/l2Name/l3Name 同样原样复制（上游声明了才复制），均不得改写；上游 func 的每个功能过程都必须出现在本产物的 processes 中（同名过程，不得遗漏或改写名称）；doc_validate 复验时请传入与生成时相同的 upstream 路径。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const upstream = Array.isArray(context?.upstream) ? context.upstream : []
      const func = upstream.find(item => isObject(item) && item.docType === 'func')
      if (func === undefined) {
        return [{
          jsonPath: '$',
          message: say(artifact,
            '找不到上游 func 产物（docType="func"）：生成时必须以合格回执的 func 产物为 upstream；doc_validate 复验需传入相同 upstream 路径',
            'Upstream func artifact not found (docType="func"): generate with a green func artifact as upstream; pass the same upstream paths when revalidating with doc_validate'),
        }]
      }
      const issues = []
      const expect = (field, funcValue) => {
        if (artifact[field] !== funcValue) {
          issues.push({
            jsonPath: `$.${field}`,
            message: say(artifact,
              `${field} 与上游 func 不一致：tech 为 ${String(artifact[field])}，func 为 ${String(funcValue)}`,
              `${field} mismatches the upstream func artifact: tech has ${String(artifact[field])}, func has ${String(funcValue)}`),
            snapshot: `${field}=${String(artifact[field])}`,
          })
        }
      }
      expect('index', func.index)
      expect('funcId', func.funcId)
      expect('desiredCfps', func.desiredCfps)
      const expectPresent = (field, funcValue) => {
        if (funcValue !== undefined) expect(field, funcValue)
      }
      expectPresent('reqNo', func.reqNo)
      expectPresent('reqTitle', func.reqTitle)
      expectPresent('l1Name', func.l1Name)
      expectPresent('l2Name', func.l2Name)
      expectPresent('l3Name', func.l3Name)
      const techNames = new Set(getProcesses(artifact).map(p => (isObject(p) && typeof p.name === 'string' ? p.name : '')))
      for (const [index, proc] of getProcesses(func).entries()) {
        const name = isObject(proc) && typeof proc.name === 'string' ? proc.name : ''
        if (name !== '' && !techNames.has(name)) {
          issues.push({
            jsonPath: '$.processes',
            message: say(artifact,
              `上游 func 的功能过程 "${name}"（第 ${index + 1} 个）未出现在 tech 的 processes 中：每个 func 过程都必须被拆分`,
              `Upstream func process "${name}" (#${index + 1}) is missing from the tech processes: every func process must be broken down`),
            snapshot: `missing=${name}`,
          })
        }
      }
      return issues
    },
  },
  {
    // The audit-safe movement patterns: ERX (query), EW (persist), EX
    // (forward/interact). One check subsumes the former E101/E102/E103/E105/
    // E107/E108/E109 and A101 rules — sequence legality implies all of them.
    // The allowed shapes are the movementSequencePattern param (default
    // ^(ERX|EW|EX)$); an empty param disables the check.
    id: 'tech/movement-pattern',
    severity: 'error',
    suggestion: '每个功能过程的数据移动序列必须匹配生效参数 movementSequencePattern（默认 ^(ERX|EW|EX)$，即 ERX=查询、EW=落库、EX=转发交互三种评审安全模式；置空该参数可停用本检查）：其他序列（如 EWRX、ERWX、连续 RR）评审时容易被核减，请按允许的模式重新组织子过程。',
    check(artifact, context) {
      const re = paramRegex(context, 'movementSequencePattern', '^(ERX|EW|EX)$')
      if (re === null) return []
      const issues = []
      for (const [index, proc] of getProcesses(artifact).entries()) {
        const seq = getMovements(proc)
          .map(mv => (isObject(mv) && typeof mv.dataMovementType === 'string' ? mv.dataMovementType : '?'))
          .join('')
        if (!re.test(seq)) {
          issues.push({
            jsonPath: `$.processes[${index}].subProcesses`,
            message: say(artifact,
              `功能过程 "${String(isObject(proc) ? proc.name : index + 1)}" 的数据移动序列为 ${seq}，不匹配生效参数 movementSequencePattern（默认只允许 ERX=查询、EW=写入、EX=转发交互）`,
              `Process "${String(isObject(proc) ? proc.name : index + 1)}" has movement sequence ${seq}, which does not match the effective param movementSequencePattern (by default only ERX=query, EW=write, EX=forward)`),
            snapshot: `sequence=${seq}`,
          })
        }
      }
      return issues
    },
  },
  {
    // W103 migrated: identical movement combinations within one process.
    id: 'tech/movement-duplicate',
    severity: 'warning',
    suggestion: '同一功能过程内出现了类型+数据组+数据属性完全相同的数据移动：删除重复项，或区分两次移动的业务含义（如读取时机不同）后改写描述与数据属性。',
    check(artifact) {
      const issues = []
      for (const [index, proc] of getProcesses(artifact).entries()) {
        const seen = new Map()
        const name = isObject(proc) ? String(proc.name) : `#${index + 1}`
        for (const [i, mv] of getMovements(proc).entries()) {
          if (!isObject(mv)) continue
          const props = Array.isArray(mv.dataProperties) ? mv.dataProperties.map(String) : []
          const key = `${String(mv.dataMovementType)}|${String(mv.dataGroup)}|${props.join(',')}`
          if (seen.has(key)) {
            issues.push({
              jsonPath: `$.processes[${index}].subProcesses[${i}]`,
              message: say(artifact,
                `功能过程 "${name}" 第 ${i + 1} 个数据移动与第 ${seen.get(key) + 1} 个重复（类型/数据组/数据属性完全相同）`,
                `Process "${name}" repeats the identical movement (type/data group/properties) at ${seen.get(key) + 1} and ${i + 1}`),
              snapshot: key,
            })
          } else {
            seen.set(key, i)
          }
        }
      }
      return issues
    },
  },
  {
    // W101 migrated: technical words in subprocess descriptions, via the
    // subprocessDescPattern param (default: the tempered-dot complement of
    // the old DESC_KEYWORDS list); an empty param disables the check.
    id: 'tech/subprocess-desc-keywords',
    severity: 'warning',
    suggestion: '子过程描述未通过生效参数 subprocessDescPattern（默认排除计算/转化/转换/拆分/日志/解析/编码/缓存/临时/筛选/排序等技术实现字眼；置空该参数可停用本检查）：描述应写清什么数据在功能用户与系统之间移动，实现方式留给详细设计。',
    check(artifact, context) {
      const re = paramRegex(context, 'subprocessDescPattern', `^(?:(?!${DESC_KEYWORDS.join('|')}).)*$`)
      if (re === null) return []
      const issues = []
      for (const [index, proc] of getProcesses(artifact).entries()) {
        const name = isObject(proc) ? String(proc.name) : `#${index + 1}`
        for (const [i, mv] of getMovements(proc).entries()) {
          const desc = isObject(mv) && typeof mv.description === 'string' ? mv.description : ''
          if (!re.test(desc)) {
            issues.push({
              jsonPath: `$.processes[${index}].subProcesses[${i}].description`,
              message: say(artifact,
                `功能过程 "${name}" 第 ${i + 1} 个子过程描述未通过生效参数 subprocessDescPattern（默认排除技术实现字眼）`,
                `Subprocess ${i + 1} of process "${name}" does not match the effective param subprocessDescPattern (by default it excludes technical-implementation words)`),
              snapshot: desc,
            })
          }
        }
      }
      return issues
    },
  },
  {
    // W102 migrated: a movement should carry at least two data properties.
    id: 'tech/data-properties-count',
    severity: 'warning',
    suggestion: '数据移动的 dataProperties 至少列出 2 个数据项：只写 1 个通常说明数据组刻画不完整，补齐该移动真正携带的业务字段。',
    check(artifact) {
      const issues = []
      for (const [index, proc] of getProcesses(artifact).entries()) {
        const name = isObject(proc) ? String(proc.name) : `#${index + 1}`
        for (const [i, mv] of getMovements(proc).entries()) {
          const props = isObject(mv) && Array.isArray(mv.dataProperties) ? mv.dataProperties : []
          if (props.length < 2) {
            issues.push({
              jsonPath: `$.processes[${index}].subProcesses[${i}].dataProperties`,
              message: say(artifact,
                `功能过程 "${name}" 第 ${i + 1} 个数据移动只携带 ${props.length} 个数据属性（建议至少 2 个）`,
                `Movement ${i + 1} of process "${name}" carries only ${props.length} data propert${props.length === 1 ? 'y' : 'ies'} (at least 2 recommended)`),
              snapshot: `dataProperties.length=${props.length}`,
            })
          }
        }
      }
      return issues
    },
  },
  {
    // CFP budget error bounds migrated (E101/E200): total CFPs vs the
    // desiredCfps budget. The floor is pinned at the planned estimate
    // (budgetFactors: down=1 — a real session showed systematic -11%~-16%
    // shortfalls inside the old 0.9 band); upFactor keeps the upper
    // tolerance. The advisory band lives in tech/cfp-budget-advice below —
    // FunctionRule carries one severity, so error and warning cannot share a rule.
    id: 'tech/cfp-total-vs-budget',
    severity: 'error',
    suggestion: '全部子过程的 CFP 总数不得低于计划估算 desiredCfps，且不超过 desiredCfps×upFactor（上限容差见生效参数 cfpTotal）：不足说明拆分粒度太粗（继续从素材细化数据移动，注意 EW/EX 各计 2 CFP、ERX 计 3 CFP），超出说明拆分过细（合并同类子过程）。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const desired = artifact.desiredCfps
      if (typeof desired !== 'number' || !Number.isInteger(desired) || desired < 1) return []
      let total = 0
      for (const proc of getProcesses(artifact)) {
        for (const mv of getMovements(proc)) {
          if (isObject(mv) && typeof mv.cfp === 'number') total += mv.cfp
        }
      }
      const factors = budgetFactors(context)
      const minRatio = factors.down
      const maxRatio = factors.up
      const floor = desired * minRatio
      const ceil = desired * maxRatio
      if (total < floor) {
        return [{
          jsonPath: '$.processes',
          message: say(artifact,
            `CFP 总数不足：实际 ${total}，低于预算下限 ${desired}×${minRatio}=${floor}（desiredCfps=${desired}）`,
            `Total CFPs too low: got ${total}, below the budget floor ${desired}×${minRatio}=${floor} (desiredCfps=${desired})`),
          snapshot: `totalCfps=${total}`,
        }]
      }
      if (total > ceil) {
        return [{
          jsonPath: '$.processes',
          message: say(artifact,
            `CFP 总数超出：实际 ${total}，高于预算上限 ${desired}×${maxRatio}=${ceil}（desiredCfps=${desired}）`,
            `Total CFPs too high: got ${total}, above the budget ceiling ${desired}×${maxRatio}=${ceil} (desiredCfps=${desired})`),
          snapshot: `totalCfps=${total}`,
        }]
      }
      return []
    },
  },
  {
    // W100/W200 migrated: inside the error bounds but off the budget by more
    // than the tolerance bands fixed at [min, 1) and (1.2, max].
    id: 'tech/cfp-budget-advice',
    severity: 'warning',
    suggestion: 'CFP 总数高于计划估算但在容差上限内（上限系数见生效参数 cfpTotal.upFactor）：检查是否拆分过细，合并同类子过程。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const desired = artifact.desiredCfps
      if (typeof desired !== 'number' || !Number.isInteger(desired) || desired < 1) return []
      let total = 0
      for (const proc of getProcesses(artifact)) {
        for (const mv of getMovements(proc)) {
          if (isObject(mv) && typeof mv.cfp === 'number') total += mv.cfp
        }
      }
      const factors = budgetFactors(context)
      // Below desired is the error rule's job (floor pinned at desired);
      // the advisory band covers in-tolerance overshoot only.
      if (total <= desired || total > desired * factors.up) return []
      return [{
        jsonPath: '$.processes',
        message: say(artifact,
          `CFP 总数高于计划估算：实际 ${total}，期望 ${desired}（容差上限 ${factors.up}×${desired}，带内仅提示）`,
          `Total CFPs exceed the plan estimate: got ${total}, expected ${desired} (tolerance ceiling ${factors.up}×${desired}; advisory only)`),
        snapshot: `totalCfps=${total}`,
      }]
    },
  },
]
