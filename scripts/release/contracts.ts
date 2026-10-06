/**
 * The release, described as the services it needs.
 *
 * Every outside effect - a shell, git, the npm registry, the terminal - is a
 * service, so the release logic in release.ts never touches one directly.
 * That is what lets modes be provider lists (modes.ts) and lets the logic be
 * tested against doubles (release.spec.ts) without git or npm.
 */
import { TaggedError, service, type Fx } from 'e2'
import type { Package } from '../build.ts'

export type { Package }

// --- failures ---------------------------------------------------------------------
// Expected outcomes of a release, each reported differently. A thrown
// exception anywhere is a bug and surfaces as a defect instead.

/** The release must not start: wrong branch, dirty tree, tag taken, versions differ. */
export class ReleaseBlocked extends TaggedError<'ReleaseBlocked'> {
  readonly _tag = 'ReleaseBlocked' as const
}

/** A command exited non-zero. */
export class CommandFailed extends TaggedError<'CommandFailed'> {
  readonly _tag = 'CommandFailed' as const
  constructor(
    readonly command: string,
    readonly exitCode: number,
    readonly output: string
  ) {
    super(`\`${command}\` exited with ${exitCode}`)
  }
}

/** A packed tarball does not work the way a consumer would use it. */
export class VerificationFailed extends TaggedError<'VerificationFailed'> {
  readonly _tag = 'VerificationFailed' as const
}

/** The registry did not answer in time, even after retries. */
export class RegistryUnavailable extends TaggedError<'RegistryUnavailable'> {
  readonly _tag = 'RegistryUnavailable' as const
}

/** npm wants a one-time password, or a fresh one: the given code was missing, wrong or expired. */
export class OtpRejected extends TaggedError<'OtpRejected'> {
  readonly _tag = 'OtpRejected' as const
}

/** The person running the release said no. */
export class Declined extends TaggedError<'Declined'> {
  readonly _tag = 'Declined' as const
}

// --- configuration --------------------------------------------------------------------

export interface Config {
  readonly root: string
  readonly branch: string
  readonly distTag: string
  readonly packages: readonly Package[]
  /** `--otp`: a one-time password given up front, used if it is still valid at publish time. */
  readonly otp: string | undefined
}
export const Config = service<Config>()('Config')

// --- infrastructure -----------------------------------------------------------------------

export interface Output {
  readonly stdout: string
  readonly stderr: string
}

export interface ShellOptions {
  readonly cwd?: string
  /** Capture output instead of showing it. */
  readonly quiet?: boolean
  /** Show output and capture it too, for a caller that inspects a failure. */
  readonly tee?: boolean
  /** Added to the environment. Secrets go here, not in the command line. */
  readonly env?: Readonly<Record<string, string>>
}

export interface Shell {
  /** Runs a command. Interrupting kills the process. */
  run(
    command: readonly string[],
    options?: ShellOptions
  ): Fx<Output, CommandFailed>
}
export const Shell = service<Shell>()('Shell')

export interface Log {
  step(title: string): Fx<void>
  info(line: string): Fx<void>
}
export const Log = service<Log>()('Log')

export interface Prompt {
  confirm(question: string): Fx<boolean>
  /** A line of input, trimmed; empty when nothing was typed. */
  ask(question: string): Fx<string>
}
export const Prompt = service<Prompt>()('Prompt')

// --- the outside world, at the level the release thinks about it ----------------------------

export interface Git {
  readonly branch: Fx<string, CommandFailed>
  readonly isClean: Fx<boolean, CommandFailed>
  readonly head: Fx<string, CommandFailed>
  remoteHead(branch: string): Fx<string, CommandFailed>
  tagExists(tag: string): Fx<boolean, CommandFailed>
  pushTag(tag: string, message: string): Fx<void, CommandFailed>
}
export const Git = service<Git>()('Git')

export interface Packed {
  readonly name: string
  readonly tarball: string
  readonly files: readonly string[]
  readonly size: number
}

export interface Npm {
  isPublished(name: string, version: string): Fx<boolean, RegistryUnavailable>
  readonly whoami: Fx<string | undefined>
  pack(pkg: Package, destination: string): Fx<Packed, CommandFailed>
  publish(
    tarball: string,
    options: {
      readonly tag: string
      readonly dryRun: boolean
      /** A one-time password, for an account with two-factor authentication. */
      readonly otp?: string
    }
  ): Fx<void, CommandFailed | OtpRejected>
}
export const Npm = service<Npm>()('Npm')

export interface Workspace {
  version(pkg: Package): Fx<string>
  /** Typecheck, lint and tests. */
  readonly check: Fx<void, CommandFailed>
  build(pkg: Package): Fx<void, CommandFailed>
  /** An empty directory for the tarballs, recreated per release. */
  readonly releaseDir: Fx<string>
}
export const Workspace = service<Workspace>()('Workspace')

export interface Verifier {
  /** Installs the tarballs into a scratch project and uses them as a consumer would. */
  verify(
    tarballs: readonly Packed[],
    version: string
  ): Fx<void, VerificationFailed | CommandFailed>
}
export const Verifier = service<Verifier>()('Verifier')

// --- what differs between modes ------------------------------------------------------------------

export interface Release {
  readonly version: string
  readonly tag: string
  /** Packages not yet on npm at this version. */
  readonly pending: readonly Package[]
  readonly tarballs: readonly Packed[]
}

/** Whether the repository is in a state to release from. */
export interface Repository {
  check(tag: string): Fx<void, ReleaseBlocked | CommandFailed>
}
export const Repository = service<Repository>()('Repository')

/** What happens to verified tarballs: a publish, or a dry run of one. */
export interface Delivery {
  /** Checked before the slow part, so a doomed release fails in seconds. */
  readonly preflight: Fx<void, ReleaseBlocked>
  deliver(release: Release): Fx<string, CommandFailed | OtpRejected | Declined>
}
export const Delivery = service<Delivery>()('Delivery')
