/**
 * Browser client bundle for the docwright plugin, mirroring the dsh-market
 * recipe for an external package: a closure-factory artifact that calls
 * window.__ModuleLoader__.load({ id, factory }) and resolves externals
 * through the injected require (loader module table). Styles are compiled by
 * scripts/build-client-css.mjs (Tailwind, src/client/styles.css) into the
 * generated-css.ts constant the entry imports and injects as a style tag
 * (tsdown 0.12 has no define option — the constant rides the bundle as a
 * normal module).
 */
import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
// The loader id MUST equal the package name: the host composes the boot
// graph per package (dsh-market contract — its normalize script reads
// package.json name for exactly this reason).
const id = (JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')) as { name: string }).name

/** Only the loader module table entries this bundle requires. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // tsdown auto-externalizes package dependencies; anything NOT in the loader
  // module table must inline instead — a require() the table cannot answer is
  // a guaranteed runtime throw.
  noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
