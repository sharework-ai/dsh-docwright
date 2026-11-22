import { readFileSync } from 'node:fs'

/**
 * Build stamp (issue #3): which git commit produced the loaded runtime.
 *
 * The stamp file is written by `scripts/write-build-stamp.mjs` next to each
 * build output (lib/build-info.json, dist/build-info.json); reading it
 * relative to `import.meta.url` means the loaded artifact reports itself —
 * a stale dist/ reports its own (old) sha instead of inheriting the repo's.
 * Absent stamp (source checkout, old build) yields undefined; the doc_packs
 * tool surfaces the stamp and warns when missing.
 */
export interface BuildStamp {
  readonly gitSha: string
  readonly builtAt: string
}

export function readBuildStamp(): BuildStamp | undefined {
  try {
    const raw = JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf8')) as Partial<BuildStamp>
    if (typeof raw.gitSha === 'string' && typeof raw.builtAt === 'string') {
      return { gitSha: raw.gitSha, builtAt: raw.builtAt }
    }
    return undefined
  } catch {
    return undefined
  }
}
