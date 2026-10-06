import { describe, expect, test } from 'bun:test'
import {
  Schedule,
  acquire,
  err,
  fork,
  gen,
  interruptFiber,
  ok,
  run,
  scoped,
  sleep,
  sync,
} from 'e2'
import {
  CommandFailed,
  Config,
  Git,
  Log,
  Npm,
  OtpRejected,
  Prompt,
  Shell,
  Verifier,
  Workspace,
  type Package,
  type Packed,
} from './contracts.ts'
import { npmWith } from './live.ts'
import {
  AnyRepository,
  DryRunDelivery,
  LocalRepository,
  MachineDelivery,
} from './modes.ts'
import { release } from './program.ts'

/**
 * The release logic against doubles: no git, no npm, no filesystem. Each
 * test builds a world - a repository state, a registry, a person at the
 * terminal - and runs the real program in it, with the mode's real Repository
 * and Delivery. What would have been published or pushed is recorded instead.
 */

const PACKAGES: readonly Package[] = [
  { name: 'e2', dir: '/repo' },
  { name: 'eslint-plugin-e2', dir: '/repo/packages/eslint-plugin-e2' },
]
const FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'lib/index.js',
  'lib/index.d.ts',
]

interface World {
  versions?: Record<string, string>
  distTag?: string
  branch?: string
  clean?: boolean
  behind?: boolean
  tagTaken?: boolean
  published?: readonly string[]
  npmUser?: string
  /** The answer to "Publish …?". */
  answer?: boolean
  /** `--otp`. */
  otpFlag?: string
  /** What is typed at each one-time-password question, in order. */
  typed?: readonly string[]
  /** Codes npm accepts. Absent: the account has no two-factor authentication. */
  validCodes?: readonly string[]
  packedFiles?: readonly string[]
}

const PassingVerifier = Verifier.of({ verify: () => ok(undefined) })

/** Builds the doubles for one world, and the record of what they were asked to do. */
function world(
  state: World = {},
  verifier: typeof PassingVerifier = PassingVerifier
) {
  const typed = [...(state.typed ?? [])]
  const did = {
    checked: false,
    published: [] as {
      tarball: string
      dryRun: boolean
      otp: string | undefined
    }[],
    pushed: [] as string[],
    confirmed: [] as string[],
    asked: [] as string[],
    log: [] as string[],
  }

  const providers = [
    Config.of({
      root: '/repo',
      branch: 'master',
      distTag: state.distTag ?? 'latest',
      packages: PACKAGES,
      otp: state.otpFlag,
    }),
    Log.of({
      step: (title) => sync(() => void did.log.push(`▸ ${title}`)),
      info: (line) => sync(() => void did.log.push(line)),
    }),
    Prompt.of({
      confirm: (question) =>
        sync(() => {
          did.confirmed.push(question)
          return state.answer ?? true
        }),
      ask: (question) =>
        sync(() => {
          did.asked.push(question)
          return typed.shift() ?? ''
        }),
    }),
    Git.of({
      branch: ok(state.branch ?? 'master'),
      isClean: ok(state.clean ?? true),
      head: ok('abc'),
      remoteHead: () => ok(state.behind ? 'def' : 'abc'),
      tagExists: () => ok(state.tagTaken ?? false),
      pushTag: (tag) => sync(() => void did.pushed.push(tag)),
    }),
    Npm.of({
      isPublished: (name) => ok((state.published ?? []).includes(name)),
      whoami: ok(state.npmUser),
      pack: (pkg) =>
        ok<Packed>({
          name: pkg.name,
          tarball: `/out/${pkg.name}.tgz`,
          files: state.packedFiles ?? FILES,
          size: 1024,
        }),
      publish: (tarball, options) =>
        gen(function* () {
          const needsCode = state.validCodes !== undefined && !options.dryRun
          if (needsCode && !state.validCodes!.includes(options.otp ?? '')) {
            return yield* err(
              new OtpRejected('npm did not accept the one-time password')
            )
          }
          did.published.push({
            tarball,
            dryRun: options.dryRun,
            otp: options.otp,
          })
        }),
    }),
    Workspace.of({
      version: (pkg) => ok(state.versions?.[pkg.name] ?? '3.0.0'),
      check: sync(() => {
        did.checked = true
      }),
      build: () => ok(undefined),
      releaseDir: ok('/out'),
    }),
    verifier,
  ] as const

  return { did, providers }
}

const failure = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : (result.error as { _tag: string; message: string })

const publishing = (state: World = {}) => {
  const { did, providers } = world({ npmUser: 'xnimorz', ...state })
  return {
    did,
    result: run(release, [...providers, LocalRepository, MachineDelivery]),
  }
}

