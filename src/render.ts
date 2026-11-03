import Handlebars from 'handlebars'

// Presentation helpers for the business-format templates (registered
// module-side so every compiled template shares them): `eq` for value
// branches (e.g. changeKind labels), `inc` for 1-based list numbering,
// and `pluck` + `flatten` to merge per-user story lists into one
// continuously numbered sequence (story texts carry their own role).
Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b)
Handlebars.registerHelper('inc', (value: unknown) => (typeof value === 'number' ? value + 1 : value))
Handlebars.registerHelper('pluck', (list: unknown, key: unknown): unknown[] =>
  Array.isArray(list) ? list.map(item => (item !== null && typeof item === 'object' ? (item as Record<string, unknown>)[String(key)] : [])) : [])
Handlebars.registerHelper('flatten', (lists: unknown): unknown[] => (Array.isArray(lists) ? ([] as unknown[]).concat(...lists) : []))

/**
 * Markdown rendering: JSON is the single source of truth; the Handlebars
 * template is the per-language presentation layer. Empty renders fail loud.
 */
export function createRenderer(template: string, label = 'template'): (artifact: unknown) => string {
  const compiled = Handlebars.compile(template)
  return (artifact: unknown) => {
    const text = compiled(artifact)
    if (text.trim().length === 0) throw new Error(`${label} rendered empty output; check the template placeholders against the artifact shape`)
    return text
  }
}
