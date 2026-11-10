# Authoring docwright packs

You are authoring a **docwright pack**: the complete quality contract for one
class of documents, executed by the docwright plugin for deepseek-harness.
A pack = five aligned contracts plus proof that green is reachable:

| asset | declares | enforced |
|---|---|---|
| `manifest.json` | identity, params, scope, chaining | load time (fail loud) |
| `schema.json` | what the document looks like (structure) | every validation (ajv) |
| `rules/<lang>.json` | what "qualified" means (simple families) | every validation |
| `rules/functions.js` | cross-field / cross-artifact rules (optional) | every validation |
| `prompts/<lang>.md` | how to generate | every generation round |
| `templates/<lang>.hbs` | how to render Markdown | every generation |
| `samples/golden.json` | proof that a compliant document exists | `pack:check`, tests |
| `samples/golden.params.json` | param values for golden validation (optional) | `pack:check` only |

The engine gives you for free: the closed repair loop (generate → validate →
fix, with convergence detection and budgets), replayable receipts, the
confirmation gate for params, chain verification of upstream green artifacts,
fan-out addressing, artifact reuse, and Markdown rendering. **The engine never
learns your domain** — everything domain-specific lives in the pack.

Routing note: users often ask for this deliverable as a "skill" ("make me a
document-generation skill"). In docwright that deliverable **is** a pack —
the pack is the skill, upgraded with validation guardrails a bare prompt or
a filesystem SKILL.md can never provide. Do not create a filesystem skill, a
template file, or a one-off prompt instead; author the pack.

Live examples ship beside this guide: the built-in `cosmic-*` packs (a
five-stage COSMIC estimation chain plus a context-sync pack). Read one while
you work; they demonstrate every rule below.

Rule of thumb for every asset you write: **schema says what the document looks
like, rules say what counts as qualified, the prompt mirrors the rules.**
Prompt constraints the rules do not check = decorative guardrails. Rules the
prompt never mentions = blind repair loops.

## Where packs live (write path)

Two lanes; pick explicitly before writing files:

- **Repository lane** (built-in / scenario packs): work in a checkout of the
  docwright repository, packs under `packs/<name>/`. This is the only lane
  where the full test suite (mutation tests, deterministic loop tests, host
  smoke) can run. Merge via feature branch.
- **packsDir lane** (custom packs): the `packsDir` config entry is the only
  install point that does not touch the repository. Convention:
  `<workspace>/.docwright/packs/` (absolute path in cordis.yml). A same-name
  pack there overrides the built-in one. If the directory is inside the
  session workspace you can write it with normal file tools; if outside, ask
  the user to place files or approve the write.

**Loading happens at plugin apply time**: after writing or changing pack
files, the plugin must reload (host restart/reload) before `doc_generate` sees
them. A pack you just authored is never usable in the same session that wrote
it — verify with `pack:check` instead.

## Verify as you go

Run the checker after every asset you complete — never batch to the end:

```sh
pnpm run pack:check -- <packs-root>                # from a docwright repository checkout
pnpm run pack:check -- <packs-root> --with packs   # your pack consumes packs that live in another root (e.g. the built-in packs/)
```

`<packs-root>` is the directory whose SUBDIRECTORIES are packs (e.g. `<workspace>/.docwright/packs/`) — pointing it at one individual pack directory fails confusingly. If the session environment has no pnpm/corepack on PATH, invoke the runner directly (same thing the npm script does):

```sh
node --import tsx/esm /path/to/docwright/scripts/pack-check.ts <packs-root>
```

It runs the real loader gate (manifest, param invariants, regex compilability,
prompt slot presence, language coverage) and then validates every pack's
golden sample per language through the real schema + rules, printing a health
sheet (rule inventory, severity distribution, param table). Exit 0 = green.
Any red means fix now: the message carries the rule id and the fix hint.

Golden validation with required-no-default params: if your rules read a
required param that has no default (e.g. a budget only the user can state),
function rules skip when it is absent, but declarative references fail loud.
Ship `samples/golden.params.json` (a JSON object of `{ paramName: value }`) to
supply values for the golden run only.

## The nine stages

Stages 0-2 and 4-5 are design; 3, 6, 7 produce executable assets; 8-9 are
acceptance. Iterate freely between design and development — never skip
acceptance.

### Design sign-off gates (default: interactive)

A pack is a quality contract the user will live with — the design gets the
user's signature before any file is written. Two checkpoints:

- **Gate 1 — artifact plan (end of Stage 1)**: present the docType list,
  each artifact's granularity (single vs fan-out), reuse classification,
  and the chain sketch. Cheap to fix now, expensive after schemas exist.
- **Gate 2 — design contract table (end of Stage 6, before Stage 3/7
  development writes any file)**: one table covering the schema shape
  (fields, enums, patterns), the **naming triple** (`artifactPrefix` +
  the `topicNoPattern` convention + the `topicNo` declaration — all three
  or none), the param table (with confirm/required/extractable flags),
  `consumes` edges, languages, and `scope`/`requiresTopic`. Wait for the
  user's approval, then write the assets.

If the user asks for speed ("直接做", "一次到位", "别问我"), batch the two
gates into ONE combined table shown before writing files, and summarize the
accepted contract in the final report — but never write pack files with no
presented contract at all.

### Stage 0 — Know the domain

Answer in writing: what documents does this scenario produce, what is the
business flow, who does what at each step? Produce a one-paragraph domain
model (each stage of the flow = one sentence defining its core object) and a
problem statement (what is unguarded today).

Hard contract: domain concepts live ONLY in packs, never in the plugin.

### Stage 1 — Plan the artifacts

List the documents. For each answer: docType name, granularity, reference
relations to other artifacts.

- Granularity: if the count grows linearly with a work object (one output per
  entry of an upstream array — per function, per clause, per requirement), it
  is fan-out granularity. If globally unique (project context, overall plan),
  it is a single artifact.
- Reusability: an artifact reused across work items (project architecture,
  glossary) becomes its own pack, workspace-scoped, `reuse: true` — **a
  reusable output is a pack, not a material** (artifacts are validated,
  anchored, and seal-correctable; materials are not). Knowledge consumed once
  is a material.

### Stage 2 — Design schemas and object relations

One `schema.json` (draft-07 or 2020-12) per artifact: fields, types, enums,
nesting, and the reference keys that anchor artifacts to each other (cosmic
anchors on `funcId`).

- Layering: **schema = structural legality (static); rules = policy
  (param-driven)**. The schema expresses the structural ceiling (context's
  three-level tree is inlined); the actual depth is a param checked by a
  function rule. Closed value sets are schema enums; unconditional
  requirements are schema `required`.
- Nesting boundary: declarative rule paths support only `$` and
  `$.field[*]` (one level). Two-plus nesting (tech's subProcesses) goes to
  function rules — foresee this while designing the schema.
- Omit prototype-era metadata fields (timestamps, human-review flags) unless
  they have generation or validation semantics.

### Stage 3 — Design and develop the rules

Translate domain quality standards into a rule set. Prefer, in order:
schema-expressible (do not write a rule) → declarative families
(`minLength` / `maxLength` / `forbiddenKeywords` / `pattern`) → function rules
(`rules/functions.js`) for cross-field, cross-artifact, nested-scope, or
param-driven checks.

- Severity: `error` = must block (structural breakage, anchor mismatch,
  budget violation, uniqueness conflicts); `warning` = quality flaw (verbose
  descriptions, caution words); `info` = style advice. Be frugal: one
  parameterized rule can subsume a family of ad-hoc rules.
- **Severity is rule-level, not issue-level**: the engine stamps every issue
  a function rule returns with the rule's declared severity — a per-issue
  severity field is ignored. A "configurable strictness" policy (e.g. a
  `coveragePolicy` param where strict = error, tolerant = warning) is
  therefore TWO rules: one per severity, each reading the param and skipping
  (returning `[]`) when the policy selects the other one.
- **Every rule carries a `suggestion` written as a fix instruction**, not a
  problem description — it feeds the repair loop's prompt.
- Every rule must be mutation-testable: if you cannot construct a broken
  sample the rule must catch, the rule is decorative — drop or redesign it.
- Parameterize bounds and regex sources with `{ "param": "<name>" }` when the
  threshold is a deployment preference rather than a domain constant.
  Declared regex params: empty string = check off; non-empty must compile
  (checked at load time).
- Cross-artifact rules: function rules receive `context.upstream` (parsed
  upstream artifacts). If a consumed upstream is missing or of the wrong
  type, fail loud — never skip silently.

**Function-rule programming contract**: `rules/functions.js` is a plain
Node-loadable ESM JavaScript module — no build step, no TypeScript, no npm
dependencies, **no `import` statements** (inline your helpers). Export a
`rules` array; each entry `{ id, severity (default "error"), suggestion,
check(artifact, context?) }`; `check` returns `RuleIssue[]`
(`{ jsonPath, message, snapshot? }`; empty array = pass). Rules MUST be pure
and deterministic (output depends only on artifact and context — no I/O, no
clock, no randomness): the engine snapshots the file's sha256 into receipts,
so re-validation must reproduce the verdict. Convention: rule ids are namespaced
`<short-name>/<slug>` (e.g. `plan/cfp-total-band`).

**Scoring — the unified model, for free**: convergence scoring defaults to a
built-in severity deduction — `100 − 10×error − 3×warning − 1×info`, clamped
to 0-100. **Do not export a custom score** unless a domain weight genuinely
differs (a warning that is near-fatal in your domain); then export
`score(artifact, issues) => 0-100` from `functions.js`. A score only informs
early termination — green is ALWAYS zero errors — and a crashing or
out-of-range score fails loud.

### Stage 4 — Classify inputs, outputs, reusables

- Materials: rendered into the prompt's `{{materials}}` slot. Separate by
  semantics via `materialsRoot`: `references` = project reference knowledge
  shared across work items; `input` = the user's per-work-item input document.
  Never mix the two.
- Upstream: hard dependency → `consumes` (tool-verified green receipts);
  optional background → rider (the caller passes it in `upstream`; your rules
  must tolerate absence) or explicit assumption registration.
- Artifacts: `scope: "topic"` (default; lands under `<topic>/output/`) vs
  `"workspace"` (project-level directory, ignores topic). `requiresTopic:
  true` pins one-work-item-per-topic. `artifactPrefix` hands naming to the
  engine (`<PREFIX>-<topicNo>` for whole-scope, `<PREFIX>-<topicNo>-<NN>` for
  fan-out items) — **but only when `topicNo` resolves**: the derivation
  contract is a PAIR of params. The chain head declares `topicNoPattern`
  (required + default, the numbering convention comes from project reference
  materials) and `topicNo` (type + description — derived by the engine);
  downstream packs re-declare both to inherit (no defaults: a default on a
  re-declaration would be dead data, and a required-no-default one would
  demand the value from every caller, including golden runs). A prefix
  without the pair silently degrades to timestamp names — declare all or
  none; `pack:check` fails the mismatch, and the loader rejects a
  `topicNoPattern` without its `topicNo` on a topic-scope pack (a matching
  topic injects the derived topicNo into params, which rejects undeclared
  names). Never pass
  `topicNoPattern` through doc_generate params — it is refused: the pattern
  is the pack's standing convention, and a caller-supplied one that fails to
  match the topic silently degrades naming.
- Reuse: defaults follow scope (workspace true / topic false). Declaring
  `reuse: true` on a topic pack requires every input class to be anchor-
  verifiable (materials manifest, upstream hashes, param drift policy).
  Action packs (merges, syncs) declare `reuse: false`.

### Stage 5 — Decompose into packs and design the chain

Pack boundary = artifact boundary, not business-stage boundary. Each pack
closes its own loop (generate → validate → repair).

- Chain: `consumes` declares the DAG. Merge/back-flow actions are their own
  pack consuming two upstreams. Two fan-out addressing modes exist — pick
  one per scenario:
  - **Engine fan-out (mode A)**: the upstream planning array is named
    `functions` with a `funcId` per entry (the engine's `planCandidates`
    is hard-wired to that shape). You get `targetIndex` addressing,
    `<PREFIX>-<topicNo>-<NN>` engine naming, and a `doc_chain_status`
    coverage matrix. Right when your domain vocabulary matches (or tolerates)
    the `functions`/`funcId` shape.
  - **Param addressing (mode B)**: the planning array uses your domain
    vocabulary (e.g. `epics[]` + `code`). The downstream pack declares a
    required-no-default addressing param (e.g. `epicCode`) and the caller
    addresses each item with a deterministic `artifactName`
    (`<pack>-<code>`); reuse stays idempotent via the explicit-name
    comparison. Note: `doc_chain_status` reports `declares no functions[]`
    for mode-B chains — coverage accounting then lives in your
    cross-artifact rules (reconcile every upstream entry in the downstream
    artifact), not in the chain tool.
  Whichever mode: anchor by index or identity, never by prose similarity.
- Check what exists first: `doc_packs` may already cover the document type;
  org-specific tuning of an existing type = same-name packsDir override, not
  a fork. Chain-level shared params (numbering conventions, tree depth) are
  declared once at the chain head and inherited via receipts.

### Stage 6 — Design the params

Walk each candidate param through: type (scalar / object budget shape) →
`required` without default (ONLY for quantities that come exclusively from
user intent) vs a default (the standing value) → `confirm` (must pass the
confirmation gate) → `overridable` (materials may adjust; requires
`confirm`) → `extractable` (materials may self-prove via verbatim quote;
requires `confirm`; never on fan-out addressing params) → `enum`/`min`/`max`.

- **Mind the gap**: only the generation target (the object's `value`) enters
  the model-visible effective params; band endpoints are validation tolerance
  and live in rules and receipts. An endpoint that IS generation semantics
  becomes its own scalar param.
- Inherited params (re-declaring a chain-head param downstream) must NOT
  carry a default — receipt inheritance always wins; a default would be dead
  data.
- Params referenced by declarative-rule bounds or pattern sources must be
  always-present (default or required) and must NOT be `overridable`.
- Restraint: few params beat many; template-hardcoded "recommended values"
  must yield to params (the prompt says "per effective params").

### Stage 7 — Write the prompts and templates

One prompt per language. Skeleton (see `packs/cosmic-plan/prompts/`):
role/scene sentence → domain model section (**one pack, one vocabulary** —
only this stage's concepts) → output requirements (each field, where its
value comes from) → hard constraints (**the mirror of your rule set**) →
`{{materials}}`, `{{upstream}}`, `{{params}}` slots (missing `{{materials}}`
fails at load time).

Hard contract: hard constraints state only things rules can check, and cover
everything rules check. Bilingual packs: keep structure identical across
languages; only wording differs.

Template (Handlebars): renders the artifact for humans; follow the schema's
shape; no validation semantics.

### Stage 8 — Verify (the ladder, cheap to expensive)

1. **`pack:check -- <dir>`** (layers 1-2): loader gate + per-language golden
   green + health sheet. Run after every asset, fix reds immediately.
2. **Mutation tests**: for every rule family, corrupt the golden
   sample deliberately, assert the checker catches it — one corruption per
   family, corrupt → validate → expect the rule id. On
   the packsDir lane, write a small throwaway script next to the packs
   (e.g. `<workspace>/.docwright/mutate-test.mts`) and run it from the
   docwright checkout: import `loadPacks` from `src/pack-loader.ts` and
   `DocService` from `src/doc-service.ts`, clone each golden, apply one
   corruption per rule family, call `service.validate(cloned, params,
   { upstream: [consumedGolden] })`, and assert the expected rule id appears.
   Mind two engine facts: function-rule issues carry the RULE's declared
   severity, and cross-artifact rules fail loud without upstream — mutate
   through the same entry point real validation uses.
3. **Deterministic loop test** (repo lane): scripted LLM seam feeds broken
   JSON through `doc_generate`; assert the repair loop converges, the receipt
   fields (hashes, params, rounds) are correct, termination reasons are right.
4. **Host smoke** (repo lane): `pnpm run smoke:host` — the packed plugin must
   boot in a real dsh host with all tools registered (no model call).
5. **Real e2e** (both lanes): run the plugin against a real model.
   - CLI: create a dsh profile, point `packsDir` at your pack directory,
     boot `dsh --profile <name>` and drive a generation task with real
     materials; confirm the artifact + green receipt land under the output
     root.
   - dsh web: install/reload the plugin (restart so apply re-runs), then in a
     session drive the generation and OBSERVE: the confirmation gate presents
     the param table before the first generation (unless confirmPolicy is
     none), the repair loop converges, the receipt is green, reuse returns
     `reused: true` with zero model rounds on a second identical call, and
     `doc_chain_status` accounts for every fan-out item.
   A pack is not done because rules are green — it is done when a real model
   converges inside the loop you designed.

### Stage 9 — Register and document

- `version` starts at 0.1.0; any change to rule semantics bumps the version
  (old receipts become stale and chains re-generate — that is the point).
- `description`: bilingual (`{ "en": "...", "zh": "..." }`); the `en` line is
  what the model sees in `doc_packs` — state what the pack generates, what it
  consumes, and its granularity, in one sentence.
- Repository lane: feature branch, full gates (tests, coverage, typecheck,
  build), merge, README/manual section, changelog entry. packsDir lane: the
  health sheet from `pack:check` plus the real e2e observation log are the
  deliverable record.

## Final gate (every box checked)

- [ ] `pack:check` green on the pack directory (all languages)
- [ ] Every rule family has a mutation that is caught (repo lane: in the test suite)
- [ ] Prompt hard constraints mirror the rule set; slots present
- [ ] Params walk complete (no dead defaults; invariants hold — the loader verifies)
- [ ] required-no-default params covered by `golden.params.json` if rules read them
- [ ] Real-model e2e observed: gate → converge → green receipt (+ reuse + chain status for chained packs)
- [ ] Version, bilingual description, and the health sheet recorded
