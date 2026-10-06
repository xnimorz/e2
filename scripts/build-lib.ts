/**
 * Compiles src/ into lib/, the JavaScript and declarations the npm package ships.
 *
 *   bun run build:lib
 *
 * Also runs as `prepack`, so `npm pack` and `npm publish` never ship a stale lib/.
 */
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const lib = join(root, 'lib')

await rm(lib, { recursive: true, force: true })

const tsc = Bun.spawnSync(['bunx', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (tsc.exitCode !== 0) {
  throw new Error('build:lib: tsc failed')
}

// `rewriteRelativeImportExtensions` rewrites `./fx.ts` to `./fx.js` in the
// JavaScript but leaves declarations alone, and a consumer on `nodenext`
// resolution would then look for a `.ts` file that is not there.
const relativeTs = /((?:from|import\()\s*['"]\.{1,2}\/[^'"]+)\.ts(['"])/g
let rewritten = 0
for (const name of await readdir(lib)) {
  if (!name.endsWith('.d.ts')) continue
  const file = Bun.file(join(lib, name))
  const text = await file.text()
  const next = text.replace(relativeTs, (_, head: string, quote: string) => {
    rewritten += 1
    return `${head}.js${quote}`
  })
  if (next !== text) await Bun.write(file, next)
}

console.log(`build:lib: lib/ written, ${rewritten} declaration imports rewritten`)
