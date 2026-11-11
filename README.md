# docwright

Document generation for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): a pack defines one document type (JSON schema, validation rules, generation prompt), packs chain into multi-stage scenarios, tunable params pass a confirmation gate before generation, every document ships with a replayable validation receipt, and a bundled skill teaches the agent to author new packs.

JSON is the single source of truth. Every generated document is validated against its pack's JSON Schema and rule set; failures are fed back to the model for repair until all rules pass (or the loop exhausts and keeps a red-marked draft). Every document ships with a machine-readable receipt anyone can re-verify.

## Quickstart (deterministic, ~2 minutes, no API key)

```sh
dsh plugin add @sharework-ai/dsh-docwright    # 1. install the bundle into your profile
node install.mjs cosmic-plan --into .docwright/packs   # 2. install the pack from the market (dm.shrwk.com)
dsh                                  # 3. start a session with the profile
```

Copy the pack's golden sample (`packs/cosmic-plan/samples/golden.json` in the market archive) into your workspace, then in the session:

```
> doc_validate(artifactPath: "sample.json", pack: "cosmic-plan")
```

You get an all-green receipt in seconds — zero LLM calls. This is the deterministic first-run moment; `doc_generate` (the closed loop) is step two. In-session, discovery is three-layered: `doc_packs` lists installed packs; when none fits, `doc_market_search` looks the pack market up (deployment param `marketSearch`, default on) and `doc_market_install` lands a hit behind the user's confirmation — usable in the same session; when nothing on the market fits either, the bundled authoring skill writes a new pack.

## Tools

### `doc_packs`

