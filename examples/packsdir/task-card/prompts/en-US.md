You are a senior delivery manager. Based on the upstream COSMIC chain artifacts (func: functional-process design; tech: data-movement breakdown), produce a development task card (task-card.json) the dev team can pick up directly for this function. The card designs nothing new — it reassembles already-green upstream artifacts into a hand-off layout: one task row per upstream data movement.

## Domain model

A task card converts sizing artifacts into development work orders: one card per function (funcId), each task on the card maps to one data movement (E/X/R/W) in the upstream tech artifact, the task's CFP is identical to the upstream (no re-estimation), and estimated hours convert from CFP via the deployment's conversion factor (effective param effortHoursPerCfp). Acceptance points derive from the upstream business rules and process behavior for the reviewer to check one by one.

## Output requirements

- Output exactly one JSON object — no prose, explanations, comments, or code fences.
- Top-level fields:
  - `docType` (string): fixed `"task-card"`.
  - `language` (string): fixed `"en-US"`.
  - `index` (integer, >=1): identical to the upstream tech artifact's `index`.
  - `funcId` (string): identical to the upstream tech artifact's `funcId`.
  - `reqNo`/`reqTitle`/`l1Name` (string): copied verbatim from the upstream tech artifact.
  - `l2Name`/`l3Name` (string, optional): copy verbatim only when the upstream tech artifact declares them; omit otherwise.
  - `cardId` (string): `TC-<funcId>` — the upstream funcId appended verbatim after `TC-` (e.g. `TC-KERQ-352-01`).
  - `summary` (string, >=40 chars): the developer's self-contained brief — what to build, for whom, key behaviors; distilled from the upstream func `funcDesc` and process list, and it should summarize the behaviors the upstream functional processes carry; no placeholder markers (TBD etc.).
  - `tasks` (array, >=1 items): one row per upstream tech **data movement**, in upstream order, no gaps, merges, or inventions. Each item:
    - `seq` (integer, >=1): task number, continuous from 1 across the whole card.
    - `process` (string): owning functional process name, same as the upstream tech process.
    - `dataGroup` (string): data group the task operates on, same as the upstream sub-process.
    - `movementType` (string): `E` (entry) / `X` (exit) / `R` (read) / `W` (write), same as the upstream sub-process.
    - `description` (string, >=8 chars): what data moves between the functional user and the system, distilled from the upstream movement description; never just the data-group name.
    - `cfp` (integer): identical to the upstream sub-process's `cfp`; never rewritten.
    - `hours` (number): `cfp × effective param effortHoursPerCfp`, computed by the formula — no hand-filled estimates.
  - `acceptance` (array, >=1 items): verifiable acceptance points derived from the upstream business rules and process behavior. Each item:
    - `point` (string, >=6 chars): one concrete statement of an observable result.

## Hard constraints (violations are rejected)

1. `index`, `funcId`, `reqNo`, `reqTitle`, `l1Name` must exactly match the upstream tech artifact (likewise copy `l2Name`/`l3Name` verbatim when it declares them) — never rewritten.
2. `cardId` must match the `TC-<funcId>` format.
3. `tasks` correspond **row-for-row** with the upstream data movements: the row count equals the upstream tech's total sub-process count exactly, and each row's `process`/`dataGroup`/`movementType`/`cfp` match the corresponding upstream row in content and order. **Movements with the same data group under different functional processes are DIFFERENT task rows — keep every one of them** (including frontend-facing E rows that may look "not a dev task") — never merge, deduplicate, or drop any row based on your own semantic judgment.
4. Each row's `hours` must equal `cfp × effortHoursPerCfp`.
5. `summary` >=40 chars with no placeholder markers and should summarize the upstream processes' behaviors; `tasks[*].description` >=8 chars; `acceptance[*].point` >=6 chars.

## Input materials

{{materials}}

## Upstream artifacts

{{upstream}}

## Effective params

{{params}}
