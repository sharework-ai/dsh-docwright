# AGENTS.md

docwright is a deepseek-harness (dsh) plugin: closed-loop document generation with domain rule packs and replayable receipts. Spec truth source: `docs/designs/docwright-mvp.md` (current-state functional spec: tool semantics, loop behavior, receipt fields, plugin-vs-pack boundary; the original 44-decision audit trail lives in git history).

## Layout

```
src/        plugin code (entry: index.ts; loop.ts is the core repair loop)
packs/      built-in packs (cosmic-plan/req/func/tech; hybrid JSON rules + JS functions)
examples/   runnable examples — packsdir/task-card is a NON-builtin pack consuming the builtin cosmic chain (see below)
tests/      vitest; coverage gate 100% lines/functions/statements, 80% branches
docs/       design doc + test plan
```

## Cross-boundary chaining (packsDir pack consuming the builtin chain)

A packsDir pack (`config.packsDir`, convention `<workspace>/.docwright/packs/`) consumes builtin pack artifacts like any builtin pack — nothing is builtin-gated: `consumes` resolves by name over ONE merged pack map (builtin root + packsDir roots); upstream receipts verify green+hash+version against the installed upstream pack; params declared without defaults inherit from the upstream receipts' as-run params (topicNo/topicNoPattern/targetIndex/…); the confirmation gate does not re-fire mid-chain (whole-chain-one-interaction holds across the boundary); `doc_chain_status` walks consumes edges, so packsDir packs join coverage accounting automatically. Authoring rules for this lane: `docs/designs/pack-authoring.md` (packsDir lane, `pack:check -- <root> --with packs`). Runnable example with the mechanism table: `examples/packsdir/README.md`; exercised end-to-end by `scripts/e2e-real-llm.ts` steps 6-8 against a real model.

## Commands

```sh
pnpm test               # vitest
pnpm test:coverage      # coverage gate
pnpm run build          # tsc -b + tsdown
npx tsc -b tsconfig.json  # typecheck only
pnpm run smoke:host     # pre-release: pack → real dsh host boot → tool assertions (no API key)
```

**After every dsh update** (sibling checkout fast-forwarded: `pnpm install` + `pnpm run build` there, then here): run `npx tsc -b` FIRST. Module-identity breaks surface here before anywhere else — the linked dsh packages augment `@deepseek-ai/cordis` by module name, so a vendor bump (e.g. cordis 4.1.0) with docwright resolving the same name to a different copy (npm) splits one module into two file sets and the augmentation lands on the other copy: typecheck fails with `Property 'X' does not exist on type 'Context'` while unit tests may still pass. Fix is identity alignment (devDependency `link:` to the dsh-vendored package — see `pnpm-workspace.yaml` overrides), then the normal gates.

## Conventions (inherited from deepseek-harness/AGENTS.md)

