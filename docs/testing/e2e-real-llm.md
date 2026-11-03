# E2E: real-LLM closed loop (zai coding plan)

> **2026-10-13 起本流程由 `scripts/e2e-real-llm.ts` 承载**：进程内启动真实 dsh host（llm-pi-ai zai 路由，key 仅经环境变量 `ZAI_CODING_CN_API_KEY`），断言确认门控、预算带生成、targetIndex 扇出与自动命名、seal 回签、doc_chain_status 全链对账。`ZAI_CODING_CN_API_KEY=… node --import tsx/esm scripts/e2e-real-llm.ts [--keep]`。**2026-11-03 起脚本另覆盖跨出处链**（步骤 6-8）：把 `examples/packsdir/task-card` 复制进沙箱工作区 `.docwright/packs/`（真实 packsDir lane）后并入同一 pack Map，零参数消费内置 func+tech 产物——断言不立门（全继承）、自有版式、引擎命名 CARD-<topicNo>-<NN>、回执上游锚点指向内置 pack、chain-status 入册、复用命中。以下手工步骤保留为历史验证记录。


Validated 2026-10-11/12 against `zai-coding-cn` (`glm-4.7` pre-dsh-0.2.x, `glm-5.3-flash`
after): doc_generate went green in
1 round (score 100), `doc_validate` replayed with `hashMatches: true`,
`packVersionStale: false`. This runbook reproduces it. No dsh upgrade needed —
`zai-coding-cn` is already in the pi-ai 0.85.1 provider catalog (`ZAI_CODING_CN_API_KEY`,
baseURL `open.bigmodel.cn/api/coding/paas/v4`).

## 1. Build and pack the plugin

```sh
cd ~/projects/lab/docwright && corepack pnpm build && corepack pnpm pack --pack-destination /tmp/docwright-zai
```

## 2. Sandbox a dsh home + profile

```sh
export DSH_HOME=/tmp/docwright-zai/home   # throwaway home; keeps ~/.dsh clean
cd ~/projects/lab/deepseek-harness      # dsh from source (pnpm dsh script)
corepack pnpm dsh plugin --profile e2e add /tmp/docwright-zai/@sharework-ai/dsh-docwright-*.tgz
# e2e needs the one-shot runner, which plugin add does not include — declare the
# headless bundle in profiles/e2e/package.json:
#   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@sharework-ai/dsh-docwright"] } }
```

Gotchas (each cost us time once):

- `--profile` goes AFTER the `plugin` subcommand: `dsh plugin --profile e2e add …`.
  Before it, the invocation routes to profile boot and dies with "profile does not exist".
- The current CLI has no `--template` for plugin mode; `plugin add` initializes a
  base-backed profile. A base-only profile boots, but running tasks needs the headless
  bundle — declare it in `profiles/e2e/package.json` (see above; `scripts/host-smoke.ts`
  skips it because it only boots the tool registry).
- `dsh plugin add` does more than pnpm: it appends bundles declaring `dsh.bundle` to
  `dsh.profile.bundles`. A manual `pnpm add <tgz>` must append `@sharework-ai/dsh-docwright` to that
  list by hand, or the plugin's patch layer never loads (`patch: entry "docwright" not found`).
- Re-adding a SAME-VERSION tarball does not refresh the installed copy (pnpm skips it):
  `dsh plugin --profile <name> remove @sharework-ai/dsh-docwright` first, then add again, or new
  packs/dirs silently stay absent.
- `pnpm --dir <dsh> dsh …` switches cwd to the dsh repo — pin the workspace with the
  docwright `workspaceRoot` config instead of relying on cwd.
- Running dsh sources from a foreign cwd (e.g. a script) needs `TSX_TSCONFIG_PATH`
  pointed at the dsh checkout's `tsconfig.base.json` — its `paths` map `@deepseek-ai/*`
  onto vendored TS sources, and the committed `lib/` outputs can lag. `scripts/host-smoke.ts`
  handles this by respawning itself with the env set.

## 3. Profile patch (`$DSH_HOME/profiles/e2e/cordis.patch.yml`)

```yaml
- id: llm-pi-ai
  config:
    providers:
      zai-coding-cn:
        apiKeyEnv: ZAI_CODING_CN_API_KEY

- id: agent-default-model        # base row pins deepseek-official; headless boots need it routed too
  config:
    provider: zai-coding-cn
    model: glm-5.3-flash

- id: docwright
  config:
    provider: "zai-coding-cn"
    model: "glm-5.3-flash"
    defaultLanguage: "zh-CN"
    workspaceRoot: "/tmp/docwright-zai/ws"
```

## 4. Run

```sh
export ZAI_CODING_CN_API_KEY=<key>   # env only; never commit
export DSH_PERMISSION_MODE=danger-full-access DSH_TELEMETRY_DISABLED=1
mkdir -p /tmp/docwright-zai/ws/references   # put req.md there
cd /tmp/docwright-zai/ws
corepack pnpm --pm-on-fail=ignore --dir ~/projects/lab/deepseek-harness dsh --profile e2e \
  '请调用 doc_generate 工具：pack 用 cosmic-plan，materials 传 ["req.md"]，artifactName 用 e2e-1。报告 receipt 的 isValid/iterations。'
```

`--pm-on-fail=ignore` bypasses the repo's pinned-pnpm version check. Artifacts land in
`/tmp/docwright-zai/ws/output/` (`<name>.json` + `.receipt.json` + `.md`). Follow with a
`doc_validate` task for the deterministic replay (`hashMatches` must be `true`).

## Calibration notes (D2 open questions 1/4)

Multi-round observations, 2026-10-12 (`master` @ T2-core, dsh 0.2.1-alpha.2, key from the
shared zai account in `~/.claude/settings.json` `ANTHROPIC_API_KEY`):

- **Repair path confirmed** (`e2e-multi-1`, legacy-inventory material on glm-4.7): round 1
  kept the material's violations verbatim (4 errors → score 60), round 2 went green (score
  100). Score arithmetic matches the built-in severity weights exactly (100 − 10×error);
  both rounds carry distinct `promptHash` values (initial ≠ repair prompt), so the receipt
  alone reconstructs what each model call saw. `doc_validate` replayed the receipt with
  `hashMatches: true` on the NEWER dsh — receipts are cross-version stable.
- **Round-1 green under strong models** (`e2e-multi-2/3/4` on glm-5.3-flash): three
  violation-inducing framings — contradictory hard constraints, a 12-row violating
  inventory, and a verbatim adopt-this-JSON archive — ALL went green in round 1. The model
  ranks pack rules above material instructions (the guardrail working as designed), so
  repair and stagnation/decline paths (K=D=3) stay exercised by deterministic tests only.
  Observing real-LLM stagnation needs a weaker model or a pack whose rules the model
  genuinely cannot satisfy; defaults (10/3/1, K=D=3) are safely loose for glm-5.3-class
  models.
- **Model catalog note**: dsh 0.2.x pi-ai (1.0.2) retired `glm-4.7`; the zai-coding-cn
  catalog now lists `glm-5.3`, `glm-5.3-flash`, `glm-5.3-highspeed`, `glm-4.6v`. The patch
  above pins `glm-5.3-flash`.
