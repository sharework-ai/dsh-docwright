import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRenderer } from '../src/render.ts'

const packsRoot = fileURLToPath(new URL('../packs', import.meta.url))

/** Render a pack's golden sample through its per-language template. */
async function renderOf(pack: string, lang: string): Promise<string> {
  const template = await readFile(join(packsRoot, pack, 'templates', `${lang}.hbs`), 'utf8')
  const golden = JSON.parse(await readFile(join(packsRoot, pack, 'samples', 'golden.json'), 'utf8'))
  return createRenderer(template, `${pack}/${lang}`)(golden)
}

describe('solution-document template formats (docwright-references alignment)', () => {
  it('plan renders the breakdown-plan layout in both languages', async () => {
    const zh = await renderOf('cosmic-plan', 'zh-CN')
    expect(zh).toContain('# 需求分解规划书')
    expect(zh).toContain('需求编号及标题：REQ-001-EXAMPLE_商品收藏功能')
    expect(zh).toContain('期望CFP数量：70')
    expect(zh).toContain('|一级功能|二级功能|三级功能|功能编号|类型|功能描述|预计CFP数量|')
    expect(zh).toContain('|个人收藏|添加收藏||KERQ-352-01|新增|')
    expect(zh).not.toContain('合计')
    const en = await renderOf('cosmic-plan', 'en-US')
    expect(en).toContain('# Requirement Breakdown Plan')
    expect(en).toContain('Requirement no. & title: REQ-001-EXAMPLE_商品收藏功能')
    expect(en).toContain('|Level 1 Function|Level 2 Function|Level 3 Function|Function ID|Type|Description|Estimated CFPs|')
    expect(en).toContain('|Added|')
  })

  it('req renders the analysis-document layout with hierarchy and numbered lists', async () => {
    const zh = await renderOf('cosmic-req', 'zh-CN')
    expect(zh).toContain('# 需求分析文档：REQ-001-EXAMPLE_商品收藏功能')
    expect(zh).toContain('## 功能描述')
    expect(zh).toContain('### 个人收藏')
    expect(zh).toContain('#### 添加收藏')
    expect(zh).toContain('**功能编号**')
    expect(zh).toContain('KERQ-352-01')
    expect(zh).toContain('**功能描述**')
    expect(zh).toContain('**用户故事**')
    expect(zh).toContain('1. As a customer, I want to add a product to my favorites')
    expect(zh).toContain('2. As a customer, I want to remove a product')
    expect(zh).toContain('**业务规则**')
    expect(zh).toContain('1. 仅登录用户可以收藏商品')
    expect(zh).toContain('3. 商品下架或删除后')
    expect(zh).not.toContain('| 类型 |')
    const en = await renderOf('cosmic-req', 'en-US')
    expect(en).toContain('# Requirements Analysis: REQ-001-EXAMPLE_商品收藏功能')
    expect(en).toContain('**User Stories**')
    expect(en).toContain('**Business Rules**')
    expect(en).toContain('1. 仅登录用户可以收藏商品')
  })

  it('func renders the solution-document layout with the major-data-groups column', async () => {
    const zh = await renderOf('cosmic-func', 'zh-CN')
    expect(zh).toContain('# 需求解决方案：REQ-001-EXAMPLE_商品收藏功能')
    expect(zh).toContain('## 个人收藏')
    expect(zh).toContain('### 添加收藏')
    expect(zh).toContain('**功能描述**')
    expect(zh).toContain('**功能时序图**')
    expect(zh).toContain('```mermaid')
    expect(zh).toContain('**功能过程清单**')
    expect(zh).toContain('| 序号 | 功能过程 | 发起者 | 接收者 | 触发事件 | 功能过程描述 | 主要数据组 |')
    expect(zh).toContain('| 1 | 收藏商品 | 注册用户 | 收藏服务 |')
    expect(zh).toContain('收藏请求、收藏记录')
    const en = await renderOf('cosmic-func', 'en-US')
    expect(en).toContain('# Requirement Solution: REQ-001-EXAMPLE_商品收藏功能')
    expect(en).toContain('**Functional Process List**')
    expect(en).toContain('| Major data groups |')
    expect(en).toContain('收藏请求、收藏记录')
  })

  it('tech renders the breakdown-table layout with one row per data movement', async () => {
    const zh = await renderOf('cosmic-tech', 'zh-CN')
    expect(zh).toContain('# 功能点拆分表：REQ-001-EXAMPLE_商品收藏功能')
    expect(zh).toContain('| 需求编号 | 需求名称 | 一级功能模块 | 二级功能模块 | 三级功能模块 | 功能用户 | 功能用户需求 | 触发事件 | 功能过程 | 子过程描述 | 数据移动类型 | 数据组 | 数据属性 | CFP | 修订标识 |')
    expect(zh).toContain('| 发起者：注册用户 接收者：收藏服务 |')
    // The golden holds 14 processes totalling 35 subprocesses: one table row each.
    const rows = zh.match(/^\| REQ-001-EXAMPLE \|/gm) ?? []
    expect(rows).toHaveLength(35)
    const en = await renderOf('cosmic-tech', 'en-US')
    expect(en).toContain('# Function-Point Breakdown: REQ-001-EXAMPLE_商品收藏功能')
    expect(en).toContain('| Requirement No. | Requirement Name | Level 1 Module |')
    expect((en.match(/^\| REQ-001-EXAMPLE \|/gm) ?? [])).toHaveLength(35)
  })
})
