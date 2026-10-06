/**
 * What differs between `bun run release`, `--dry-run`, `--publish` and `--ci`:
 * which repository checks run, and what happens to verified tarballs. Each
 * mode is a choice of one Repository and one Delivery in the provider list.
 */
import { err, forEach, gen, ok } from 'e2'
import {
  Config,
  Declined,
  Delivery,
  Git,
  Log,
  Npm,
  Prompt,
  ReleaseBlocked,
  Repository,
  type Packed,
  type Release,
} from './contracts.ts'

// --- repositories ---------------------------------------------------------------------

/** A release cut by hand: from a clean, pushed master, with the tag still free. */
export const LocalRepository = Repository.make(function* () {
  const config = yield* Config
  const git = yield* Git
  return {
    check: (tag) =>
      gen(function* () {
        const branch = yield* git.branch
        if (branch !== config.branch) {
          return yield* err(
            new ReleaseBlocked(
              `releases are cut from ${config.branch}, not ${branch}`
            )
          )
        }
        if (!(yield* git.isClean))
          return yield* err(new ReleaseBlocked('the working tree is not clean'))
        const head = yield* git.head
        if (head !== (yield* git.remoteHead(config.branch))) {
          return yield* err(
            new ReleaseBlocked(
              `HEAD is not origin/${config.branch}; push or pull first`
            )
          )
        }
        if (yield* git.tagExists(tag))
          return yield* err(new ReleaseBlocked(`tag ${tag} already exists`))
      }),
  }
})

/** A release triggered by a pushed tag: the tag must match the version and sit on master. */
export const CiRepository = Repository.make(function* () {
  const config = yield* Config
  const git = yield* Git
  return {
    check: (tag) =>
      gen(function* () {
        if (config.pushedTag !== tag) {
          return yield* err(
            new ReleaseBlocked(
              `the pushed tag is ${config.pushedTag ?? '(none)'}, but package.json says ${tag}`
            )
          )
        }
        if (!(yield* git.isOn(config.branch)))
          return yield* err(
            new ReleaseBlocked(`${tag} is not on ${config.branch}`)
          )
      }),
  }
})

/** A dry run releases nothing, so it can run from anywhere. */
export const AnyRepository = Repository.of({ check: () => ok(undefined) })

// --- deliveries ---------------------------------------------------------------------------
// Each resolves what it needs when it is built, so `deliver` itself needs nothing:
// the contract says so, and a method that reached for a service would not compile.

const names = (release: Release): string =>
  release.pending.map((pkg) => pkg.name).join(', ')

/** `npm publish` for each tarball, in order. */
const publisher = gen(function* () {
  const npm = yield* Npm
  const config = yield* Config
  return (
    tarballs: readonly Packed[],
    options: { readonly provenance: boolean; readonly dryRun: boolean }
  ) =>
    forEach((tarball: Packed) =>
      npm.publish(tarball.tarball, { tag: config.distTag, ...options })
    )(tarballs)
})

export const DryRunDelivery = Delivery.make(function* () {
  const log = yield* Log
  const publish = yield* publisher
  return {
    preflight: ok(undefined),
    deliver: (release) =>
      gen(function* () {
        yield* log.step('Publish (dry run)')
        yield* publish(release.tarballs, { provenance: false, dryRun: true })
        return 'dry run complete; nothing was published or tagged'
      }),
  }
})

/** CI publishes what a pushed tag asked for, with provenance linking each package to the run. */
export const CiDelivery = Delivery.make(function* () {
  const log = yield* Log
  const publish = yield* publisher
  return {
    preflight: ok(undefined),
    deliver: (release) =>
      gen(function* () {
        yield* log.step('Publish')
        yield* publish(release.tarballs, { provenance: true, dryRun: false })
        return `published ${names(release)} @ ${release.version}`
      }),
  }
})

/** `--publish`: from this machine, after asking, then the tag. */
export const MachineDelivery = Delivery.make(function* () {
  const log = yield* Log
  const npm = yield* Npm
  const git = yield* Git
  const prompt = yield* Prompt
  const config = yield* Config
  const publish = yield* publisher
  return {
    preflight: gen(function* () {
      const user = yield* npm.whoami
      if (user === undefined)
        return yield* err(
          new ReleaseBlocked('not logged in to npm; run `npm login` first')
        )
      yield* log.info(`npm user ${user}`)
    }),
    deliver: (release) =>
      gen(function* () {
        yield* log.step('Publish')
        const yes = yield* prompt.confirm(
          `Publish ${names(release)} @ ${release.version} as "${config.distTag}" from this machine, then push ${release.tag}?`
        )
        if (!yes)
          return yield* err(new Declined('nothing was published or tagged'))
        // npm asks for a one-time password itself when the account requires one.
        yield* publish(release.tarballs, { provenance: false, dryRun: false })
        yield* git.pushTag(release.tag, `Release ${release.version}`)
        return `published ${names(release)} @ ${release.version} and pushed ${release.tag}`
      }),
  }
})

/** The default: everything checks out locally, so push the tag and let CI publish. */
export const TagDelivery = Delivery.make(function* () {
  const log = yield* Log
  const git = yield* Git
  const prompt = yield* Prompt
  return {
    preflight: ok(undefined),
    deliver: (release) =>
      gen(function* () {
        yield* log.step('Tag')
        const yes = yield* prompt.confirm(
          `Everything checks out. Push ${release.tag}? The Release workflow publishes it.`
        )
        if (!yes) return yield* err(new Declined('nothing was tagged'))
        yield* git.pushTag(release.tag, `Release ${release.version}`)
        return `${release.tag} pushed; follow it at https://github.com/xnimorz/e2/actions/workflows/release.yml`
      }),
  }
})