- ESM everywhere; relative imports use `.ts` extensions (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`).
- Registrations are effects (`ctx.tools.register` disposes with the fiber).
- Misconfiguration fails loud at plugin apply (bad manifest/ruleset/language).
- No hardcoded tunables: everything deployment-varying is a Config field.
- `@deepseek-ai/*` are peerDependencies; devDependencies use local `link:` targets under `../deepseek-harness` (bare symlinks; a sibling dsh checkout must be installed and `build:lib:host`-built first) because the published npm line is incomplete (see README Development note).
- Errors follow problem + cause + fix, with available options where applicable (unknown pack lists packs; bad language lists supported ones).
- The repair loop is the product: every change to loop.ts needs a deterministic test (scripted LlmPort; no live model in unit tests).
- Docs discipline: specs stay current-state (no design history); design docs lead with the final design and record rejected approaches in a closed appendix as named veto principles (see docs/designs/*).

## Testing policy

- Loop/tool tests mock the LLM seam (`LlmPort`) with scripted replies.
- Every rule family in every pack ships with mutation tests (corrupt the golden sample; assert the checker catches it).
- Receipts are verified by re-hashing (key-order independent canonical JSON).

## Real-session testing via headless browser (self-serve, no human needed)

Unit tests mock the LLM seam and call `execute()` directly, so they miss
call-shape bugs a real session hits (e.g. the derived-`topicNo` validation
failure was invisible to tests). Run a real end-to-end against the local dsh
web service with the gstack headless browser — this is fully scriptable and
must be done by the agent itself after any tool-contract change.

**Prerequisites (one-time per test round):**

1. Build + restart so the web service loads the new bundle (only restart
   without build = old code): `pnpm run build` then
   `bash ~/workspaces/doc-harness/scripts/dsh-web.sh restart`; wait ~12s, get
   the URL: `.../dsh-web.sh url` (prints `https://dsh.shrwk.com/?token=...`).
2. Prepare the workspace `~/文档/deepseek-harness/default-workspace/`:
   `input/` = the user's requirement doc (`req.md`), `references/` = project
   reference knowledge; CLEAN previous outputs per test need:
   `rm -rf context/* <topic>/output/*` (old receipts also self-invalidate via
   the version gate / missing materials manifest, but cleaning makes
   assertions unambiguous).

**Driving the UI** (gstack headless browser at
`~/.claude/skills/gstack/browse/dist/browse`, below `$B`):

```sh
$B goto "<url-with-token>"     # token URL IS the auth; headless needs no cookies
$B snapshot -i                 # interactive refs (@eN); re-snapshot after every action
$B click @e10                  # workspace treeitem "默认工作区" — click selects + expands,
                               # and auto-creates/selects a "新会话"
$B fill @e22 "<message>"       # composer is a CONTENTEDITABLE DIV, not a textarea —
                               # plain fill sets the value but the framework ignores it
$B js "document.querySelector('[contenteditable=true]').dispatchEvent(new InputEvent('input',{bubbles:true}))"
                               # <- REQUIRED after fill, or the send button stays disabled
$B click @eN                   # then click 发送消息
$B text                        # read the conversation; poll with sleep loops for LLM rounds
```

Gotchas learned the hard way:

- A "预览版说明" modal can block clicks (5s timeouts): dismiss the 继续 button
  first if clicks time out.
- `snapshot` refs go stale after navigation/updates — always re-snapshot
  before clicking.
- One real LLM round is 10-90s; poll `$B text` in a sleep loop (20s ticks)
  and grep for the expected reply markers (tool-call names, `reused`,
  `pendingConfirmation`, error strings) instead of fixed sleeps.
- React-controlled inputs ignore plain `fill` (the framework's value tracker
  drops the change): drive selects/inputs with the native setter after
  resetting the tracker, then dispatch a bubbling event —
  `const t = el._valueTracker; if (t) t.setValue(oldValue);
   Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el, newValue);
   el.dispatchEvent(new Event('change', { bubbles: true }))`. A save button
  that stays disabled after a fill means the React state never moved.
- Host primitives take 0.2.1 prop shapes: `Tooltip`'s `label` is a plain
  STRING (rendered verbatim). Passing `{ content }` (the 0.1.0-rc.6 shape
  dsh-market's typings suggest) throws React #31 and the host tears the
  whole slot entry down until a hard reload ("slot entry crashed" in the
  console). A slot that vanishes after an interaction = check console for
  React errors before re-driving the UI.
- The Settings dialog lives in the account menu (更多 → 设置); the docwright
  params tab is inside Settings → 内置插件 (settings.plugins.tab seat), and
  the params card also renders on the bundle's own Plugins page
  (plugins.bundle.config seat). Server-side effects are asserted on DISK and
  via in-page `fetch('/api/docwright/...')` (the browser session carries the
  login the host gate requires; plain curl answers 401).
- Verify engine-level effects on DISK, not only in the UI: receipts under
  `context/` and `<topic>/output/*.receipt.json` show `materials` manifests,
  `isValid`, `packVersion`, `upstreamHashes`; a reused call must leave the
  artifact bytes unchanged and make zero LLM rounds (the session UI shows
  the round/step counters).

**Standard scenario (covers the reuse + topic + input-dir contracts):**

1. Send a requirement message WITHOUT a topic → the agent must ask for the
   topic explicitly (never invent one).
2. Reply with the topic (`KERQ-352 收藏夹`) → agent runs context (from
   `references/`) → plan (from `input/`, topic-level shadows workspace-level)
   → req with `targetIndex`.
3. Ask again to regenerate context and re-run req → both must return
   `reused: true` with zero LLM rounds; check the receipts on disk.
4. Screenshot evidence optional; disk receipts are the authoritative
   assertion.

**Pack-authoring e2e (two-hop routing: a "make a skill" request into a pack, then a plain usage request into the pack):**

Verifies the full authoring loop a user actually drives: "帮我做一个生成X的技能" must
route into `docwright-pack-authoring` (never a filesystem SKILL.md or a hand-written
template), the authored pack must pass the ladder, and — after a reload — a usage
request that never names the pack must find it via `doc_packs` and generate green.

1. New session, send an authoring prompt (generic phrasing; the plugin claims no
   specific document type anywhere):
   `帮我做一个生成X的技能，要求包含<字段清单>。技能完成后，即帮我进行尝试`
   Assert: the FIRST routing step is loading the `docwright-pack-authoring` skill;
   the pack lands under `<workspace>/.docwright/packs/<name>/` (manifest, schema,
   rules, prompts, templates, golden); `pack:check` runs green; a mutation
   self-test exercises every rule family; the model explains the reload gate
   (doc_generate returning `unknown pack` in-session is the loud, correct error)
   instead of claiming the pack is usable immediately.
2. Restart the web service (`dsh-web.sh restart`) so plugin apply re-loads
   packsDir; sessions survive the restart — continue the SAME session.
3. Send a usage prompt that never names the pack (second-hop routing):
   `帮我编写一份X，<完整素材>` — Assert: `doc_packs` lists the pack; the
   confirmation gate behaves per policy (an inferred topic row may be stated
   inline and confirmed; param-value tables must stop and wait for the user);
   `doc_generate` converges; the on-disk receipt under `<topic>/output/` is
   `isValid: true` with a score of 100.
4. Known first-run trap: a pack declaring `artifactPrefix` without a
   `topicNoPattern` param degrades silently to timestamp names — `pack:check`
   fails the pairing; fix by declaring the pattern at the chain head or
   dropping the prefix.
