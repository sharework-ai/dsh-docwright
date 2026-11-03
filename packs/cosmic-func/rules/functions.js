// Function rules for the cosmic-func pack: cross-field and cross-artifact
// checks migrated from cosmic-claude auditors/func_auditor.py (E001
// originator != receiver) plus the chain-alignment pattern generalized from
// the req pack (E303): index/funcId/desiredCfps must match the upstream req
// artifact. Contract: export `rules`; each check(artifact, context) returns
// RuleIssue[] ({ jsonPath, message, snapshot? }); an empty array means pass.
// `context` carries upstream (parsed artifacts), materials (raw texts), and
// effective params — see docs/designs/function-rule-context.md. Messages
// follow the artifact's `language` field (zh-CN default, en-US variant) so
// one rule serves both language rule files.

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

export const rules = [
  {
    // E001 migrated: a process's originator and receiver must differ.
    id: 'func/originator-receiver-distinct',
    severity: 'error',
    suggestion: '功能过程的发起者（originator）与接收者（receiver）不能相同：发起者是触发过程的功能用户或外部系统，接收者是响应并实现过程的系统部分；两者相同时说明过程边界没有切开，重新划分触发方与实现方。',
    check(artifact) {
      const issues = []
      for (const [index, proc] of getProcesses(artifact).entries()) {
        if (!isObject(proc)) continue
        const { originator, receiver } = proc
        if (typeof originator === 'string' && typeof receiver === 'string' && originator === receiver) {
          issues.push({
            jsonPath: `$.processes[${index}]`,
            message: say(artifact,
              `功能过程 "${String(proc.name)}" 的发起者与接收者相同（"${originator}"）`,
              `Process "${String(proc.name)}" has an identical originator and receiver ("${originator}")`),
            snapshot: `originator=receiver=${originator}`,
          })
        }
      }
      return issues
    },
  },
  {
    id: 'func/process-name-unique',
    severity: 'error',
    suggestion: '功能过程名称必须在文档内唯一：重名的过程要么是同一过程被重复列出（删除一个），要么是两个不同过程共用泛化名（各自改为具体的业务对象+动作）。',
    check(artifact) {
      const seen = new Map()
      const issues = []
      for (const [index, proc] of getProcesses(artifact).entries()) {
        const name = isObject(proc) && typeof proc.name === 'string' ? proc.name : ''
        if (name === '') continue
        if (seen.has(name)) {
          issues.push({
            jsonPath: `$.processes[${index}].name`,
            message: say(artifact,
              `功能过程名称重复："${name}" 在第 ${seen.get(name) + 1} 和第 ${index + 1} 个过程都出现`,
              `Duplicate process name: "${name}" appears in both process ${seen.get(name) + 1} and ${index + 1}`),
            snapshot: name,
          })
        } else {
          seen.set(name, index)
        }
      }
      return issues
    },
  },
  {
    id: 'func/process-index-sequence',
    severity: 'error',
    suggestion: '功能过程 index 必须从 1 开始连续递增（第 i 个过程的 index 为 i）：重新编号全部过程，使 index 与数组位置一致。',
    check(artifact) {
      const issues = []
      for (const [index, proc] of getProcesses(artifact).entries()) {
        const claimed = isObject(proc) ? proc.index : undefined
        if (claimed !== index + 1) {
          issues.push({
            jsonPath: `$.processes[${index}].index`,
            message: say(artifact,
              `功能过程 index 不连续：数组第 ${index + 1} 项的 index 为 ${String(claimed)}，期望 ${index + 1}`,
              `Process indexes are not sequential: entry ${index + 1} claims index ${String(claimed)}, expected ${index + 1}`),
            snapshot: `index=${String(claimed)}`,
          })
        }
      }
      return issues
    },
  },
  {
    // Process count must be mathematically sufficient for the downstream tech
    // stage: every process carries at most 3 CFPs (the ERX pattern), so fewer
    // than ceil(desiredCfps/3) processes makes the CFP budget unreachable and
    // tech/cfp-total-vs-budget can never go green (2026-11-03 real run: 8
    // processes against a 26-CFP budget exhausted the tech repair loop).
    id: 'func/process-count-vs-budget',
    severity: 'error',
    suggestion: '功能过程数量不足：每个功能过程在下游 tech 最多拆出 3 个数据移动（ERX=3 CFP），过程数少于 ceil(desiredCfps/3) 时 CFP 总预算在数学上不可达；按约 desiredCfps÷2.5 个过程重新分解功能，把粗粒度过程拆细。',
    check(artifact) {
      if (!isObject(artifact)) return []
      const desired = artifact.desiredCfps
      if (typeof desired !== 'number' || !Number.isInteger(desired) || desired < 1) return []
      const count = getProcesses(artifact).length
      const min = Math.ceil(desired / 3)
      if (count < min) {
        return [{
          jsonPath: '$.processes',
          message: say(artifact,
            `功能过程数量不足：desiredCfps=${desired} 至少需要 ${min} 个过程（每过程最多 3 CFP），实际 ${count} 个`,
            `Too few functional processes: desiredCfps=${desired} requires at least ${min} processes (at most 3 CFPs each), got ${count}`),
          snapshot: `processes=${count}`,
        }]
      }
      return []
    },
  },
  {
    // E303 pattern (generalized in the req pack): index/funcId/desiredCfps
    // must align with the upstream req artifact; reqNo/reqTitle/l1Name/
    // l2Name/l3Name carry the display context and must be copied verbatim —
    // compared only when the upstream declares them (l2Name/l3Name follow
    // the plan's moduleLevels and may be absent).
    id: 'func/req-alignment',
    severity: 'error',
    suggestion: 'index/funcId/desiredCfps 必须与上游 req 产物完全一致，reqNo/reqTitle/l1Name/l2Name/l3Name 同样原样复制（上游声明了才复制），均不得改写；doc_validate 复验时请传入与生成时相同的 upstream 路径。',
    check(artifact, context) {
      if (!isObject(artifact)) return []
      const upstream = Array.isArray(context?.upstream) ? context.upstream : []
      const req = upstream.find(item => isObject(item) && item.docType === 'req')
      if (req === undefined) {
        return [{
          jsonPath: '$',
          message: say(artifact,
            '找不到上游 req 产物（docType="req"）：生成时必须以绿回执的 req 产物为 upstream；doc_validate 复验需传入相同 upstream 路径',
            'Upstream req artifact not found (docType="req"): generate with a green req artifact as upstream; pass the same upstream paths when revalidating with doc_validate'),
        }]
      }
      const issues = []
      const expect = (field, reqValue) => {
        if (artifact[field] !== reqValue) {
          issues.push({
            jsonPath: `$.${field}`,
            message: say(artifact,
              `${field} 与上游 req 不一致：func 为 ${String(artifact[field])}，req 为 ${String(reqValue)}`,
              `${field} mismatches the upstream req artifact: func has ${String(artifact[field])}, req has ${String(reqValue)}`),
            snapshot: `${field}=${String(artifact[field])}`,
          })
        }
      }
      expect('index', req.index)
      expect('funcId', req.funcId)
      expect('desiredCfps', req.desiredCfps)
      const expectPresent = (field, reqValue) => {
        if (reqValue !== undefined) expect(field, reqValue)
      }
      expectPresent('reqNo', req.reqNo)
      expectPresent('reqTitle', req.reqTitle)
      expectPresent('l1Name', req.l1Name)
      expectPresent('l2Name', req.l2Name)
      expectPresent('l3Name', req.l3Name)
      return issues
    },
  },
]
