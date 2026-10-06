/**
 * Compiles the published packages: src/ into lib/, JavaScript and declarations.
 *
 *   bun run build                      every package
 *   bun scripts/build.ts e2            one package, by name
 *
 * Each package's `prepack` runs this for itself, so `npm pack` and
 * `npm publish` never ship a stale lib/.
 */
import { readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

export interface Package {
  readonly name: string
  readonly dir: string
}

const root = join(import.meta.dir, '..')

/** Released together, at one version. */
export const PACKAGES: readonly Package[] = [
  { name: 'e2', dir: root },
  { name: 'eslint-plugin-e2', dir: join(root, 'packages', 'eslint-plugin-e2') },
]

// `rewriteRelativeImportExtensions` rewrites `./fx.ts` to `./fx.js` in the
// JavaScript but leaves declarations alone, and a consumer on `nodenext`
// resolution would then look for a `.ts` file that is not there.
const RELATIVE_TS = /((?:from|import\()\s*['"]\.{1,2}\/[^'"]+)\.ts(['"])/g

export async function build(pkg: Package): Promise<void> {
  const lib = join(pkg.dir, 'lib')
  await rm(lib, { recursive: true, force: true })

  const tsc = Bun.spawnSync(
    ['bunx', 'tsc', '-p', join(pkg.dir, 'tsconfig.build.json')],
    {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    }
  )
  if (tsc.exitCode !== 0) throw new Error(`build: tsc failed for ${pkg.name}`)

  let rewritten = 0
  for (const name of await readdir(lib)) {
    if (!name.endsWith('.d.ts')) continue
    const file = Bun.file(join(lib, name))
    const text = await file.text()
    const next = text.replace(RELATIVE_TS, (_, head: string, quote: string) => {
      rewritten += 1
      return `${head}.js${quote}`
    })
    if (next !== text) await Bun.write(file, next)
  }
  console.log(
    `build: ${pkg.name} → ${relative(root, lib) || 'lib'} (${rewritten} declaration imports rewritten)`
  )
}

if (import.meta.main) {
  const wanted = process.argv.slice(2)
  const unknown = wanted.filter(
    (name) => !PACKAGES.some((pkg) => pkg.name === name)
  )
  if (unknown.length > 0)
    throw new Error(`build: unknown package ${unknown.join(', ')}`)
  for (const pkg of PACKAGES) {
    if (wanted.length === 0 || wanted.includes(pkg.name)) await build(pkg)
  }
}
