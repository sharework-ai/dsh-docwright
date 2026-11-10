import { readFile, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { normalizeWindowsPath } from './paths.ts'
import { sha256, type MaterialAnchor } from './receipt.ts'

/** One resolved material: the canonical ref actually read, its content hash, and the text. */
export interface MaterialEntry {
  readonly ref: string
  readonly hash: string
  readonly text: string
  /** Absolute path the content was read from (file entries only; inline text has none).
   * Surfaced in the doc_generate result so a verifying model checks the SAME
   * file the engine anchored — under dual materials roots the winner is the
   * topic-level one, which a session-cwd pre-read can easily miss. */
  readonly path?: string
}

/**
 * Material references: paths relative to one of the candidate material roots
 * (topic-scope packs try `<topic>/<dir>/` first, then `<workspace>/<dir>/`;
 * default dir `references/`, pack-declared otherwise — e.g. `input/` for
 * user-provided requirement docs), or inline text whose first line is the
 * explicit `#!inline` marker (no heuristics). Containment is enforced twice
 * against the WORKSPACE root: lexically first (so `../..` gets a clear
 * traversal error even for nonexistent paths), then on REAL paths (so a
 * symlink inside the workspace that points outside it is rejected too).
 * Both keep secrets out of prompts.
 */
/** Sorted file names under dir (capped); explains a missing dir instead of throwing. */
async function listFiles(dir: string): Promise<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const names = entries.filter(e => e.isFile()).map(e => e.name).sort()
    return names.length === 0 ? '(no files)' : names.slice(0, 8).join(', ')
  } catch {
    return '(directory does not exist)'
  }
}

/** Loud failure with recovery hints: what exists where, and the no-prefix rule. */
async function notReadable(ref: string, bases: readonly string[], root: string, cause: unknown): Promise<Error> {
  const parts = [`material not readable: ${ref}`]
  for (const materialBase of bases) {
    parts.push(`${relative(root, materialBase) || '.'}/ has: ${await listFiles(materialBase)}`)
  }
  parts.push(`hint: refs are relative to the materials root — do not repeat the root directory name inside the ref; cause: ${(cause as Error).message}`)
  return new Error(parts.join('; '))
}

/**
 * Resolve material refs to entries carrying the canonical ref (what was
 * actually read), the content hash, and the text. The canonical ref is the
 * materials-root-relative path of the REAL file — so a double-prefixed
 * spelling ("references/x.md" under a references/ root) and the plain ref
 * anchor identically — or the `#!inline` marker for inline text.
 */
export async function readMaterialEntries(
  refs: readonly string[],
  workspaceRoot: string,
  materialsRoots: readonly string[],
): Promise<readonly MaterialEntry[]> {
  // An empty list is legal: chained packs may rely on the upstream artifact
  // alone for context. The tool layer enforces "some input exists".
  if (refs.length === 0) return []
  const root = await realpath(resolve(workspaceRoot))
  const bases = materialsRoots.map(r => resolve(root, r))
  const out: MaterialEntry[] = []
  for (const ref of refs) {
    if (typeof ref !== 'string') {
      throw new Error(`material reference must be a string, got ${JSON.stringify(ref)}`)
    }
    if (ref.startsWith('#!inline')) {
      const text = ref.slice('#!inline'.length).replace(/^\n/, '')
      out.push({ ref: '#!inline', hash: sha256(text), text })
      continue
    }
    // Roots are candidates tried in order (topic-level first, then the
    // workspace-level dir of the same name): the first root where the ref
    // resolves wins, so a topic's own input shadows the shared one.
    let real: string | undefined
    let resolvedBase: string | undefined
    let lastError: unknown
    const escapes: string[] = []
    for (const materialBase of bases) {
      const abs = resolve(materialBase, normalizeWindowsPath(ref))
      const lexicalRel = relative(root, abs)
      if (lexicalRel === '..' || lexicalRel.startsWith('../') || isAbsolute(lexicalRel)) {
        escapes.push(abs)
        continue
      }
      try {
        const candidate = await realpath(abs)
        const realRel = relative(root, candidate)
        if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) {
          throw new Error(`material path escapes the workspace root via symlink: ${ref} (root: ${root})`)
        }
        real = candidate
        resolvedBase = materialBase
        break
      } catch (error) {
        if (error instanceof Error && error.message.includes('escapes the workspace root via symlink')) throw error
        lastError = error
      }
    }
    if (real === undefined) {
      // Models habitually prefix refs with the materials root's directory
      // name ("references/x.md" under a references/ root double-resolves to
      // references/references/x.md). When stripping that leading segment
      // lands on an existing in-root file, accept it; otherwise fail loud
      // with the available names so the retry can pick a real one.
      for (const materialBase of bases) {
        const prefix = `${basename(materialBase)}/`
        if (!ref.startsWith(prefix)) continue
        const strippedAbs = resolve(materialBase, ref.slice(prefix.length))
        const strippedRel = relative(root, strippedAbs)
        const contained = strippedRel !== '..' && !strippedRel.startsWith('../') && !isAbsolute(strippedRel)
        if (!contained) continue
        try {
          const candidate = await realpath(strippedAbs)
          const realRel = relative(root, candidate)
          if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) continue
          real = candidate
          resolvedBase = materialBase
          break
        } catch { /* try the next root */ }
      }
    }
    if (real === undefined || resolvedBase === undefined) {
      if (escapes.length === bases.length) {
        throw new Error(`material path escapes the workspace root: ${ref} (root: ${root})`)
      }
      throw await notReadable(ref, bases, root, lastError)
    }
    const text = await readFile(real, 'utf8')
    out.push({ ref: relative(resolvedBase, real).split(sep).join('/'), hash: sha256(text), text, path: real })
  }
  return out
}

/** Texts-only view of {@link readMaterialEntries} (the prompt/rule input). */
export async function readMaterials(
  refs: readonly string[],
  workspaceRoot: string,
  materialsRoots: readonly string[],
): Promise<readonly string[]> {
  return (await readMaterialEntries(refs, workspaceRoot, materialsRoots)).map(e => e.text)
}

/** Canonical manifest: {ref, hash} pairs sorted by ref then hash (multiset — duplicates kept). */
export function materialAnchors(entries: readonly MaterialEntry[]): readonly MaterialAnchor[] {
  return entries
    .map(({ ref, hash }) => ({ ref, hash }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
}
