# 函数规则执行上下文（RuleContext）

Status: implemented（2026-10-12，随 cosmic-req pack 落地）

## 问题

链式 pack 的核心价值在跨产物校验：req 的 funcId 必须真的存在于上游 plan（原 cosmic-claude 审计规则 E303），角色必须真的在部署白名单里（E301）。但函数规则的签名是 `check(artifact)`——只看得见当前产物，跨产物断言只能靠 prompt 自觉，护栏退化为摆设。这正是"链式留位"缺的最后一环。

## 设计

`FunctionRule.check(artifact, context?)`，第二参可选（旧单参规则零改动兼容）：

```ts
interface RuleContext {
  readonly upstream?: readonly unknown[]   // 解析后的上游产物（无法解析的文本跳过）
  readonly materials?: readonly string[]   // 素材原文（#!inline 标记已剥离）
  readonly params?: Readonly<Record<string, unknown>> // 生效参数（defaults + 覆盖，已过声明校验）
}
```

接线：`generateDocument` 的 validate 闭包捕获素材文本与上游产物（每轮复用，不重复解析）；`doc_generate` 的上游经六项校验必然可解析，程序化调用时不可解析项跳过而非报错。`doc_validate` 新增可选 `upstream` 参数，复验链式规则时走同一套上游校验并把锚点记入回执。声明式规则不受影响（数值参数引用走原有 `{"param"}` 机制）。

## 已否决（不再重开）

- **materials 启发式解析角色清单**（在素材文本里搜"像角色数组"的 JSON）：readMaterials 只回传文本不回传文件名，按内容猜格式脆弱且不可解释。正解：角色白名单是部署期声明，走 pack 参数（`functionalUserRoles` 逗号分隔 string；role 格式 `^[a-z][a-z0-9-]*$` 天然无逗号），声明即白名单、as-run 进回执、复验按原标准回放。
- **E303 依赖 prompt 自觉**（把上游 plan 注入 prompt，规则只查格式）：模型守约时无感，模型失约时零拦截——链式一致性的保证必须有确定性 check 兜底。正解：`req/plan-alignment` 函数规则，index/funcId/desiredCfps 三点对齐上游 plan functions[index-1]。
- **doc_validate 不加 upstream**（复验时跳过跨产物规则）：链式规则的复验要么报错要么静默降级，两难。正解：doc_validate 增可选 `upstream` 参数——传入则全套六项校验 + 复验跨产物规则 + 记锚点；不传则规则以 error 报"找不到上游产物"（明确失败，错误消息引导传参）。

## 迁移差异（相对 cosmic-claude Req 审计）

- E301/E302/E303 在原系统进 `audit_comments`，只降分不翻转 is_valid（完整性问题才阻断）；docwright 语义是"护栏即阻断"，三条全部 error 阻断生成。
- 参数化差异：`COSMIC_PLAN_CFPS_PER_FUNC`（env，10-100）→ pack 参数 `cfpsPerFunc`（10-100，as-run 入回执）；`system_roles.local.json`（部署期文件）→ pack 参数 `functionalUserRoles` 白名单。
- 评分体系不迁移：原系统 300/100/50 按 item 归一，docwright 用内置严重度评分（10/3/1 百分制）。
- golden 样例对齐：req/func/tech 的 golden funcId 与 cosmic-plan golden 对应函数精确对齐（funcId / index / estimatedCfps 三点一致），链规则自过。
