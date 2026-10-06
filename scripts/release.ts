/**
 * Releases every package in scripts/build.ts at the version in package.json,
 * in lockstep: one version, one tag, one release.
 *
 *   bun run release              verify everything, then push tag vX.Y.Z; CI publishes
 *   bun run release --dry-run    verify everything and `npm publish --dry-run`; no tag
 *   bun run release --publish    verify, publish from this machine, then tag
 *   bun run release --ci         what the Release workflow runs for a pushed tag
 *
 *   --yes          do not ask before tagging or publishing
 *   --tag <name>   npm dist-tag, `latest` by default; required for prereleases
 *
 * The release is an e2 program (release/program.ts). A mode is nothing but a
 * provider list, chosen below; release/release.spec.ts runs the same program
 * against doubles. Ctrl+C interrupts it: running commands are killed and the
 * scratch project is removed before the process exits.
 */
import { join } from 'node:path'
import { Cause, assertNever, runtime, type Exit } from 'e2'
import { PACKAGES } from './build.ts'
import { Config } from './release/contracts.ts'
import {
  AutoConfirm,
  ConsoleLog,
  GitLive,
  NpmLive,
  ShellLive,
  TerminalPrompt,
  VerifierLive,
  WorkspaceLive,
} from './release/live.ts'
import {
  AnyRepository,
  CiDelivery,
  CiRepository,
  DryRunDelivery,
  LocalRepository,
  MachineDelivery,
  TagDelivery,
} from './release/modes.ts'
import { release, type ReleaseError } from './release/program.ts'

const args = process.argv.slice(2)
const mode = args.includes('--ci')
  ? 'ci'
  : args.includes('--dry-run')
    ? 'dry-run'
    : args.includes('--publish')
      ? 'publish'
      : 'tag'
const tagIndex = args.indexOf('--tag')
const distTag = tagIndex === -1 ? 'latest' : args[tagIndex + 1]
if (distTag === undefined || distTag.startsWith('--')) {
  console.error('release: --tag needs a value')
  process.exit(1)
}

const ConfigLive = Config.of({
  root: join(import.meta.dir, '..'),
  branch: 'master',
  distTag,
  packages: PACKAGES,
  pushedTag: process.env.GITHUB_REF_NAME,
})
const PromptLive =
  args.includes('--yes') || mode === 'ci' ? AutoConfirm : TerminalPrompt

const shared = [
  ConfigLive,
  ConsoleLog,
  PromptLive,
  ShellLive,
  GitLive,
  NpmLive,
  WorkspaceLive,
  VerifierLive,
] as const

// Each list is checked on its own: a mode that forgot a service would not compile.
const app = await (() => {
  switch (mode) {
    case 'tag':
      return runtime([...shared, LocalRepository, TagDelivery])
    case 'publish':
      return runtime([...shared, LocalRepository, MachineDelivery])
    case 'dry-run':
      return runtime([...shared, AnyRepository, DryRunDelivery])
    case 'ci':
      return runtime([...shared, CiRepository, CiDelivery])
  }
})()

console.log(
  `release: ${PACKAGES.map((pkg) => pkg.name).join(', ')} → npm "${distTag}" (${mode})`
)

const fiber = app.fork(release)
process.once('SIGINT', () => {
  console.log('\nrelease: interrupted; stopping and cleaning up…')
  fiber.interrupt('Ctrl+C')
})
const exit = await new Promise<Exit<string, ReleaseError>>((resolve) => {
  fiber.onSettle((settled) => resolve(settled as Exit<string, ReleaseError>))
})
await app.close()

const describe = (error: ReleaseError): string => {
  switch (error._tag) {
    case 'ReleaseBlocked':
      return error.message
    case 'CommandFailed':
      return `${error.message}${error.output ? `\n${error.output}` : ''}`
    case 'VerificationFailed':
      return `verification failed: ${error.message}`
    case 'RegistryUnavailable':
      return `the npm registry is unavailable: ${error.message}`
    case 'Declined':
      return `cancelled; ${error.message}`
    default:
      return assertNever(error)
  }
}

if (exit.ok) {
  console.log(`\nrelease: ${exit.value}`)
  process.exit(0)
}
const cause = exit.error
switch (cause._tag) {
  case 'Fail':
    console.error(`\n\x1b[31mrelease: ${describe(cause.error)}\x1b[0m`)
    process.exit(1)
  case 'Interrupt':
    console.error(
      '\nrelease: interrupted; running commands were stopped and temporary files removed'
    )
    process.exit(130)
  case 'Die':
    console.error(
      `\n\x1b[31mrelease: a bug in the release script\n${Cause.pretty(cause)}\x1b[0m`
    )
    process.exit(2)
}
