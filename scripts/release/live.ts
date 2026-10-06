/**
 * The real implementations: a shell, git, npm, the terminal, the filesystem.
 * Only this file knows how anything is actually done.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Schedule,
  acquire,
  async_,
  attemptFx,
  err,
  fromPromise,
  gen,
  mapError,
  ok,
  retry,
  scoped,
  sync,
  timeout,
} from 'e2'
import { build } from '../build.ts'
import {
  CommandFailed,
  Config,
  Git,
  Log,
  Npm,
  Prompt,
  RegistryUnavailable,
  Shell,
  VerificationFailed,
  Verifier,
  Workspace,
  type Packed,
} from './contracts.ts'

// --- terminal ----------------------------------------------------------------------------

export const ConsoleLog = Log.of({
  step: (title) => sync(() => console.log(`\n\x1b[1m▸ ${title}\x1b[0m`)),
  info: (line) => sync(() => console.log(`  ${line}`)),
})

/** Asks on the terminal. Interrupting while it waits stops listening. */
export const TerminalPrompt = Prompt.of({
  confirm: (question) =>
    async_<boolean, never>((resume) => {
      process.stdout.write(`${question} [y/N] `)
      const onData = (data: Buffer) => {
        process.stdin.pause()
        resume(ok(/^y(es)?$/i.test(data.toString().trim())))
      }
      process.stdin.once('data', onData)
      return () => {
        process.stdin.off('data', onData)
        process.stdin.pause()
      }
    }),
})

/** `--yes`, and CI: nobody is there to ask. */
export const AutoConfirm = Prompt.of({ confirm: () => ok(true) })

// --- shell ----------------------------------------------------------------------------------

export const ShellLive = Shell.make(function* () {
  const config = yield* Config
  return {
    run: (command, options = {}) =>
      gen(function* () {
        const { code, stdout, stderr } = yield* fromPromise(async (signal) => {
          // The fiber's signal kills the process, so Ctrl+C or a timeout stops `npm install` too.
          const child = Bun.spawn([...command], {
            cwd: options.cwd ?? config.root,
            stdin: 'ignore',
            stdout: options.quiet ? 'pipe' : 'inherit',
            stderr: options.quiet ? 'pipe' : 'inherit',
            signal,
          })
          const [exitCode, out, error] = await Promise.all([
            child.exited,
            options.quiet
              ? new Response(child.stdout as ReadableStream).text()
              : '',
            options.quiet
              ? new Response(child.stderr as ReadableStream).text()
              : '',
          ])
          return { code: exitCode, stdout: out.trim(), stderr: error.trim() }
        })
        if (code !== 0)
          return yield* err(
            new CommandFailed(command.join(' '), code, stderr || stdout)
          )
        return { stdout, stderr }
      }),
  }
})

// --- git -------------------------------------------------------------------------------------

