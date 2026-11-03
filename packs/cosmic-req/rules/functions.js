// Function rules for the cosmic-req pack: allowlist and cross-artifact checks
// that declarative rules cannot express. Contract: export `rules`; each
// check(artifact, context) returns RuleIssue[] ({ jsonPath, message,
// snapshot? }); an empty array means pass. `context` carries upstream
// (parsed artifacts), materials (raw texts), and effective params — see
// docs/designs/function-rule-context.md. Messages follow the artifact's
// `language` field (zh-CN default, en-US variant) so one rule serves both
// language rule files.

function isObject(value) {
  return value !== null && typeof value === 'object'
}

/** Message selector: en-US only when the artifact itself says so. */
function say(artifact, zh, en) {
  return isObject(artifact) && artifact.language === 'en-US' ? en : zh
}

/** The deployment role allowlist, from the effective params. */
function rolesAllowlist(context) {
  const raw = context?.params?.functionalUserRoles
  if (typeof raw !== 'string') return undefined
  const roles = raw.split(',').map(role => role.trim()).filter(role => role.length > 0)
  return roles.length > 0 ? roles : undefined
}

export const rules = [
  {
    // E301 migrated: roles must be declared by the deployment (params allowlist).
    id: 'req/functional-user-roles',
    severity: 'error',
    suggestion: 'functionalUsers[].role 必须取自部署角色白名单（params.functionalUserRoles）；先核对白名单，仅使用其中定义的角色名。',
    check(artifact, context) {
      if (!isObject(artifact) || !Array.isArray(artifact.functionalUsers)) return []
      const allowlist = rolesAllowlist(context)
      if (allowlist === undefined) return []
      const issues = []
      for (const [index, user] of artifact.functionalUsers.entries()) {
        const role = isObject(user) ? user.role : undefined
        if (typeof role === 'string' && !allowlist.includes(role)) {
          issues.push({
            jsonPath: `$.functionalUsers[${index}].role`,
            message: say(artifact,
              `功能用户角色 "${role}" 不在部署角色白名单中（允许：${allowlist.join(', ')}）`,
              `Functional user role "${role}" is not in the deployment role allowlist (allowed: ${allowlist.join(', ')})`),
            snapshot: role,
          })
        }
      }
      return issues
    },
  },
  {
    // E302 migrated: businessRules sized against the function's CFP budget.
    id: 'req/business-rule-count',
    severity: 'error',
    suggestion: '业务规则数量须落在配比区间 [ceil(desiredCfps/cfpsPerRule), floor(ceil×1.5)] 内：不足则从素材继续提取约束，超出则合并同类规则。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const desiredCfps = artifact.desiredCfps
      if (typeof desiredCfps !== 'number' || !Number.isInteger(desiredCfps) || desiredCfps < 1) return []
      const actual = Array.isArray(artifact.businessRules) ? artifact.businessRules.length : 0
      const perFunc = typeof context?.params?.cfpsPerRule === 'number' ? context.params.cfpsPerRule : 30
      const minRules = Math.ceil(desiredCfps / perFunc)
      const maxRules = Math.floor(minRules * 1.5)
      if (actual < minRules) {
        return [{
          jsonPath: '$.businessRules',
          message: say(artifact,
            `业务规则数量不足：期望至少 ${minRules} 条（desiredCfps=${desiredCfps}，cfpsPerRule=${perFunc}），实际 ${actual} 条`,
            `Too few business rules: expected at least ${minRules} (desiredCfps=${desiredCfps}, cfpsPerRule=${perFunc}), got ${actual}`),
          snapshot: `businessRules.length=${actual}`,
        }]
      }
      if (actual > maxRules) {
        return [{
          jsonPath: '$.businessRules',
          message: say(artifact,
            `业务规则数量过多：期望最多 ${maxRules} 条（desiredCfps=${desiredCfps}，cfpsPerRule=${perFunc}），实际 ${actual} 条`,
            `Too many business rules: expected at most ${maxRules} (desiredCfps=${desiredCfps}, cfpsPerRule=${perFunc}), got ${actual}`),
          snapshot: `businessRules.length=${actual}`,
        }]
      }
      return []
    },
  },
  {
    // E303 generalized: index/funcId/desiredCfps must align with the upstream
    // plan function; reqNo/reqTitle/l1Name/l2Name/l3Name carry the display
    // context (solution-document title and module hierarchy) and must be
    // copied verbatim — compared only when the upstream declares them, since
    // l2Name/l3Name follow the plan's moduleLevels and may be absent.
    id: 'req/plan-alignment',
    severity: 'error',
    suggestion: 'index/funcId/desiredCfps 必须与上游 plan 中对应 function 完全一致：index 必须等于生效参数 targetIndex（生成哪个功能由调用方指定），funcId 与 desiredCfps（=estimatedCfps）从那里原样复制；reqNo/reqTitle 复制 plan 顶层，l1Name/l2Name/l3Name 复制对应 function（上游声明了才复制），均不得改写；doc_validate 复验时请传入与生成时相同的 upstream 路径。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const upstream = Array.isArray(context?.upstream) ? context.upstream : []
      const plan = upstream.find(item => isObject(item) && item.docType === 'plan')
      if (plan === undefined) {
        return [{
          jsonPath: '$',
          message: say(artifact,
            '找不到上游 plan 产物（docType="plan"）：生成时必须以绿回执的 plan 产物为 upstream；doc_validate 复验需传入相同 upstream 路径',
            'Upstream plan artifact not found (docType="plan"): generate with a green plan artifact as upstream; pass the same upstream paths when revalidating with doc_validate'),
        }]
      }
      const functions = Array.isArray(plan.functions) ? plan.functions : []
      const index = artifact.index
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > functions.length) {
        return [{
          jsonPath: '$.index',
          message: say(artifact,
            `index 超出上游 plan functions 范围：期望 1-${functions.length}，实际 ${String(index)}`,
            `index is outside the upstream plan functions range: expected 1-${functions.length}, got ${String(index)}`),
          snapshot: `index=${String(index)}`,
        }]
      }
      // The caller's targetIndex picks the function; the artifact index must match it.
      const targetIndex = context?.params?.targetIndex
      if (typeof targetIndex === 'number' && index !== targetIndex) {
        return [{
          jsonPath: '$.index',
          message: say(artifact,
            `index 与生效参数 targetIndex 不一致：index 为 ${index}，targetIndex 为 ${targetIndex}（生成哪个功能由 targetIndex 决定）`,
            `index mismatches the effective param targetIndex: index is ${index}, targetIndex is ${targetIndex} (the target function is picked by targetIndex)`),
          snapshot: `index=${index}`,
        }]
      }
      const fn = functions[index - 1]
      const issues = []
      if (isObject(fn) && artifact.funcId !== fn.funcId) {
        issues.push({
          jsonPath: '$.funcId',
          message: say(artifact,
            `funcId 与上游 plan 不一致：req 为 "${String(artifact.funcId)}"，plan functions[${index - 1}] 为 "${String(fn.funcId)}"`,
            `funcId mismatches the upstream plan: req has "${String(artifact.funcId)}", plan functions[${index - 1}] has "${String(fn.funcId)}"`),
          snapshot: `funcId=${String(artifact.funcId)}`,
        })
      }
      if (isObject(fn) && artifact.desiredCfps !== fn.estimatedCfps) {
        issues.push({
          jsonPath: '$.desiredCfps',
          message: say(artifact,
            `desiredCfps 与上游 plan 不一致：req 为 ${String(artifact.desiredCfps)}，plan functions[${index - 1}].estimatedCfps 为 ${String(fn.estimatedCfps)}`,
            `desiredCfps mismatches the upstream plan: req has ${String(artifact.desiredCfps)}, plan functions[${index - 1}].estimatedCfps is ${String(fn.estimatedCfps)}`),
          snapshot: `desiredCfps=${String(artifact.desiredCfps)}`,
        })
      }
      const expectPlanField = (field, planValue) => {
        if (planValue === undefined || artifact[field] === planValue) return
        issues.push({
          jsonPath: `$.${field}`,
          message: say(artifact,
            `${field} 与上游 plan 不一致：req 为 "${String(artifact[field])}"，plan 为 "${String(planValue)}"`,
            `${field} mismatches the upstream plan: req has "${String(artifact[field])}", plan has "${String(planValue)}"`),
          snapshot: `${field}=${String(artifact[field])}`,
        })
      }
      expectPlanField('reqNo', plan.reqNo)
      expectPlanField('reqTitle', plan.reqTitle)
      if (isObject(fn)) {
        expectPlanField('l1Name', fn.l1Name)
        expectPlanField('l2Name', fn.l2Name)
        expectPlanField('l3Name', fn.l3Name)
      }
      return issues
    },
  },
]