describe('bun run release', () => {
  test('asks, publishes both packages from this machine, then pushes the tag', async () => {
    const { did, result } = publishing()
    expect((await result).ok).toBe(true)
    expect(did.checked).toBe(true)
    expect(did.confirmed).toHaveLength(1)
    expect(did.published.map((entry) => entry.tarball)).toEqual([
      '/out/e2.tgz',
      '/out/eslint-plugin-e2.tgz',
    ])
    expect(did.published.every((entry) => !entry.dryRun)).toBe(true)
    expect(did.pushed).toEqual(['v3.0.0'])
  })

  test('saying no publishes nothing and tags nothing', async () => {
    const { did, result } = publishing({ answer: false })
    expect(failure(await result)?._tag).toBe('Declined')
    expect(did.published).toEqual([])
    expect(did.pushed).toEqual([])
  })

  test('not logged in to npm stops the release before the slow part', async () => {
    const { did, result } = publishing({ npmUser: undefined })
    expect(failure(await result)).toMatchObject({
      _tag: 'ReleaseBlocked',
      message: 'not logged in to npm; run `npm login` first',
    })
    expect(did.checked).toBe(false)
  })

  test.each([
    [{ branch: 'feature' }, 'releases are cut from master, not feature'],
    [{ clean: false }, 'the working tree is not clean'],
    [{ behind: true }, 'HEAD is not origin/master; push or pull first'],
    [{ tagTaken: true }, 'tag v3.0.0 already exists'],
    [
      { versions: { 'eslint-plugin-e2': '3.0.1' } },
      'versions differ: e2@3.0.0, eslint-plugin-e2@3.0.1',
    ],
    [
      { versions: { e2: '3.1.0-beta.1', 'eslint-plugin-e2': '3.1.0-beta.1' } },
      'a prerelease must be published with --tag, not as latest',
    ],
    [
      { published: ['e2', 'eslint-plugin-e2'] },
      'every package is already published at 3.0.0',
    ],
  ] satisfies [World, string][])(
    'refuses to start when %o',
    async (state, reason) => {
      const { did, result } = publishing(state)
      expect(failure(await result)).toMatchObject({
        _tag: 'ReleaseBlocked',
        message: reason,
      })
      // Blocked before the slow part: nothing checked, published or pushed.
      expect(did.checked).toBe(false)
      expect(did.published).toEqual([])
      expect(did.pushed).toEqual([])
    }
  )

  test('a prerelease may go out under another dist-tag', async () => {
    const { did, result } = publishing({
      distTag: 'next',
      versions: { e2: '3.1.0-beta.1', 'eslint-plugin-e2': '3.1.0-beta.1' },
    })
    expect((await result).ok).toBe(true)
    expect(did.pushed).toEqual(['v3.1.0-beta.1'])
  })

  test('a tarball missing its declarations is not released', async () => {
    const { did, result } = publishing({
      packedFiles: FILES.filter((file) => file !== 'lib/index.d.ts'),
    })
    expect(failure(await result)).toMatchObject({
      _tag: 'VerificationFailed',
      message: 'e2 is missing lib/index.d.ts',
    })
    expect(did.published).toEqual([])
  })

  test('re-running after a partial release publishes only what is missing', async () => {
    const { did, result } = publishing({ published: ['e2'] })
    expect((await result).ok).toBe(true)
    expect(did.published.map((entry) => entry.tarball)).toEqual([
      '/out/eslint-plugin-e2.tgz',
    ])
    expect(did.log).toContain('e2@3.0.0 is already on npm; skipping it')
  })
})

