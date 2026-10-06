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
  CiDelivery,
  CiRepository,
  DryRunDelivery,
  LocalRepository,
  MachineDelivery,
  TagDelivery,
} from './modes.ts'
import { release } from './program.ts'

/**
 * The release logic against doubles: no git, no npm, no filesystem. Each
 * test builds a world - a repository state, a registry, a terminal answer -
 * and runs the real program in it, with the mode's real Repository and
 * Delivery. What would have been published or pushed is recorded instead.
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
  pushedTag?: string
  branch?: string
  clean?: boolean
  behind?: boolean
  tagTaken?: boolean
  onMaster?: boolean
  published?: readonly string[]
  npmUser?: string
  answer?: boolean
  packedFiles?: readonly string[]
}

const PassingVerifier = Verifier.of({ verify: () => ok(undefined) })

/** Builds the doubles for one world, and the record of what they were asked to do. */
function world(
  state: World = {},
  verifier: typeof PassingVerifier = PassingVerifier
) {
  const did = {
    checked: false,
    published: [] as {
      tarball: string
      provenance: boolean
      dryRun: boolean
    }[],
    pushed: [] as string[],
    asked: [] as string[],
    log: [] as string[],
  }

  const providers = [
    Config.of({
      root: '/repo',
      branch: 'master',
      distTag: state.distTag ?? 'latest',
      packages: PACKAGES,
      pushedTag: state.pushedTag,
    }),
    Log.of({
      step: (title) => sync(() => void did.log.push(`▸ ${title}`)),
      info: (line) => sync(() => void did.log.push(line)),
    }),
    Prompt.of({
      confirm: (question) =>
        sync(() => {
          did.asked.push(question)
          return state.answer ?? true
        }),
    }),
    Git.of({
      branch: ok(state.branch ?? 'master'),
      isClean: ok(state.clean ?? true),
      head: ok('abc'),
      remoteHead: () => ok(state.behind ? 'def' : 'abc'),
      tagExists: () => ok(state.tagTaken ?? false),
      isOn: () => ok(state.onMaster ?? true),
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
        sync(
          () =>
            void did.published.push({
              tarball,
              provenance: options.provenance,
              dryRun: options.dryRun,
            })
        ),
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

describe('bun run release: verify, then push the tag', () => {
  test('pushes v3.0.0 and publishes nothing itself', async () => {
    const { did, providers } = world()
    const result = await run(release, [
      ...providers,
      LocalRepository,
      TagDelivery,
    ])
    expect(result.ok).toBe(true)
    expect(did.checked).toBe(true)
    expect(did.pushed).toEqual(['v3.0.0'])
    expect(did.published).toEqual([])
  })

  test('saying no pushes nothing', async () => {
    const { did, providers } = world({ answer: false })
    const result = await run(release, [
      ...providers,
      LocalRepository,
      TagDelivery,
    ])
    expect(failure(result)?._tag).toBe('Declined')
    expect(did.pushed).toEqual([])
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
      const { did, providers } = world(state)
      const result = await run(release, [
        ...providers,
        LocalRepository,
        TagDelivery,
      ])
      expect(failure(result)).toMatchObject({
        _tag: 'ReleaseBlocked',
        message: reason,
      })
      // Blocked before the slow part: nothing checked, nothing pushed.
      expect(did.checked).toBe(false)
      expect(did.pushed).toEqual([])
    }
  )

  test('a prerelease may go out under another dist-tag', async () => {
    const { did, providers } = world({
      distTag: 'next',
      versions: { e2: '3.1.0-beta.1', 'eslint-plugin-e2': '3.1.0-beta.1' },
    })
    const result = await run(release, [
      ...providers,
      LocalRepository,
      TagDelivery,
    ])
    expect(result.ok).toBe(true)
    expect(did.pushed).toEqual(['v3.1.0-beta.1'])
  })

  test('a tarball missing its declarations is not released', async () => {
    const { did, providers } = world({
      packedFiles: FILES.filter((file) => file !== 'lib/index.d.ts'),
    })
    const result = await run(release, [
      ...providers,
      LocalRepository,
      TagDelivery,
    ])
    expect(failure(result)).toMatchObject({
      _tag: 'VerificationFailed',
      message: 'e2 is missing lib/index.d.ts',
    })
    expect(did.pushed).toEqual([])
  })
})

describe('bun run release --dry-run', () => {
  test('publishes with --dry-run, pushes nothing, and runs from any branch', async () => {
    const { did, providers } = world({ branch: 'feature', clean: false })
    const result = await run(release, [
      ...providers,
      AnyRepository,
      DryRunDelivery,
    ])
    expect(result.ok).toBe(true)
    expect(did.published.map((entry) => entry.dryRun)).toEqual([true, true])
    expect(did.pushed).toEqual([])
  })
})

describe('bun run release --publish', () => {
  test('asks, publishes both packages from this machine, then tags', async () => {
    const { did, providers } = world({ npmUser: 'xnimorz' })
    const result = await run(release, [
      ...providers,
      LocalRepository,
      MachineDelivery,
    ])
    expect(result.ok).toBe(true)
    expect(did.asked).toHaveLength(1)
    expect(did.published.map((entry) => entry.tarball)).toEqual([
      '/out/e2.tgz',
      '/out/eslint-plugin-e2.tgz',
    ])
    expect(did.pushed).toEqual(['v3.0.0'])
  })

  test('not logged in to npm stops the release before the slow part', async () => {
    const { did, providers } = world({ npmUser: undefined })
    const result = await run(release, [
      ...providers,
      LocalRepository,
      MachineDelivery,
    ])
    expect(failure(result)).toMatchObject({
      _tag: 'ReleaseBlocked',
      message: 'not logged in to npm; run `npm login` first',
    })
    expect(did.checked).toBe(false)
  })

  test('saying no publishes nothing and tags nothing', async () => {
    const { did, providers } = world({ npmUser: 'xnimorz', answer: false })
    const result = await run(release, [
      ...providers,
      LocalRepository,
      MachineDelivery,
    ])
    expect(failure(result)?._tag).toBe('Declined')
    expect(did.published).toEqual([])
    expect(did.pushed).toEqual([])
  })
})

describe('bun run release --ci', () => {
  test('publishes with provenance for the matching tag', async () => {
    const { did, providers } = world({ pushedTag: 'v3.0.0' })
    const result = await run(release, [...providers, CiRepository, CiDelivery])
    expect(result.ok).toBe(true)
    expect(
      did.published.every((entry) => entry.provenance && !entry.dryRun)
    ).toBe(true)
    expect(did.pushed).toEqual([])
  })

  test('re-running after a partial release publishes only what is missing', async () => {
    const { did, providers } = world({ pushedTag: 'v3.0.0', published: ['e2'] })
    const result = await run(release, [...providers, CiRepository, CiDelivery])
    expect(result.ok).toBe(true)
    expect(did.published.map((entry) => entry.tarball)).toEqual([
      '/out/eslint-plugin-e2.tgz',
    ])
    expect(did.log).toContain('e2@3.0.0 is already on npm; skipping it')
  })

  test.each([
    [
      { pushedTag: 'v2.9.9' },
      'the pushed tag is v2.9.9, but package.json says v3.0.0',
    ],
    [{ pushedTag: 'v3.0.0', onMaster: false }, 'v3.0.0 is not on master'],
  ] satisfies [World, string][])('refuses when %o', async (state, reason) => {
    const { did, providers } = world(state)
    const result = await run(release, [...providers, CiRepository, CiDelivery])
    expect(failure(result)).toMatchObject({
      _tag: 'ReleaseBlocked',
      message: reason,
    })
    expect(did.published).toEqual([])
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
