/**
 * What differs between `bun run release` and `bun run release --dry-run`:
 * which repository checks run, and what happens to verified tarballs. Each
 * mode is a choice of one Repository and one Delivery in the provider list.
 */
import { attemptFx, err, forEach, gen, ok } from 'e2'
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

/** A real release: from a clean, pushed master, with the tag still free. */
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

/** A dry run releases nothing, so it can run from anywhere. */
export const AnyRepository = Repository.of({ check: () => ok(undefined) })

// --- deliveries ---------------------------------------------------------------------------
// Each resolves what it needs when it is built, so `deliver` itself needs nothing:
// the contract says so, and a method that reached for a service would not compile.

const names = (release: Release): string =>
  release.pending.map((pkg) => pkg.name).join(', ')

/** Publishes from this machine, asking for npm's one-time password, then pushes the tag. */
export const MachineDelivery = Delivery.make(function* () {
  const log = yield* Log
  const npm = yield* Npm
  const git = yield* Git
  const prompt = yield* Prompt
  const config = yield* Config
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
          `Publish ${names(release)} @ ${release.version} as "${config.distTag}", then push ${release.tag}?`
        )
        if (!yes)
          return yield* err(new Declined('nothing was published or tagged'))

        // Asked for here, not at startup: a code lasts about 30 seconds, and the
        // checks before this point take minutes.
        let otp =
          config.otp ??
          (yield* prompt.ask(
            'npm one-time password (press Enter if your account has none):'
          ))
        for (const tarball of release.tarballs) {
          for (let attempt = 1; ; attempt++) {
            const published = yield* attemptFx(
              npm.publish(tarball.tarball, {
                tag: config.distTag,
                dryRun: false,
                otp: otp === '' ? undefined : otp,
              })
            )
            if (published.ok) break
            if (published.error._tag !== 'OtpRejected' || attempt === 3)
              return yield* err(published.error)
            otp = yield* prompt.ask(
              `npm did not accept that code. A fresh one-time password for ${tarball.name}:`
            )
          }
        }

        yield* git.pushTag(release.tag, `Release ${release.version}`)
        return `published ${names(release)} @ ${release.version} and pushed ${release.tag}`
      }),
  }
})

/** `--dry-run`: `npm publish --dry-run` for each tarball; nothing is published or tagged. */
export const DryRunDelivery = Delivery.make(function* () {
  const log = yield* Log
  const npm = yield* Npm
  const config = yield* Config
  return {
    preflight: ok(undefined),
    deliver: (release) =>
      gen(function* () {
        yield* log.step('Publish (dry run)')
        yield* forEach((tarball: Packed) =>
          npm.publish(tarball.tarball, { tag: config.distTag, dryRun: true })
        )(release.tarballs)
        return 'dry run complete; nothing was published or tagged'
      }),
  }
})
