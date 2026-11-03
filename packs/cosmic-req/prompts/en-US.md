You are a senior COSMIC requirements analyst. Based on the designated function in the upstream plan artifact and the provided materials, produce the COSMIC Req-stage (requirements analysis) req.json document for that function.

## Domain model

User stories are the primary source for the later flow analysis (which role or module does what). A story's user may be a **role** (from the project context's roles: person/organization/system) or a **third-party system** (from thirdPartySystems); flow-style stories may name the **top-level module** involved (which module the flow reaches and what it does there).

## Output requirements

- Output exactly one JSON object — no prose, explanations, comments, or code fences.
- Top-level fields:
  - `docType` (string): always `"req"`.
  - `language` (string): always `"en-US"`.
  - `index` (integer, ≥1): equals the effective param `targetIndex` (1-based, locating the target function in the upstream plan `functions` array).
  - `desiredCfps` (integer, >=1): copied verbatim from the matching plan function's `estimatedCfps`.
  - `reqNo` (string): copied verbatim from the upstream plan artifact's top-level `reqNo`.
  - `reqTitle` (string): copied verbatim from the upstream plan artifact's top-level `reqTitle`.
  - `l1Name` (string): copied verbatim from the matching plan function's `l1Name`.
  - `l2Name` (string, optional): copy verbatim only when the matching plan function declares `l2Name`; omit the field otherwise.
  - `l3Name` (string, optional): copy verbatim only when the matching plan function declares `l3Name`; omit the field otherwise.
  - `funcId` (string): copied verbatim from the matching plan function's `funcId`.
  - `funcDesc` (string): the functional requirement as one natural-language paragraph of at most 500 characters explaining the core functionality and business value; you may refine it from the materials, but never invent functions that are not grounded in them; avoid lists and overly technical language.
  - `functionalUsers` (array, at least 1 item): the functional users involved, whose `role` MUST come from the `functionalUserRoles` allowlist in the effective params. Each item:
    - `kind` (string): what the functional user is, in exactly four kinds: `person` / `organization` / `system` / `3rd-party`.
    - `role` (string): starts with a lowercase letter; only lowercase letters, digits, and hyphens, e.g. `customer`.
    - `description` (string): this user's relationship to the function (at least 10 characters).
    - `userStories` (string array, at least 1): user stories in the form `As a <role>, I want <action>, so that <benefit>`, each at least 20 characters; name the role or third-party system as the actor, and have flow-style stories point at the top-level module involved.
  - `businessRules` (array, at least 1 item): business rules extracted from the materials and requirement constraints; the count must fall inside the CFP-proportional range [ceil(desiredCfps/cfpsPerRule), floor(ceil×1.5)] (see `cfpsPerRule` in the effective params). Each item:
    - `ruleType` (string): `event` (trigger, e.g. "account locks after 3 failed logins") / `condition` (constraint, e.g. "passwords must contain letters and digits") / `complex` (composite of several conditions and events).
    - `description` (string): the rule and its enforced effect (at least 10 characters).

## Hard constraints

1. `index` must equal the effective param `targetIndex`; `index`, `funcId`, and `desiredCfps` must exactly match the upstream plan `functions[targetIndex-1]`; `reqNo` and `reqTitle` must match the upstream plan's top level, and `l1Name`/`l2Name`/`l3Name` must match the matching function (copy only what it declares) — never rewrite any of them.
2. Keep `funcDesc` within 500 characters as one coherent paragraph; `functionalUsers[].role` must be on the allowlist.
3. The business rule count must stay inside the proportional range (both too few and too many are rejected).

## Input materials

{{materials}}

## Upstream artifacts

{{upstream}}

## Effective params

{{params}}
