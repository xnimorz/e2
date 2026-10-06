/**
 * The release, as one e2 program. It reads like the checklist it is, and it
 * names no implementation: which repository checks run and what happens to
 * the tarballs is decided by the provider list (modes.ts).
 */
import { err, forEach, gen, type Fx } from 'e2'
import {
  Config,
  Delivery,
  Log,
  Npm,
  ReleaseBlocked,
  Repository,
  VerificationFailed,
  Verifier,
  Workspace,
  type Package,
  type Packed,
} from './contracts.ts'

const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'lib/index.js',
  'lib/index.d.ts',
]

/** Every package at one version, and a version that may go out under this dist-tag. */
export const lockstepVersion = gen(function* () {
  const config = yield* Config
  const workspace = yield* Workspace
  const versions = yield* forEach((pkg: Package) => workspace.version(pkg))(
    config.packages
  )

  const version = versions[0]
  if (version === undefined)
    return yield* err(new ReleaseBlocked('there are no packages to release'))
  if (versions.some((other) => other !== version)) {
    const listed = config.packages
      .map((pkg, index) => `${pkg.name}@${versions[index]}`)
      .join(', ')
    return yield* err(new ReleaseBlocked(`versions differ: ${listed}`))
  }
  if (!RELEASE_VERSION.test(version))
    return yield* err(
      new ReleaseBlocked(`"${version}" is not a release version`)
    )
  if (config.distTag === 'latest' && version.includes('-')) {
    return yield* err(
      new ReleaseBlocked(
        'a prerelease must be published with --tag, not as latest'
      )
    )
  }
  return version
})

/** The packages not yet on npm at `version`, so a half-finished release can be re-run. */
export const unpublished = (version: string) =>
  gen(function* () {
    const config = yield* Config
    const npm = yield* Npm
    const log = yield* Log

    const published = yield* forEach(
      (pkg: Package) => npm.isPublished(pkg.name, version),
      { concurrency: 'unbounded' }
    )(config.packages)
    const pending = config.packages.filter((_, index) => !published[index])
    for (const pkg of config.packages) {
      if (!pending.includes(pkg))
        yield* log.info(`${pkg.name}@${version} is already on npm; skipping it`)
    }
    return pending
  })

/** Builds and packs every package, and checks each tarball holds what a consumer needs and nothing else. */
export const packAll = gen(function* () {
  const config = yield* Config
  const workspace = yield* Workspace
  const npm = yield* Npm
  const log = yield* Log

  const destination = yield* workspace.releaseDir
  const packed: Packed[] = []
  for (const pkg of config.packages) {
    yield* workspace.build(pkg)
    const tarball = yield* npm.pack(pkg, destination)
    const missing = REQUIRED_FILES.filter(
      (file) => !tarball.files.includes(file)
    )
    if (missing.length > 0)
      return yield* err(
        new VerificationFailed(`${pkg.name} is missing ${missing.join(', ')}`)
      )
    const tests = tarball.files.filter(
      (file) => /(^|\/)tests?\//.test(file) || /\.spec\.[jt]s$/.test(file)
    )
    if (tests.length > 0)
      return yield* err(
        new VerificationFailed(
          `${pkg.name} includes test files: ${tests.join(', ')}`
        )
      )
    yield* log.info(
      `${pkg.name}: ${tarball.files.length} files, ${(tarball.size / 1024).toFixed(1)} KB packed`
    )
    packed.push(tarball)
  }
  return packed
})

export const release = gen(function* () {
  const log = yield* Log
  const repository = yield* Repository
  const delivery = yield* Delivery
  const workspace = yield* Workspace
  const verifier = yield* Verifier

  yield* log.step('Preconditions')
  const version = yield* lockstepVersion
  const tag = `v${version}`
  yield* repository.check(tag)
  const pending = yield* unpublished(version)
  if (pending.length === 0) {
    return yield* err(
      new ReleaseBlocked(`every package is already published at ${version}`)
    )
  }
  yield* delivery.preflight
  yield* log.info(
    `to release: ${pending.map((pkg) => `${pkg.name}@${version}`).join(', ')}`
  )

  yield* log.step('Typecheck, lint, tests')
  yield* workspace.check

  yield* log.step('Build and pack')
  // Every package is packed, published or not: the verification installs them together.
  const tarballs = yield* packAll

  yield* log.step('Verify the tarballs in a scratch project')
  yield* verifier.verify(tarballs, version)

  return yield* delivery.deliver({
    version,
    tag,
    pending,
    tarballs: tarballs.filter((tarball) =>
      pending.some((pkg) => pkg.name === tarball.name)
    ),
  })
})
// Fx<string, ReleaseBlocked | CommandFailed | RegistryUnavailable | VerificationFailed | OtpRejected | Declined,
//    'Log' | 'Repository' | 'Delivery' | 'Workspace' | 'Verifier' | 'Config' | 'Npm'>

export type ReleaseError =
  typeof release extends Fx<string, infer Error, string> ? Error : never
