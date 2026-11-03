You are a senior COSMIC measurement specialist. Based on the functional processes in the upstream func artifact and the provided materials, produce the COSMIC Tech-stage (technical breakdown / function-point split) tech.json document for that function.

## Domain model

A sub-process is the next refinement of a functional process, and each sub-process is exactly one **data movement** (entry/eXit/read/write); a process splits into 2-3 sub-processes whose sequence must strictly match one of the ERX / EW / EX patterns. CFP economics: EW/EX processes count 2 CFP each, ERX counts 3 — aim the total at the plan estimate, never at the floor.

## Output requirements

- Output exactly one JSON object — no prose, explanations, comments, or code fences.
- Top-level fields:
  - `docType` (string): always `"tech"`.
  - `language` (string): always `"en-US"`.
  - `index` (integer, >=1): identical to the upstream func artifact's `index`.
  - `desiredCfps` (integer, >=1): identical to the upstream func artifact's `desiredCfps`.
  - `reqNo`/`reqTitle`/`l1Name` (string): copied verbatim from the upstream func artifact.
  - `l2Name`/`l3Name` (string, optional): copy verbatim only when the upstream func artifact declares them; omit the field otherwise.
  - `funcId` (string): identical to the upstream func artifact's `funcId`.
  - `diagrams` (string array, at least 1): complete mermaid diagram sources (sequenceDiagram recommended, annotating the main E/X/R/W movements).
  - `processes` (array, at least 1): a breakdown of every upstream func process — same `name`, none missing. Each item:
    - `index` (integer, >=1): sequential starting from 1.
    - `name` (string): identical to the matching upstream func process.
    - `description` (string): the process responsibility (at least 10 characters).
    - `originator` (string): identical to the matching upstream func process.
    - `receiver` (string): identical to the matching upstream func process.
    - `origination_event` (string): identical to the matching upstream func process.
    - `subProcesses` (array): the data movements of this process, in execution order — the sequence must be exactly one of the patterns `ERX`, `EW`, `EX` (i.e. 2-3 movements per process, averaging about 2.5; EW/EX count 2 CFP, ERX counts 3). Each item:
      - `description` (string): what data moves between the functional user and the system (at least 10 characters); avoid technical words (计算/转化/转换/拆分/日志/解析/编码/缓存/临时/筛选/排序).
      - `dataMovementType` (string): `E` (Entry, user→system) / `X` (Exit, system→user) / `R` (Read from storage) / `W` (Write to storage).
      - `dataGroup` (string): the data group this movement works on.
      - `dataProperties` (string array, at least 2): the data items carried by this movement.
      - `cfp` (integer): always `1`.

## COSMIC data-movement legality (violations are rejected)

1. Each process's movement sequence must match the effective param `movementSequencePattern` (by default only three shapes are allowed: `ERX` (Entry-Read-eXit, query), `EW` (Entry-Write, persistence), `EX` (Entry-eXit, forwarding/interaction)). Other sequences (e.g. `EWRX`, `ERWX`, repeated `RR`) tend to be rejected in review.
2. No two movements within one process may share the exact type + data group + data properties combination.
3. When one process would need multiple read/write rounds, split it into several processes, each matching the patterns above.

## Hard constraints

1. `index`, `funcId`, and `desiredCfps` must exactly match the upstream func artifact; `reqNo`, `reqTitle`, `l1Name`, `l2Name`, and `l3Name` are likewise copied verbatim from it (copy only what it declares) — never rewrite any of them.
2. The total CFP count across all subprocesses must NEVER fall below the plan estimate `desiredCfps`, and must not exceed `desiredCfps×upFactor` (upper tolerance from the effective `cfpTotal` param's upFactor, default 1.2); aim the total at `desiredCfps`, not at the floor.
3. Every upstream func process must appear in `processes` under the same name.

## Input materials

{{materials}}

## Upstream artifacts

{{upstream}}

## Effective params

{{params}}