Zero-arg discovery tool: lists installed packs as `[{ name, version, description, languages, consumes, params }]` (params = the pack's declared tunables with type, description, optional default, and the `required`/`confirm`/`overridable`/`extractable` flags). The model-facing descriptions of `doc_generate`/`doc_validate` carry a static invitation to call `doc_packs` first; unknown-pack errors also point there. Descriptions never change with the pack set (pull-based progressive disclosure).

### `doc_generate`

| Parameter | Type | Notes |
|---|---|---|
| `pack` | string | e.g. `cosmic-plan`; unknown names list available packs |
| `materials` | string[]? | paths relative to the materials root (default `<workspace>/references/`), or inline text starting with `#!inline`; optional for chained packs whose upstream carries the context |
| `language` | string? | default: config `defaultLanguage`, else the pack's first language |
| `upstream` | string[]? | workspace-relative paths to upstream artifacts; each must carry a green sidecar receipt (hash-verified, pack type matched against `consumes`, and recording the installed pack version — see `upstreamVersionPolicy`). Extra green artifacts of installed packs may ride along as prompt context (e.g. the project context beside a plan); at least one consumed type is required |
| `artifactName` | string? | output base name (default `<pack>-<timestamp>`); refused on packs with an `artifactPrefix` (PLAN/REQ/FUNC/TECH) — those are engine-named `<PREFIX>-<topicNo>` (whole-requirement) and `<PREFIX>-<topicNo>-<NN>` (per-function; NN = the two-digit right-aligned targetIndex); topicNo comes from the topic name via the pack's `topicNoPattern` regex |
| `maxRounds` | number? | round cap for this call (user intent via the model); clamped to config `maxRoundsCeiling` |
| `topic` | string? | topic directory name (a plain `[A-Za-z0-9._-]` segment, e.g. the requirement id): relocates the output root to `<topic>/output/` and the materials root to `<topic>/references/`; REQUIRED by the cosmic chain stages (plan/req/func/tech — one requirement per topic), ignored by workspace-scope packs |
| `force` | boolean? | bypass the reuse pre-check and rebuild |
| `params` | object? | overrides for pack-declared tunables (see `doc_packs`); unknown names, out-of-range values, and missing required (default-less) params fail loud; **passing params that change the upstream-recorded values triggers the confirmation gate** — re-passing upstream-identical values counts as inheritance; gate level tunable via `confirmPolicy` (config or per-call: `none`/`standard`/`strict`) |
| `confirm` | boolean? | execute after the `pendingConfirmation` param table was presented to and approved by the user |

Per-function fan-out (`docs/designs/params-and-chain-contract.md`): chained packs declare a required `targetIndex` (1-based position in the upstream plan's `functions[]`); a missing one fails loud with the full candidate list (index, funcId, l2Name). Calls without an explicit `artifactName` default to `<pack>-<funcId>` (or `<PREFIX>-<topicNo>-<NN>` when the pack declares an `artifactPrefix` — funcId itself is `<topicNo>-<NN>`, numbered by rule plan/func-id-numbering) so distinct functions never collide; results carry a `coverage` line (`{ covered, total, missing }`) showing how much of the reference function set this stage has already produced. `doc_chain_status` gives the whole-chain matrix.

Returns `{ artifactPath, markdownPath, receipt }`. Artifacts, receipts, and markdown land in the output root (default `<workspace>/output/`, or `<topic>/output/` with `topic`). Exhausted loops throw AND keep the draft + red receipt on disk.

**Scopes & reuse** (`docs/designs/cosmic-context.md`): packs declare `scope` (`workspace` packs fix their homes — materials `references/`, artifacts `context/` — and ignore `topic`; `topic` scope is the default) and `reuse` (workspace packs default true, topic packs false). For `reuse` packs, a green, hash-intact artifact of the same pack and installed version that was generated from exactly the call's inputs (the receipt records a materials manifest of canonical refs + content hashes; chained packs additionally compare upstream anchors and the addressed artifact name; changed, added, or dropped materials, a regenerated upstream, or a different addressed name regenerate) is returned as-is (`reused: true`, zero LLM); `force: true` always rebuilds — a human-corrected artifact changes the hash and therefore regenerates, and `doc_validate`'s seal (which carries the manifest forward) re-enters it into the chain.

### `doc_extract_params`

Material param extraction with machine-checkable provenance (`docs/designs/params-and-chain-contract.md`, extract-params). For packs whose manifest marks params `extractable: true` (see `doc_packs`), run this BEFORE `doc_generate`: for each extractable param propose `{ value, quote }` — `quote` must be a verbatim excerpt of the materials (whitespace-insensitive; the engine verifies and refuses unproven values) — or `{ notFound: true }`, optionally with a `suggestion`/`rationale` for the user to endorse (never auto-applied). "Not found" is a first-class result: a required param left notFound is intercepted before generation and must be asked from the user — the materials must not be silently substituted for. Results persist as `<pack>.extracted.json` next to the pack's artifacts; `doc_generate` re-verifies every quote against the generation-time materials, so changed materials invalidate unproven entries, and a re-extracted different value bypasses the reuse pre-check (the receipt's as-run params no longer match) and reaches the confirmation gate.

### `doc_validate`

Re-runs the ruleset over an existing artifact — deterministic, no LLM. `artifactPath` is workspace-relative (e.g. `output/plan-123.json`). Returns a fresh receipt; a hash mismatch means the artifact changed after generation.

**Sealing**: a green validation re-issues (seals) the sidecar receipt for the current content (`sealed: true`) — externally edited artifacts that revalidate green rejoin the chain without regeneration. A red validation never touches the sidecar. Results also carry a best-effort artifact `summary` (counts and totalCfps).

Also returns `packVersionStale`: `true` when the sidecar receipt was written by a different pack version — the artifact predates the installed pack and its green receipt certifies the OLD rules, so regenerate; `false` when versions match; `null` when no receipt exists.

Validation replays by the receipt-recorded as-run pack params (original standards); pass `params` explicitly for what-if checks.

Chained packs accept an optional `upstream` string[] (the same paths used at generation): it re-runs the green-receipt verification and feeds the parsed artifacts into function rules, so cross-artifact rules (e.g. cosmic-req's plan-alignment) replay too — the fresh receipt then records the `upstreamHashes` anchors. Omitting it leaves those rules failing loud with a message that points here.

### `doc_chain_status`

Per-function fan-out accounting — deterministic, no LLM. Pass `plan` (workspace-relative path to a green plan artifact); the tool walks the consuming stages via each pack's `consumes`, scans the output root for green per-function artifacts, and returns the coverage matrix: which plan functions have artifacts at which stage, per-stage `{ covered, total }` counts, and any `orphaned` green artifacts whose funcId matches no plan function. Run it before presenting a fan-out chain as complete.

## Configuration (cordis.yml)

```yaml
- id: docwright
  config:
    packsDir: ""            # where market-installed packs land; same-name packs override built-ins
    marketSearch: true      # doc_market_search tool + market-lookup hints when no installed pack fits
    marketUrl: ""           # pack market the params UI checks updates and the Plugins-page tab serve (default: https://dm.shrwk.com)
    workspaceRoot: ""       # fallback root when no session workspace (default: cwd)
    materialsRoot: ""       # material reference root (default: <workspace>/references)
    outputRoot: ""          # artifact output root (default: <workspace>/output)
    defaultLanguage: "zh-CN"
    maxIterations: 5        # repair-loop global default rounds
    maxRoundsCeiling: 10    # absolute round cap no override can pierce (host-operator owned)
    promptTokenBudget: 60000
    upstreamVersionPolicy: "strict"  # chained upstream pack-version mismatch: "strict" rejects, "warn" proceeds with upstreamWarnings
    confirmPolicy: "standard"  # confirmation gate: "none" never gates (headless/CI), "standard" gates on param changes, "strict" gates every call
    oscillation:            # repair-loop early-exit policy (docs/designs/convergence-detection.md)
      mode: auto            # auto | score | fingerprint
      stagnantRounds: 3     # consecutive rounds without beating the best score
      decliningRounds: 3    # consecutive strictly-decreasing rounds
      maxRepeats: 3         # fingerprint fallback: consecutive identical fingerprints
      epsilon: 0
      defaultScore: { error: 10, warning: 3, info: 1 }
    provider: "deepseek-official"  # an LLM route registered in the host (required)
    model: "deepseek-chat"
```

**Workspace & roots**: the per-call workspace root is the session's workspace directory (the conversation's cwd — e.g. the folder picked in the dsh web UI), falling back to `workspaceRoot`, then the process cwd. `materialsRoot`/`outputRoot` may be relative (joined to the workspace root) or absolute, but must resolve INSIDE the workspace root — anything else fails loud. Material references resolve against `materialsRoot`; artifact writes (and returned `artifactPath` values) live under `outputRoot`. Containment, tamper-evident receipts, and upstream chain verification all hold against the workspace root regardless of root customization. On Linux hosts, Windows drive-letter paths (`D:\x\y` / `d:/x/y`) passed to any path parameter are normalized to their WSL mounts via the `wslpath` binary when available (respecting custom mount roots), with a default-mount regex (`/mnt/<drive>/`) as fallback.

**Provider route names**: `provider` must name a route registered in the host's LLM composition. The bundled `dsh-llm-deepseek` adapter registers as `deepseek-official` (not `deepseek`); `dsh-llm-pi-ai` registers one route per configured provider profile. An unknown route surfaces as an empty stream (`NO_ADAPTER`), not a loud error — if `doc_generate` reports an llm-error on round 1, check the adapter's registered route name first.

## Packs

Hybrid packs: declarative JSON rules for simple families, JS functions for cross-field rules. The plugin ships ZERO builtin packs — packs are content, distributed through the pack market (`dm.shrwk.com`); the engine + discovery + authoring skill are the npm package. The COSMIC family lives in this repo's `packs/` as its authoring source (also the verifier's `--with` fixture) and is published to the market.

