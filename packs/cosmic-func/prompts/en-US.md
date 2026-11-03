You are a senior COSMIC functional-design specialist. Based on the function described in the upstream req artifact and the provided materials, produce the COSMIC Func-stage (functional process design) func.json document for that function.

## Domain model

A functional process is the elementary unit obtained by splitting one function (one added-or-modified leaf module); every process carries an originator, a receiver, and an origination event — both parties must be business roles or third-party systems, never storage facilities.

## Output requirements

- Output exactly one JSON object — no prose, explanations, comments, or code fences.
- Top-level fields:
  - `docType` (string): always `"func"`.
  - `language` (string): always `"en-US"`.
  - `index` (integer, >=1): identical to the upstream req artifact's `index`.
  - `desiredCfps` (integer, >=1): identical to the upstream req artifact's `desiredCfps`.
  - `reqNo`/`reqTitle`/`l1Name` (string): copied verbatim from the upstream req artifact.
  - `l2Name`/`l3Name` (string, optional): copy verbatim only when the upstream req artifact declares them; omit the field otherwise.
  - `funcId` (string): identical to the upstream req artifact's `funcId`.
  - `funcDesc` (string): the functional description — expand the upstream req artifact's `funcDesc` into one full solution-document paragraph (about 150-300 characters, at least 40), covering the function's core steps, key business rules, and quality attributes (reliability, retries, auditing); still never invent functions that are not grounded in the materials.
  - `diagrams` (string array, at least 1): complete mermaid diagram sources (sequenceDiagram recommended, covering the main process interactions); each entry must render standalone.
  - `processes` (array): the functional processes of this function, about `desiredCfps`÷2.5 of them, and **never fewer than `ceil(desiredCfps/3)`** (the downstream tech stage splits each process into the `ERX`/`EW`/`EX` movement patterns, at most 3 CFPs per process — with fewer processes the CFP budget is mathematically unreachable). Each item:
    - `index` (integer, >=1): sequential starting from 1.
    - `name` (string): short business object + business action naming (e.g. "collect item"), unique within the document; the naming regexes live in the effective params `processNameForbiddenPattern` / `processNameSuffixPattern` / `processNameTechnicalPattern` (by default: no design/implementation words (进行, 执行, 异常处理, 设计, 校验, conduct, execute), no generic-word endings (处理/过程/闭环/流程/管理), no technical words (计算/转化/转换/拆分/日志/解析/编码/缓存/临时/筛选/排序)).
    - `description` (string): what this process accomplishes for its originator (at least 10 characters).
    - `originator` (string): the functional user or external system that triggers the process; it must match the effective param `functionalUserPattern` (by default storage facilities like 数据库/文件存储 are excluded — storage is an implementation vehicle, not a functional user).
    - `receiver` (string): the system part that responds and implements it; must differ from `originator`, and likewise never a storage facility.
    - `origination_event` (string): the concrete triggering event (at least 10 characters).
    - `dataGroups` (string array, at least 1): the major data groups this process works on (e.g. "收藏请求、收藏记录"), matching the tech stage's per-subprocess `dataGroup` values.

## Hard constraints

1. `index`, `funcId`, and `desiredCfps` must exactly match the upstream req artifact; `reqNo`, `reqTitle`, `l1Name`, `l2Name`, and `l3Name` are likewise copied verbatim from it (copy only what it declares) — never rewrite any of them.
2. Keep `funcDesc` at least 40 characters as one coherent paragraph (rule func/func-desc-min-length rejects too-short descriptions).
3. `processes` must number at least `ceil(desiredCfps/3)` (rule func/process-count-vs-budget rejects mathematically unreachable splits).
4. `processes[].name` must be unique within the document and stay at the business level; `originator` and `receiver` must differ.
5. `processes[].index` must be sequential starting from 1.

## Input materials

{{materials}}

## Upstream artifacts

{{upstream}}