export const GitLive = Git.make(function* () {
  const shell = yield* Shell
  const git = (...args: string[]) =>
    shell.run(['git', ...args], { quiet: true })
  const output = (...args: string[]) =>
    gen(function* () {
      return (yield* git(...args)).stdout
    })

  /** Exit code 1 is git's "no" for these queries; anything else is a failure. */
  const succeeds = (...args: string[]) =>
    gen(function* () {
      const result = yield* attemptFx(git(...args))
      if (result.ok) return true
      if (result.error.exitCode === 1) return false
      return yield* err(result.error)
    })

  return {
    branch: output('rev-parse', '--abbrev-ref', 'HEAD'),
    isClean: gen(function* () {
      return (yield* output('status', '--porcelain')) === ''
    }),
    head: output('rev-parse', 'HEAD'),
    remoteHead: (branch) =>
      gen(function* () {
        yield* git('fetch', '--quiet', 'origin', branch)
        return yield* output('rev-parse', `origin/${branch}`)
      }),
    tagExists: (tag) =>
      gen(function* () {
        if (
          yield* succeeds(
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/tags/${tag}`
          )
        )
          return true
        return (
          (yield* output(
            'ls-remote',
            '--tags',
            'origin',
            `refs/tags/${tag}`
          )) !== ''
        )
      }),
    isOn: (branch) =>
      gen(function* () {
        yield* git('fetch', '--quiet', 'origin', branch)
        return yield* succeeds(
          'merge-base',
          '--is-ancestor',
          'HEAD',
          `origin/${branch}`
        )
      }),
    pushTag: (tag, message) =>
      gen(function* () {
        yield* git('tag', '-a', tag, '-m', message)
        yield* shell.run(['git', 'push', 'origin', tag])
      }),
  }
})

// --- npm -----------------------------------------------------------------------------------

/** `retries` is how a registry failure is retried; tests pass one that does not wait. */
export const npmWith = (retries: Schedule) =>
  Npm.make(function* () {
    const shell = yield* Shell

    const lookup = (name: string, version: string) =>
      gen(function* () {
        const result = yield* attemptFx(
          shell.run(['npm', 'view', `${name}@${version}`, 'version'], {
            quiet: true,
          })
        )
        if (result.ok) return result.value.stdout === version
        // Not on npm is an answer, not a failure.
        if (result.error.output.includes('E404')) return false
        return yield* err(result.error)
      })

    return {
      // The registry is the one flaky dependency: retry it, and do not wait forever.
      isPublished: (name, version) =>
        mapError((cause: CommandFailed | RegistryUnavailable) =>
          cause instanceof RegistryUnavailable
            ? cause
            : new RegistryUnavailable(
                `npm view ${name}: ${cause.output || cause.message}`
              )
        )(
          timeout(
            60_000,
            () =>
              new RegistryUnavailable(
                `npm did not answer about ${name} within a minute`
              )
          )(retry(retries)(lookup(name, version)))
        ),

      whoami: gen(function* () {
        const result = yield* attemptFx(
          shell.run(['npm', 'whoami'], { quiet: true })
        )
        return result.ok ? result.value.stdout : undefined
      }),

      pack: (pkg, destination) =>
        gen(function* () {
          // lib/ is fresh; skip `prepack` so nothing but JSON reaches stdout.
          const { stdout } = yield* shell.run(
            [
              'npm',
              'pack',
              '--json',
              '--ignore-scripts',
              '--pack-destination',
              destination,
            ],
            {
              cwd: pkg.dir,
              quiet: true,
            }
          )
          const [packed] = JSON.parse(stdout) as [
            { filename: string; size: number; files: { path: string }[] },
          ]
          return {
            name: pkg.name,
            tarball: join(destination, packed.filename),
            files: packed.files.map((file) => file.path),
            size: packed.size,
          } satisfies Packed
        }),

      publish: (tarball, options) =>
        gen(function* () {
          yield* shell.run([
            'npm',
            'publish',
            tarball,
            '--access',
            'public',
            '--tag',
            options.tag,
            ...(options.provenance ? ['--provenance'] : []),
            ...(options.dryRun ? ['--dry-run'] : []),
          ])
        }),
    }
  })

export const NpmLive = npmWith(Schedule.exponential(500).upTo(3))

// --- workspace ------------------------------------------------------------------------------

export const WorkspaceLive = Workspace.make(function* () {
  const config = yield* Config
  const shell = yield* Shell
  return {
    version: (pkg) =>
      fromPromise(
        async () =>
          (
            (await Bun.file(join(pkg.dir, 'package.json')).json()) as {
              version: string
            }
          ).version
      ),
    check: gen(function* () {
      yield* shell.run(['bun', 'run', 'check'])
    }),
    build: (pkg) =>
      fromPromise(
        () => build(pkg),
        (reason) => new CommandFailed(`build ${pkg.name}`, 1, String(reason))
      ),
    releaseDir: fromPromise(async () => {
      const dir = join(config.root, 'out', 'release')
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      return dir
    }),
  }
})

// --- verification -----------------------------------------------------------------------------

const CONSUMER = `import { fx, run, service, sync, type Fx } from 'e2'
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

const MISSING_SERVICE = `import { fx, run, service, type Fx } from 'e2'
interface Logger { info(message: string): Fx<void> }
const Logger = service<Logger>()('Logger')
const greet = fx(function* () { const log = yield* Logger; yield* log.info('hi') })
await run(greet(), [])
`

const FLOATING = `import { sync } from 'e2'
export function forgetful(): void {
  sync(() => 1)
}
`

const NODE_CONSUMER = `import { fx, run, service, sync } from 'e2'
const Logger = service()('Logger')
const LoggerLive = Logger.of({ info: () => sync(() => undefined) })
const greet = fx(function* (name) { const log = yield* Logger; yield* log.info(name); return name.length })
const result = await run(greet('e2'), [LoggerLive])
if (!result.ok || result.value !== 2) throw new Error('unexpected result: ' + JSON.stringify(result))
`

const ESLINT_CONFIG = `import parser from '@typescript-eslint/parser'
import e2 from 'eslint-plugin-e2'
export default [{
  files: ['**/*.ts'],
  languageOptions: { parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  plugins: { e2 },
  rules: { 'e2/no-floating-fx': 'error' },
}]
`

/** Installs the tarballs into a throwaway project and uses them the way a consumer would. */
export const VerifierLive = Verifier.make(function* () {
  const config = yield* Config
  const shell = yield* Shell
  const log = yield* Log

  return {
    verify: (tarballs, version) =>
      // `scoped`: the scratch project is removed when verification ends - passed,
      // failed, or interrupted by Ctrl+C - not when the whole release does.
      scoped(
        gen(function* () {
          const scratch = yield* acquire(
            () => mkdtemp(join(tmpdir(), 'e2-release-')),
            (dir) => rm(dir, { recursive: true, force: true })
          )
          const write = (name: string, text: string) =>
            fromPromise(() => Bun.write(join(scratch, name), text))
          const inScratch = (command: readonly string[]) =>
            shell.run(command, { cwd: scratch, quiet: true })
          const fail = (message: string) => err(new VerificationFailed(message))

          const { devDependencies } = yield* fromPromise(
            async () =>
              (await Bun.file(join(config.root, 'package.json')).json()) as {
                devDependencies: Record<string, string>
              }
          )
          yield* write(
            'package.json',
            JSON.stringify({
              name: 'e2-release-check',
              private: true,
              type: 'module',
            })
          )
          yield* inScratch([
            'npm',
            'install',
            '--silent',
            '--no-audit',
            '--no-fund',
            ...tarballs.map((tarball) => tarball.tarball),
            'typescript@5.9.3',
            `eslint@${devDependencies.eslint}`,
            `@typescript-eslint/parser@${devDependencies['@typescript-eslint/parser']}`,
          ])

          // The strictest common consumer setup: Node's own ESM resolution, libraries checked too.
          yield* write(
            'tsconfig.json',
            JSON.stringify({
              compilerOptions: {
                target: 'ES2022',
                module: 'nodenext',
                moduleResolution: 'nodenext',
                strict: true,
                noEmit: true,
                skipLibCheck: false,
              },
              include: ['ok.ts', 'floating.ts'],
            })
          )
          yield* write('ok.ts', CONSUMER)
          yield* write('floating.ts', FLOATING)
          const types = yield* attemptFx(inScratch(['npx', 'tsc', '-p', '.']))
          if (!types.ok)
            return yield* fail(
              `a consumer on nodenext resolution does not type-check:\n${types.error.output}`
            )
          yield* log.info(
            'e2 types: a consumer on nodenext resolution type-checks'
          )

          // The diagnostic the library is built around has to survive packing.
          yield* write('missing.ts', MISSING_SERVICE)
          const missing = yield* attemptFx(
            inScratch([
              'npx',
              'tsc',
              '--noEmit',
              '--strict',
              '--target',
              'ES2022',
              '--module',
              'nodenext',
              '--moduleResolution',
              'nodenext',
              'missing.ts',
            ])
          )
          if (
            missing.ok ||
            !missing.error.output.includes('"e2: missing service Logger"')
          ) {
            return yield* fail(
              `the missing-service diagnostic did not survive packing:\n${missing.ok ? '(it compiled)' : missing.error.output}`
            )
          }
          yield* log.info(
            'e2 types: a missing service still reads "e2: missing service Logger"'
          )

          yield* write('ok.mjs', NODE_CONSUMER)
          const node = yield* attemptFx(inScratch(['node', 'ok.mjs']))
          if (!node.ok)
            return yield* fail(
              `the compiled package does not run on Node:\n${node.error.output}`
            )
          yield* log.info(
            `e2 runtime: Node ${(yield* inScratch(['node', '--version'])).stdout} runs it`
          )

          // The plugin, loaded by a real ESLint from its tarball, flags a dropped effect.
          yield* write('eslint.config.mjs', ESLINT_CONFIG)
          const lint = yield* attemptFx(
            inScratch([
              'npx',
              'eslint',
              '--format',
              'json',
              'ok.ts',
              'floating.ts',
            ])
          )
          const report = lint.ok ? lint.value.stdout : lint.error.output
          const reports = yield* sync(() => {
            try {
              return JSON.parse(report) as {
                filePath: string
                messages: { ruleId: string | null }[]
              }[]
            } catch {
              return undefined
            }
          })
          if (reports === undefined)
            return yield* fail(`eslint did not run:\n${report}`)
          const messages = (file: string) =>
            reports.find((entry) => entry.filePath.endsWith(file))?.messages ??
            []
          if (messages('ok.ts').length > 0)
            return yield* fail(
              `eslint-plugin-e2 reported a clean file:\n${JSON.stringify(messages('ok.ts'))}`
            )
          if (
            !messages('floating.ts').some(
              (message) => message.ruleId === 'e2/no-floating-fx'
            )
          ) {
            return yield* fail('eslint-plugin-e2 missed a floating effect')
          }
          const reported = (yield* inScratch([
            'node',
            '-e',
            "import('eslint-plugin-e2').then((m) => console.log(m.default.meta.version))",
          ])).stdout
          if (reported !== version)
            return yield* fail(
              `eslint-plugin-e2 reports version ${reported}, expected ${version}`
            )
          yield* log.info(
            'eslint-plugin-e2: flags a dropped effect, passes a clean file'
          )
        })
      ),
  }
})
