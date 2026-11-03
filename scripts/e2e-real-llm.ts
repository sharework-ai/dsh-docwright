/**
 * Real-LLM end-to-end: boots a REAL dsh host in-process (llm-pi-ai adapter,
 * zai route) and drives the docwright tools against the live model.
 *
 * Covers the shipped-contract moments that deterministic tests cannot:
 *   0. the workspace-level context chain head is seeded from the
 *      cosmic-context golden (fixture — that pack is not under test here)
 *   1. confirmation gate returns pendingConfirmation before any model call
 *   2. cosmic-plan generates green under a user budget (cfpTotal band)
 *   3. cosmic-req chains with targetIndex + no materials, auto-named
 *      `<pack>-<funcId>`, and reports fan-out coverage
 *   3b. cosmic-func chains off req (funcDesc expansion + dataGroups for the
 *       solution layout), then cosmic-tech off func (breakdown table) —
 *       each rendered markdown must carry the solution-document markers
 *   4. an externally edited artifact revalidates green and reseals (seal)
 *   5. doc_chain_status accounts the whole chain
 *   6. an OUTER packsDir pack (examples/packsdir/task-card, copied into the
 *      sandbox workspace's .docwright/packs/) consumes the builtin chain's
 *      func+tech artifacts with ZERO params — targetIndex/topicNo inherit
 *      from the builtin receipts, the confirmation gate does NOT re-fire
 *      (whole-chain-one-interaction across the builtin/packsDir boundary),
 *      and the engine names the artifact CARD-<topicNo>-<NN>
 *   7. the same call again reuses (reused: true, unchanged bytes)
 *   8. doc_chain_status accounts the packsDir pack as a chain stage
 *
 * Prerequisites: sibling dsh checkout installed + build:lib:host-built.
 * Env: ZAI_CODING_CN_API_KEY (required — the script is a no-op without it),
 *      DOCWRIGHT_DSH_REPO (default ../deepseek-harness), E2E_MODEL (default
 *      glm-5.3-flash). The key is read from the environment only — never
 *      written to disk.
 *
 * Usage: ZAI_CODING_CN_API_KEY=... node --import tsx/esm scripts/e2e-real-llm.ts [--keep]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROFILE = 'docwright-e2e'
const MODEL = process.env['E2E_MODEL'] ?? 'glm-5.3-flash'
// Topic-scoped packs refuse to run without a topic (tools.ts fail-loud):
// one work item, one topic directory; artifacts land under <topic>/output/.
const TOPIC = 'REQ-2088 收藏夹'

function fail(message: string): never {
  console.error(`e2e-real-llm: FAIL: ${message}`)
  process.exit(1)
}

if (process.env['ZAI_CODING_CN_API_KEY'] === undefined || process.env['ZAI_CODING_CN_API_KEY'] === '') {
  console.error('e2e-real-llm: SKIP: ZAI_CODING_CN_API_KEY not set (real-model run only)')
  process.exit(0)
}

const repoRoot = resolve(import.meta.dirname, '..')
const dshRepo = resolve(repoRoot, process.env['DOCWRIGHT_DSH_REPO'] ?? '../deepseek-harness')
const keep = process.argv.includes('--keep')

// Same respawn discipline as host-smoke: the dsh checkout resolves
// @deepseek-ai/* onto vendored TS sources via its tsconfig paths.
if (process.env['DOCWRIGHT_E2E_RESPAWNED'] !== '1') {
  const { status } = spawnSync(process.execPath, ['--import', 'tsx/esm', import.meta.filename, ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: { ...process.env, DOCWRIGHT_E2E_RESPAWNED: '1', TSX_TSCONFIG_PATH: join(dshRepo, 'tsconfig.base.json') },
    stdio: 'inherit',
  })
  process.exit(status ?? 1)
}

const root = mkdtempSync(join(tmpdir(), 'docwright-e2e-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const { mkdirSync } = await import('node:fs')
mkdirSync(workspace, { recursive: true })
console.log(`e2e-real-llm: sandbox ${root}`)

execFileSync('corepack', ['pnpm', 'pack', '--pack-destination', root], { cwd: repoRoot, stdio: 'pipe' })
const tarball = readdirSync(root).find(file => file.endsWith('.tgz'))
if (tarball === undefined) fail('pnpm pack produced no tarball')
const env = { ...process.env, DSH_HOME: home }
execFileSync('corepack', ['pnpm', '--pm-on-fail=ignore', '--dir', dshRepo, 'dsh', 'plugin', '--profile', PROFILE, 'add', join(root, tarball!)], { env, stdio: 'pipe' })
writeFileSync(join(home, 'profiles', PROFILE, 'cordis.patch.yml'), `
- id: llm-pi-ai
  config:
    providers:
      zai-coding-cn:
        apiKeyEnv: ZAI_CODING_CN_API_KEY
- id: agent-default-model
  config:
    provider: zai-coding-cn
    model: ${MODEL}
`)

process.env['DSH_HOME'] = home
const { runProfile } = await import(pathToFileURL(join(dshRepo, 'apps/cli/src/profile-boot.ts')).href)
const { loadLayeredEnv } = await import(pathToFileURL(join(dshRepo, 'packages/boot/app-boot/src/index.ts')).href)
const booted = await runProfile({ environment: loadLayeredEnv('dsh'), profile: PROFILE, patchFiles: [], args: [] })
const hostCtx = booted.ctx as unknown as { llm?: unknown; fiber?: { dispose(): Promise<void> } }
if (hostCtx.llm === undefined) fail('booted host exposes no ctx.llm')
console.log(`e2e-real-llm: host booted (model ${MODEL})`)

const { loadPacks } = await import(pathToFileURL(join(repoRoot, 'src/pack-loader.ts')).href)
const { defineDocGenerateTool, defineDocValidateTool, defineDocChainStatusTool } = await import(pathToFileURL(join(repoRoot, 'src/tools.ts')).href)
// The outer-pack step runs the packsDir lane for real: the example pack is
// copied into the sandbox workspace's .docwright/packs/ (the conventional
// packsDir a deployment points config.packsDir at) and merged into the SAME
// pack map — consumes resolution, upstream receipt verification, and param
// inheritance are all name-addressed across the builtin/packsDir boundary.
const packsDir = join(workspace, '.docwright', 'packs')
cpSync(join(repoRoot, 'examples', 'packsdir', 'task-card'), join(packsDir, 'task-card'), { recursive: true })
const packs = await loadPacks(join(repoRoot, 'packs'), { extra: [packsDir] })
const config = { provider: 'zai-coding-cn', model: MODEL, workspaceRoot: workspace, maxIterations: 5, promptTokenBudget: 60_000 }
const deps = { packs, config, ctx: hostCtx }
const gen = defineDocGenerateTool(deps as never)
const validate = defineDocValidateTool(deps as never)
const chainStatus = defineDocChainStatusTool(deps as never)
const exec = { signal: new AbortController().signal }
// Engine naming on prefix-bearing packs: `<artifactPrefix>-<funcId>.json`
// (e.g. REQ + REQ-2088-01 -> REQ-REQ-2088-01.json).
const packArtifactName = (pack: string, funcId: string): string =>
  `${deps.packs.get(pack)!.manifest.artifactPrefix ?? pack}-${funcId}.json`

try {
  // 0. Seed the workspace-level context (chain head) from the cosmic-context
  // golden — a fixture, not under test here (unchanged pack); the real model
  // picks up from plan onward. The seeding tools instance gets its own plain
  // ctx with a scripted port: the real host ctx is a Cordis fiber proxy that
  // refuses outside property writes.
  const contextPack = packs.get('cosmic-context')!
  const seedGen = defineDocGenerateTool({
    packs, config, ctx: {
      llm: {
        stream: async function* () {
          const reply = JSON.stringify(contextPack.goldenSample)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: reply }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    },
  } as never)
  await seedGen.execute({ pack: 'cosmic-context', materials: ['#!inline\n项目背景素材'], language: 'zh-CN', artifactName: 'context', confirm: true } as never, exec as never)
  console.log('e2e-real-llm: 0. context seeded from the cosmic-context golden (fixture)')

  // 1. Confirmation gate fires before any model spend (no confirm flag).
  const gated = await gen.execute({ pack: 'cosmic-plan', topic: TOPIC, upstream: ['context/context.json'], materials: ['#!inline\n需求：为电商系统新增收藏夹功能'] } as never, exec as never) as { pendingConfirmation?: boolean; missingRequired: string[] }
  if (gated.pendingConfirmation !== true || !gated.missingRequired.includes('cfpTotal')) {
    fail(`gate did not fire as designed: ${JSON.stringify(gated).slice(0, 200)}`)
  }
  console.log('e2e-real-llm: 1. gate OK (pendingConfirmation, cfpTotal missing)')

  // 2. Real plan generation under a user budget.
  const BUDGET = { value: 60, downFactor: 0.9, upFactor: 1.2 }
  const plan = await gen.execute({
    pack: 'cosmic-plan', topic: TOPIC, upstream: ['context/context.json'], materials: ['#!inline\n需求：为电商系统新增收藏夹功能。用户可收藏商品、浏览收藏列表（含最新价格与降价标记）、将收藏移入购物车、取消收藏。请分解为 4 个左右叶子功能。'], language: 'zh-CN', params: { cfpTotal: BUDGET }, confirm: true,
  } as never, exec as never) as { artifactPath: string; receipt: { isValid: boolean; iterations: number; rounds: Array<{ errorCount: number }>; params?: Record<string, unknown> }; summary: { functions?: number; totalCfps?: number } }
  const planName = plan.artifactPath.split('/').pop()!
  if (plan.receipt.isValid !== true) fail(`plan not green: ${JSON.stringify(plan.receipt.rules)}`)
  console.log(`e2e-real-llm: 2. plan green in ${plan.receipt.iterations} round(s); ${plan.summary.functions} functions, totalCfps ${plan.summary.totalCfps} in [${BUDGET.value * BUDGET.downFactor}, ${BUDGET.value * BUDGET.upFactor}]`)

  // 3. Chained req: targetIndex picks function 1, NO materials, auto-named.
  const planArtifact = JSON.parse(await (await import('node:fs/promises')).readFile(plan.artifactPath, 'utf8')) as { functions: Array<{ funcId: string }> }
  const firstFuncId = planArtifact.functions[0]!.funcId as string
  const req = await gen.execute({
    pack: 'cosmic-req', topic: TOPIC, language: 'zh-CN', upstream: [`${TOPIC}/output/${planName}`], params: { targetIndex: 1 }, confirm: true,
  } as never, exec as never) as { artifactPath: string; receipt: { isValid: boolean }; coverage?: { covered: number; total: number; missing: string[] } }
  if (req.receipt.isValid !== true) fail('req not green')
  if (!req.artifactPath.endsWith(packArtifactName('cosmic-req', firstFuncId))) fail(`req artifact not auto-named: ${req.artifactPath}`)
  if (req.coverage === undefined || req.coverage.total !== planArtifact.functions.length) fail(`coverage missing or wrong: ${JSON.stringify(req.coverage)}`)
  console.log(`e2e-real-llm: 3. req green (auto-named ${req.artifactPath.split('/').pop()}, coverage ${req.coverage.covered}/${req.coverage.total})`)

  const markdownOf = async (artifactPath: string): Promise<string> => {
    const { readFile: rf } = await import('node:fs/promises')
    return rf(artifactPath.replace(/\.json$/, '.md'), 'utf8')
  }
  {
    const planMd = await markdownOf(plan.artifactPath)
    if (!planMd.includes('# Requirement Breakdown Plan') || !planMd.includes('需求编号及标题：') || !planMd.includes('|一级功能|二级功能|三级功能|功能编号|类型|功能描述|预计CFP数量|')) {
      fail(`plan markdown misses the breakdown-plan markers: ${planMd.slice(0, 200)}`)
    }
    const reqMd = await markdownOf(req.artifactPath)
    if (!reqMd.includes('# Requirements Analysis: ') || !reqMd.includes('**功能编号**') || !reqMd.includes('**业务规则**')) {
      fail(`req markdown misses the analysis-document markers: ${reqMd.slice(0, 200)}`)
    }
    console.log('e2e-real-llm: 3a. plan/req markdown carry the solution-document markers')
  }

  // 3b. Chained func: the model must expand the req funcDesc, derive process
  // dataGroups, and copy the display context; tech refines movements.
  const func = await gen.execute({
    pack: 'cosmic-func', topic: TOPIC, language: 'zh-CN', upstream: [`${TOPIC}/output/${req.artifactPath.split('/').pop()!}`], params: { targetIndex: 1 }, confirm: true,
  } as never, exec as never) as { artifactPath: string; receipt: { isValid: boolean; iterations: number } }
  if (func.receipt.isValid !== true) fail(`func not green: rounds ${func.receipt.iterations}, rules ${JSON.stringify(func.receipt.rules)}`)
  const funcMd = await markdownOf(func.artifactPath)
  if (!funcMd.includes('# Functional Process Design: ') || !funcMd.includes('**功能过程清单**') || !funcMd.includes('主要数据组')) {
    fail(`func markdown misses the solution-document markers: ${funcMd.slice(0, 200)}`)
  }
  console.log(`e2e-real-llm: 3b. func green in ${func.receipt.iterations} round(s) (${func.artifactPath.split('/').pop()}, solution markers OK)`)

  const tech = await gen.execute({
    pack: 'cosmic-tech', topic: TOPIC, language: 'zh-CN', upstream: [`${TOPIC}/output/${func.artifactPath.split('/').pop()!}`], params: { targetIndex: 1 }, confirm: true,
  } as never, exec as never) as { artifactPath: string; receipt: { isValid: boolean; iterations: number } }
  if (tech.receipt.isValid !== true) fail(`tech not green: rounds ${tech.receipt.iterations}, rules ${JSON.stringify(tech.receipt.rules)}`)
  const techMd = await markdownOf(tech.artifactPath)
  if (!techMd.includes('# Function-Point Breakdown: ') || !techMd.includes('| 需求编号 | 需求名称 | 一级功能模块 |')) {
    fail(`tech markdown misses the breakdown-table markers: ${techMd.slice(0, 200)}`)
  }
  const techArtifact = JSON.parse(await (await import('node:fs/promises')).readFile(tech.artifactPath, 'utf8')) as { reqNo: string; processes: Array<{ subProcesses: unknown[] }> }
  if (techArtifact.reqNo === undefined || techArtifact.reqNo === '') fail('tech artifact carries no reqNo (display context was not copied)')
  const techRows = techMd.split('\n').filter(line => line.startsWith(`| ${techArtifact.reqNo} |`)).length
  const expectedMovements = techArtifact.processes.reduce((sum, proc) => sum + proc.subProcesses.length, 0)
  if (techRows !== expectedMovements) fail(`tech markdown has ${techRows} breakdown rows, expected one per movement (${expectedMovements})`)
  console.log(`e2e-real-llm: 3c. tech green in ${tech.receipt.iterations} round(s) (${tech.artifactPath.split('/').pop()}, ${techRows} breakdown rows)`)

  // 4. Seal: external edit that stays green re-issues the sidecar.
  const { readFile: readFileAsync, writeFile: writeFileAsync } = await import('node:fs/promises')
  const reqPath = join(workspace, TOPIC, 'output', packArtifactName('cosmic-req', firstFuncId))
  const edited = JSON.parse(await readFileAsync(reqPath, 'utf8')) as { businessRules: Array<{ description: string }> }
  edited.businessRules[0]!.description = edited.businessRules[0]!.description + '（人工复核确认。）'
  await writeFileAsync(reqPath, JSON.stringify(edited, null, 2), 'utf8')
  const sealed = await validate.execute({ artifactPath: `${TOPIC}/output/${packArtifactName('cosmic-req', firstFuncId)}`, pack: 'cosmic-req', language: 'zh-CN', upstream: [`${TOPIC}/output/${planName}`] } as never, exec as never) as { sealed?: boolean; receipt: { isValid: boolean }; hashMatches: boolean | null }
  if (sealed.receipt.isValid !== true || sealed.sealed !== true) fail(`seal failed: isValid=${String(sealed.receipt.isValid)} sealed=${String(sealed.sealed)}`)
  console.log(`e2e-real-llm: 4. seal OK (edited artifact revalidated green; hashMatches pre-seal = ${String(sealed.hashMatches)})`)

  // 5. Whole-chain accounting.
  const status = await chainStatus.execute({ plan: `${TOPIC}/output/${planName}` } as never, exec as never) as { coverage: Record<string, { covered: number; total: number }>; stages: string[] }
  if (status.coverage['cosmic-req']?.covered !== 1) fail(`chain status wrong: ${JSON.stringify(status.coverage)}`)
  console.log(`e2e-real-llm: 5. chain status OK (stages ${status.stages.join(' → ')})`)

  // 6. The OUTER packsDir pack consumes the builtin chain with ZERO params:
  //    targetIndex/topicNo inherit from the builtin receipts so the gate must
  //    NOT re-fire, and the engine names the artifact CARD-<topicNo>-<NN>.
  const funcName = func.artifactPath.split('/').pop()!
  const techName = tech.artifactPath.split('/').pop()!
  const card = await gen.execute({
    pack: 'task-card', topic: TOPIC, language: 'zh-CN', upstream: [`${TOPIC}/output/${funcName}`, `${TOPIC}/output/${techName}`],
  } as never, exec as never) as {
    artifactPath: string
    reused?: boolean
    receipt: { isValid: boolean; params?: Record<string, unknown>; upstreamHashes: Array<{ pack: string; packVersion: string; artifactHash: string }> }
  }
  if (card.reused === true) fail('task-card unexpectedly reused on its first call')
  if (card.receipt.isValid !== true) fail(`task-card not green: ${JSON.stringify(card.receipt.rules)}`)
  const cardName = card.artifactPath.split('/').pop()!
  if (!cardName.startsWith('CARD-REQ-2088-01.')) fail(`task-card not engine-named from inherited params: ${cardName}`)
  const cardParams = card.receipt.params ?? {}
  if (cardParams['targetIndex'] !== 1) fail(`task-card did not inherit targetIndex from the builtin receipts: ${JSON.stringify(cardParams)}`)
  if (cardParams['topicNo'] !== 'REQ-2088') fail(`task-card did not inherit topicNo: ${JSON.stringify(cardParams)}`)
  if (cardParams['effortHoursPerCfp'] !== 4) fail(`task-card own default effortHoursPerCfp missing: ${JSON.stringify(cardParams)}`)
  const anchorPacks = card.receipt.upstreamHashes.map(a => a.pack).sort()
  if (JSON.stringify(anchorPacks) !== JSON.stringify(['cosmic-func', 'cosmic-tech'])) {
    fail(`task-card upstream anchors wrong: ${JSON.stringify(card.receipt.upstreamHashes)}`)
  }
  const cardArtifact = JSON.parse(await readFileAsync(card.artifactPath, 'utf8')) as { funcId: string; tasks: Array<{ seq: number; cfp: number; hours: number }> }
  if (cardArtifact.funcId !== firstFuncId) fail(`task-card funcId mismatch vs the chain: ${cardArtifact.funcId} vs ${firstFuncId}`)
  const cardRows = cardArtifact.tasks.length
  if (cardRows !== expectedMovements) fail(`task-card has ${cardRows} task rows, expected one per tech movement (${expectedMovements})`)
  if (!cardArtifact.tasks.every(t => Math.abs(t.hours - t.cfp * 4) < 1e-9)) fail('task-card hours are not the effortHoursPerCfp conversion of cfp')
  const cardMd = await markdownOf(card.artifactPath)
  if (!cardMd.includes('# 功能开发任务卡：TC-') || !cardMd.includes('| # | 所属功能过程 |') || !cardMd.includes('## 验收要点')) {
    fail(`task-card markdown misses the card markers: ${cardMd.slice(0, 200)}`)
  }
  console.log(`e2e-real-llm: 6. outer packsDir pack green with ZERO params (gate silent, ${cardName}, ${cardRows} rows, anchors ${anchorPacks.join('+')})`)

  // 7. Reuse across the boundary: the identical call reuses (zero LLM).
  const cardBytes = await readFileAsync(card.artifactPath, 'utf8')
  const again = await gen.execute({
    pack: 'task-card', topic: TOPIC, language: 'zh-CN', upstream: [`${TOPIC}/output/${funcName}`, `${TOPIC}/output/${techName}`],
  } as never, exec as never) as { reused?: boolean; artifactPath: string }
  if (again.reused !== true) fail(`task-card reuse did not hit: ${JSON.stringify(again).slice(0, 200)}`)
  if (await readFileAsync(again.artifactPath, 'utf8') !== cardBytes) fail('task-card reuse returned different artifact bytes')
  console.log(`e2e-real-llm: 7. outer pack reuse OK (${again.artifactPath.split('/').pop()}, bytes unchanged)`)

  // 8. Whole-chain accounting now includes the packsDir stage.
  const status2 = await chainStatus.execute({ plan: `${TOPIC}/output/${planName}` } as never, exec as never) as { coverage: Record<string, { covered: number; total: number }>; stages: string[] }
  if (status2.coverage['task-card']?.covered !== 1) fail(`task-card missing from chain accounting: ${JSON.stringify(status2.coverage)}`)
  console.log(`e2e-real-llm: 8. chain status incl. packsDir stage OK (stages ${status2.stages.join(' → ')})`)

  console.log('e2e-real-llm: PASS')
} finally {
  await (booted.shutdown as { shutdown(code: number): Promise<void> }).shutdown(0).catch(() => {})
}
if (!keep) rmSync(root, { recursive: true, force: true })
