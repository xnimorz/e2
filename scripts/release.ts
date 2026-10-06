/**
 * Publishes the version in package.json to npm.
 *
 *   bun run release              check, build, verify, ask, publish, tag
 *   bun run release --dry-run    everything except publishing and tagging
 *   bun run release --yes        do not ask before publishing
 *   bun run release --tag next   publish under a dist-tag other than `latest`
 *
 * To release a new version, change `version` in package.json, commit, and run
 * this from a clean `master` that matches `origin/master`.
 *
 * The tarball that is verified is the tarball that is published: it is packed
 * once, installed into a scratch project that type-checks and runs against it,
 * and then handed to `npm publish` as a file.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const assumeYes = args.includes('--yes')
const tagIndex = args.indexOf('--tag')
const distTag = tagIndex === -1 ? 'latest' : args[tagIndex + 1]
if (distTag === undefined || distTag.startsWith('--')) throw new Error('release: --tag needs a value')

const BRANCH = 'master'

// --- helpers -------------------------------------------------------------------

const step = (title: string): void => console.log(`\n\x1b[1m▸ ${title}\x1b[0m`)

function sh(cmd: readonly string[], options: { cwd?: string; quiet?: boolean; allowFailure?: boolean } = {}) {
  const result = Bun.spawnSync([...cmd], {
    cwd: options.cwd ?? root,
    stdout: options.quiet ? 'pipe' : 'inherit',
    stderr: options.quiet ? 'pipe' : 'inherit',
  })
  const stdout = result.stdout?.toString().trim() ?? ''
  const stderr = result.stderr?.toString().trim() ?? ''
  if (result.exitCode !== 0 && !options.allowFailure) {
    if (options.quiet) console.error(stderr || stdout)
    throw new Error(`release: \`${cmd.join(' ')}\` exited with ${result.exitCode}`)
  }
  return { ok: result.exitCode === 0, stdout, stderr }
}

const abort = (message: string): never => {
  console.error(`\n\x1b[31mrelease: ${message}\x1b[0m`)
  process.exit(1)
}

// --- preconditions -----------------------------------------------------------------

const pkg = (await Bun.file(join(root, 'package.json')).json()) as { name: string; version: string }
const tag = `v${pkg.version}`
console.log(`release: ${pkg.name}@${pkg.version} → npm (${distTag})${dryRun ? ', dry run' : ''}`)

step('Preconditions')
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) abort(`"${pkg.version}" is not a release version`)
if (distTag === 'latest' && pkg.version.includes('-')) abort('a prerelease must be published with --tag, not as latest')

const branch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { quiet: true }).stdout
if (branch !== BRANCH && !dryRun) abort(`releases are cut from ${BRANCH}, not ${branch}`)

const dirty = sh(['git', 'status', '--porcelain'], { quiet: true }).stdout
if (dirty !== '' && !dryRun) abort(`the working tree is not clean:\n${dirty}`)

if (!dryRun) {
  sh(['git', 'fetch', '--quiet', 'origin', BRANCH], { quiet: true })
  const local = sh(['git', 'rev-parse', 'HEAD'], { quiet: true }).stdout
  const remote = sh(['git', 'rev-parse', `origin/${BRANCH}`], { quiet: true }).stdout
  if (local !== remote) abort(`HEAD is not origin/${BRANCH}; push or pull first`)
}

if (sh(['git', 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { quiet: true, allowFailure: true }).ok) {
  abort(`tag ${tag} already exists`)
}

const published = sh(['npm', 'view', `${pkg.name}@${pkg.version}`, 'version'], { quiet: true, allowFailure: true })
if (published.ok && published.stdout === pkg.version) abort(`${pkg.name}@${pkg.version} is already on npm`)

const whoami = sh(['npm', 'whoami'], { quiet: true, allowFailure: true })
if (!whoami.ok && !dryRun) abort('not logged in to npm; run `npm login` first')
console.log(`  version ${pkg.version} is free, tag ${tag} is free${whoami.ok ? `, npm user ${whoami.stdout}` : ''}`)

// --- checks and build -----------------------------------------------------------------

step('Typecheck, lint, tests')
sh(['bun', 'run', 'check'])

step('Pack')
const releaseDir = join(root, 'out', 'release')
await rm(releaseDir, { recursive: true, force: true })
await mkdir(releaseDir, { recursive: true })
sh(['bun', 'run', 'build:lib'])
// lib/ is fresh; skip `prepack` so its output does not land in the JSON.
const packed = JSON.parse(
  sh(['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', releaseDir], { quiet: true }).stdout
) as [
  { filename: string; size: number; unpackedSize: number; files: { path: string }[] },
]
const tarball = join(releaseDir, packed[0].filename)
const files = packed[0].files.map((file) => file.path)

for (const required of ['package.json', 'README.md', 'LICENSE', 'lib/index.js', 'lib/index.d.ts']) {
  if (!files.includes(required)) abort(`the package is missing ${required}`)
}
const stray = files.filter((path) => /(^|\/)tests?\//.test(path) || path.endsWith('.spec.ts'))
if (stray.length > 0) abort(`the package includes test files:\n  ${stray.join('\n  ')}`)
console.log(`  ${packed[0].filename}: ${files.length} files, ${(packed[0].size / 1024).toFixed(1)} KB packed, ${(packed[0].unpackedSize / 1024).toFixed(1)} KB unpacked`)

// --- verify the tarball as a consumer would see it ------------------------------------------

step('Verify the tarball in a scratch project')
const scratch = await mkdtemp(join(tmpdir(), 'e2-release-'))
try {
  await Bun.write(
    join(scratch, 'package.json'),
    JSON.stringify({ name: 'e2-release-check', private: true, type: 'module' })
  )
  sh(['npm', 'install', '--silent', '--no-audit', '--no-fund', tarball, 'typescript@5.9.3'], { cwd: scratch, quiet: true })

  // The strictest common consumer setup: Node's own ESM resolution.
  await Bun.write(
    join(scratch, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, skipLibCheck: false },
      include: ['ok.ts'],
    })
  )
  await Bun.write(
    join(scratch, 'ok.ts'),
    `import { fx, run, service, sync, type Fx } from 'e2'
interface Logger { info(message: string): Fx<void> }
const Logger = service<Logger>()('Logger')
const LoggerLive = Logger.of({ info: (message) => sync(() => console.log(message)) })
const greet = fx(function* (name: string) {
  const log = yield* Logger
  yield* log.info(\`hello \${name}\`)
  return name.length
})
const result = await run(greet('e2'), [LoggerLive])
if (!result.ok || result.value !== 2) throw new Error('unexpected result')
`
  )
  sh(['npx', 'tsc', '-p', '.'], { cwd: scratch, quiet: true })
  console.log('  types: a consumer on nodenext resolution type-checks')

  // The diagnostic the library is built around has to survive publishing.
  await Bun.write(
    join(scratch, 'missing.ts'),
    `import { fx, run, service, type Fx } from 'e2'
interface Logger { info(message: string): Fx<void> }
const Logger = service<Logger>()('Logger')
const greet = fx(function* () { const log = yield* Logger; yield* log.info('hi') })
await run(greet(), [])
`
  )
  const missing = sh(['npx', 'tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', 'missing.ts'], {
    cwd: scratch,
    quiet: true,
    allowFailure: true,
  })
  if (missing.ok || !missing.stdout.includes('"e2: missing service Logger"')) {
    abort(`the missing-service diagnostic did not survive packing:\n${missing.stdout}`)
  }
  console.log('  types: a missing service still reads "e2: missing service Logger"')

  // Run the compiled consumer on Node, against the compiled library.
  await Bun.write(
    join(scratch, 'ok.mjs'),
    `import { fx, run, service, sync } from 'e2'
const Logger = service()('Logger')
const LoggerLive = Logger.of({ info: () => sync(() => undefined) })
const greet = fx(function* (name) { const log = yield* Logger; yield* log.info(name); return name.length })
const result = await run(greet('e2'), [LoggerLive])
if (!result.ok || result.value !== 2) throw new Error('unexpected result: ' + JSON.stringify(result))
`
  )
  sh(['node', 'ok.mjs'], { cwd: scratch, quiet: true })
  console.log(`  runtime: Node ${sh(['node', '--version'], { quiet: true }).stdout} runs it`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}

// --- publish -------------------------------------------------------------------------------

if (dryRun) {
  step('Publish (dry run)')
  sh(['npm', 'publish', tarball, '--dry-run', '--access', 'public', '--tag', distTag])
  console.log(`\nrelease: dry run complete. ${tarball} is what would be published.`)
  process.exit(0)
}

step('Publish')
if (!assumeYes) {
  process.stdout.write(`Publish ${pkg.name}@${pkg.version} to npm as "${distTag}" and push tag ${tag}? [y/N] `)
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once('data', (data) => resolve(data.toString().trim()))
  })
  process.stdin.pause()
  if (!/^y(es)?$/i.test(answer)) abort('cancelled; nothing was published')
}

// npm asks for a one-time password itself when the account requires one.
sh(['npm', 'publish', tarball, '--access', 'public', '--tag', distTag])

step('Tag')
sh(['git', 'tag', '-a', tag, '-m', `${pkg.name} ${pkg.version}`])
sh(['git', 'push', 'origin', tag])

console.log(`\nrelease: ${pkg.name}@${pkg.version} published and tagged ${tag}.`)