Six market packs cover the COSMIC flow (`cosmic-context` → `cosmic-plan` → `cosmic-req` → `cosmic-func` → `cosmic-tech`, plus `cosmic-context-sync`): context = the workspace-level project context (module tree with codes, roles, third-party systems, ID conventions, design principles; model assumptions explicitly registered), plan = module-change planning (functions hang off modules — one module may carry several; `changeKind` reconciled against the context tree by module name), req = per-function requirements analysis (functional users with kind + user stories — the flow-analysis source — and business rules), func = functional-process design (originator/receiver/origination event per process), tech = the data-movement breakdown whose sequences must follow the three audit-safe patterns `ERX`/`EW`/`EX` (≈2.5 movements per process) and whose total CFPs must never fall below the plan estimate (upper tolerance from the budget's `upFactor`). Downstream stages re-anchor `index`/`funcId`/`desiredCfps` to their parent. `cosmic-context-sync` merges one topic's green plan back into the workspace context so project knowledge evolves with requirements (usable once the plan stage passes).

```
packs/cosmic-plan/
├── manifest.json     # name, version, description (LocalizedText: one line or a {en, zh} map; doc_packs projects the en entry to models), consumes, languages, maxRounds?, params?
├── schema.json       # draft-07 JSON Schema
├── rules/zh-CN.json  # declarative: minLength / maxLength / forbiddenKeywords / pattern (literal regex or { "param": "..." })
├── rules/functions.js# export const rules = [{ id, severity, suggestion, check(artifact) }]; optional export function score(artifact, issues) => 0-100 (convergence scoring)
├── prompts/zh-CN.md  # generator prompt with {{materials}} / {{upstream}} slots
├── templates/zh-CN.hbs
└── samples/golden.json  # must pass all-green; feeds mutation tests
```

**Pack contract:** `manifest.description` is required and names the document this pack generates — a one-line string or a LocalizedText map (`{ "en": ..., "zh": ... }`, en entry mandatory as the fallback; cosmic packs ship both; load-time enforced; `doc_packs` projects the en entry to the model regardless of UI locale); `manifest.params` declares the pack's tunables (declaration IS the allowlist — `{ type: number|string|boolean|object, default?, description (same LocalizedText shape), enum?, min?, max?, required?, overridable?, confirm?, extractable? }` per param; load-time invariants: `overridable` and `extractable` each require `confirm` (an adjustable baseline and an extracted value must both pass the confirmation gate), and params referenced by declarative rules (numeric bounds or pattern sources) must not be `overridable`; `required: true` forbids a default; optional params may omit the default (inherited-or-explicit only); declarative-rule numeric bounds may reference number params and `pattern` rules may reference string params via `{ "param": "name" }` — the referenced param must always be present (default or required), a non-empty pattern default must compile, and at check time an empty value disables the rule while a set value must be matched); `manifest.paramDriftPolicy` (`regenerate` default | `revalidate`) sets the param-drift stance; `manifest.maxRounds` optionally sets the pack's default loop rounds; every ERROR rule carries a `suggestion`; every language in `manifest.languages` provides rules + prompt + template; golden sample + per-rule-family mutations are mandatory (a checker that cannot catch a deliberately broken sample is decoration). Function rules receive an optional second argument `context = { upstream, materials, params }` — parsed upstream artifacts, raw material texts, and effective params — for cross-artifact and allowlist checks (see `docs/designs/function-rule-context.md`); single-argument rules keep working unchanged.

**Pack authoring** is a first-class plugin capability (docs/designs/pack-authoring.md): when no installed pack fits a document type, the model loads the bundled `docwright-pack-authoring` skill (registered at apply time on the host's skills registry; the playbook ships in `guides/`) and walks a nine-stage flow — domain analysis, artifact planning, schema, rules (plain Node-loadable ESM JS in `rules/functions.js`; the built-in severity deduction `100 − 10×error − 3×warning − 1×info` is the default convergence score), params, chain design, verification, registration. The verification shortcut is `pnpm run pack:check -- <packs-dir> [--with <other-root>]...`: the real loader gate plus per-language golden green through the real DocService (chain packs use their consumed packs' golden samples as upstream; `samples/golden.params.json` supplies required-no-default params for the golden run). Local packs install via the `packsDir` config (convention: `<workspace>/.docwright/packs/`); a same-name pack there overrides a built-in one. Packs load at apply time — reload the plugin after writing files.

## Docs

- [Functional spec](docs/designs/docwright-mvp.md) — current-state behavior: tool semantics, loop and receipt details, and the plugin-vs-pack responsibility boundary (what the engine does vs. what a pack author writes).
- [Design docs](docs/designs/) — D1 pack discovery, D2 convergence detection, D3 parameter bridge (all implemented; kept for rationale and veto principles).
- [Real-LLM e2e runbook](docs/testing/e2e-real-llm.md) — reproduce the closed loop against a live provider (zai coding plan).

## Development

Requires a sibling checkout of [deepseek-harness](https://github.com/sharework-ai/deepseek-harness) at `../deepseek-harness`:

```sh
# one-time, inside ../deepseek-harness: install deps and build the lib/ outputs
corepack pnpm install && corepack pnpm run build:lib:host

# then, in this repo
corepack pnpm install
corepack pnpm test            # vitest, coverage gate 100% lines/functions/statements
corepack pnpm run build       # tsc + tsdown
corepack pnpm run smoke:host  # pre-release: pack → real dsh host boot → tool assertions (no API key)
```

**Note on devDependencies:** `@deepseek-ai/dsh-*` packages link to the local `deepseek-harness` checkout via `link:` (a bare symlink: `file:` would try to resolve dsh's `workspace:*` internals, which only resolve inside the dsh workspace). The linked packages' `exports` point at their `lib/` build outputs, hence the one-time dsh build above. `pnpm-workspace.yaml` overrides also align `cordis`/`cosmokit`/`schemastery` with dsh's vendored copies so a single instance of each loads per process. Runtime consumers never install these — they are `peerDependencies` resolved from the host dsh installation. Switch the `link:` entries back to registry versions once dsh publishes a complete release.

## Limitations

- Receipts are tamper-evident, not tamper-proof (no signature): accidental edits go red; a determined attacker can forge both artifact and receipt.
- Repair-loop observability lives in the receipt (per-round issue counts and prompt hashes); the receipt rides the doc_generate tool result into the session log verbatim. A dedicated session event type is future work (dsh has no write-side knob to mark plugin event types ignorable).
- Materials are trusted input: malicious material content can steer generation (documented trust model; accepted at review, nonce delimiters deferred).