describe('bun run release: one-time passwords', () => {
  test('the code is asked for after the checks, right before publishing, and used for both packages', async () => {
    const { did, result } = publishing({
      validCodes: ['123456'],
      typed: ['123456'],
    })
    expect((await result).ok).toBe(true)
    expect(did.asked).toHaveLength(1)
    expect(did.log.indexOf('▸ Publish')).toBeGreaterThan(
      did.log.indexOf('▸ Verify the tarballs in a scratch project')
    )
    expect(did.published.map((entry) => entry.otp)).toEqual([
      '123456',
      '123456',
    ])
  })

  test('--otp is used without asking', async () => {
    const { did, result } = publishing({
      validCodes: ['654321'],
      otpFlag: '654321',
    })
    expect((await result).ok).toBe(true)
    expect(did.asked).toEqual([])
    expect(did.published.map((entry) => entry.otp)).toEqual([
      '654321',
      '654321',
    ])
  })

  test('an expired code is asked for again, and the release continues', async () => {
    // The code from --otp expired during the checks; a fresh one is typed.
    const { did, result } = publishing({
      validCodes: ['222222'],
      otpFlag: '111111',
      typed: ['222222'],
    })
    expect((await result).ok).toBe(true)
    expect(did.asked).toEqual([
      'npm did not accept that code. A fresh one-time password for e2:',
    ])
    expect(did.published.map((entry) => entry.otp)).toEqual([
      '222222',
      '222222',
    ])
    expect(did.pushed).toEqual(['v3.0.0'])
  })

  test('an account without two-factor authentication just presses Enter', async () => {
    const { did, result } = publishing({ typed: [''] })
    expect((await result).ok).toBe(true)
    expect(did.published.map((entry) => entry.otp)).toEqual([
      undefined,
      undefined,
    ])
  })

  test('three rejected codes stop the release without pushing a tag', async () => {
    const { did, result } = publishing({
      validCodes: ['999999'],
      typed: ['1', '2', '3'],
    })
    expect(failure(await result)?._tag).toBe('OtpRejected')
    expect(did.published).toEqual([])
    expect(did.pushed).toEqual([])
  })
})

describe('bun run release --dry-run', () => {
  test('publishes with --dry-run, asks nothing, pushes nothing, and runs from any branch', async () => {
    const { did, providers } = world({
      branch: 'feature',
      clean: false,
      validCodes: ['123456'],
    })
    const result = await run(release, [
      ...providers,
      AnyRepository,
      DryRunDelivery,
    ])
    expect(result.ok).toBe(true)
    expect(did.published.map((entry) => entry.dryRun)).toEqual([true, true])
    expect(did.asked).toEqual([])
    expect(did.pushed).toEqual([])
  })
})

describe('interruption', () => {
  test('Ctrl+C during verification removes the scratch project and publishes nothing', async () => {
    const scratch = {
      state: 'never opened' as 'never opened' | 'open' | 'removed',
    }
    const SlowVerifier = Verifier.of({
      verify: () =>
        scoped(
          gen(function* () {
            yield* acquire(
              () => {
                scratch.state = 'open'
              },
              () => {
                scratch.state = 'removed'
              }
            )
            yield* sleep(10_000) // npm install, say
          })
        ),
    })
    const { did, providers } = world({ npmUser: 'xnimorz' }, SlowVerifier)

    const result = await run(
      gen(function* () {
        const releasing = yield* fork(release)
        yield* sleep(30)
        yield* interruptFiber(releasing, 'Ctrl+C')
      }),
      [...providers, LocalRepository, MachineDelivery]
    )
    expect(result.ok).toBe(true)
    expect(scratch.state).toBe('removed')
    expect(did.published).toEqual([])
    expect(did.pushed).toEqual([])
  })
})

describe('NpmLive against a scripted shell', () => {
  /** A shell that answers `npm view` from a script, one reply per call. */
  const scripted = (
    replies: readonly ('published' | 'missing' | 'network')[]
  ) => {
    const calls = { count: 0 }
    const shell = Shell.of({
      run: () =>
        gen(function* () {
          const reply = replies[Math.min(calls.count, replies.length - 1)]
          calls.count += 1
          if (reply === 'published') return { stdout: '3.0.0', stderr: '' }
          if (reply === 'missing')
            return yield* err(
              new CommandFailed('npm view', 1, 'npm error code E404')
            )
          return yield* err(
            new CommandFailed('npm view', 1, 'npm error code ECONNRESET')
          )
        }),
    })
    return { calls, shell }
  }
  // The real NpmLive, with a schedule that retries three times without waiting.
  const NpmLive = npmWith(Schedule.recurs(3))
  const isPublished = gen(function* () {
    const npm = yield* Npm
    return yield* npm.isPublished('e2', '3.0.0')
  })

  test('not found is an answer, not a failure', async () => {
    const { calls, shell } = scripted(['missing'])
    expect(await run(isPublished, [NpmLive, shell])).toMatchObject({
      ok: true,
      value: false,
    })
    expect(calls.count).toBe(1)
  })

  test('a flaky registry is retried', async () => {
    const { calls, shell } = scripted(['network', 'network', 'published'])
    expect(await run(isPublished, [NpmLive, shell])).toMatchObject({
      ok: true,
      value: true,
    })
    expect(calls.count).toBe(3)
  })

  test('a registry that stays down is reported as unavailable', async () => {
    const { calls, shell } = scripted(['network'])
    const result = await run(isPublished, [NpmLive, shell])
    expect(failure(result)?._tag).toBe('RegistryUnavailable')
    expect(calls.count).toBe(4) // the first try and three retries
  })
})
