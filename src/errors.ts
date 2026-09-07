import { JsError } from './types.ts'

/**
 * Base class for errors that participate in the `Error` channel.
 *
 * Extends the global `Error` (reached through the {@link JsError} alias,
 * because a type parameter named `Error` shadows the global in most of this
 * library) so stacks, `instanceof` and devtools all behave normally, and adds
 * the `_tag` discriminant that `catchTag`-style recovery matches on.
 */
export abstract class TaggedError<Service extends string> extends JsError {
  abstract readonly _tag: Service

  constructor(message?: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Raised when `runSync` reaches an operation that can only complete async. */
export class AsyncBoundary extends TaggedError<'AsyncBoundary'> {
  readonly _tag = 'AsyncBoundary' as const

  constructor(readonly trace?: string) {
    super(
      trace == null
        ? 'e2: runSync reached an asynchronous operation. Use run() instead.'
        : `e2: runSync reached an asynchronous operation at ${trace}. Use run() instead.`
    )
  }
}

/** Raised when a fiber is interrupted. */
export class Interrupted extends TaggedError<'Interrupted'> {
  readonly _tag = 'Interrupted' as const

  constructor(readonly reason?: string) {
    super(reason == null ? 'e2: interrupted' : `e2: interrupted - ${reason}`)
  }
}

/**
 * The ways a flat provider list can fail to describe a buildable graph.
 *
 * The types rule all of these out at every statically written call site, so
 * reaching one at runtime means the list was assembled dynamically. They
 * surface as defects.
 */
export class DuplicateProvider extends TaggedError<'DuplicateProvider'> {
  readonly _tag = 'DuplicateProvider' as const

  constructor(
    readonly service: string,
    readonly indices: readonly [number, number]
  ) {
    super(
      `e2: two providers supply "${service}" (at index ${indices[0]} and ${indices[1]}). ` +
        'A service may be provided exactly once; use distinct tags for distinct instances.'
    )
  }
}

export class CyclicDependency extends TaggedError<'CyclicDependency'> {
  readonly _tag = 'CyclicDependency' as const

  constructor(readonly cycle: readonly string[]) {
    super(`e2: dependency cycle ${cycle.join(' -> ')}`)
  }
}

export class MissingProvider extends TaggedError<'MissingProvider'> {
  readonly _tag = 'MissingProvider' as const

  constructor(
    readonly service: string,
    readonly requiredBy?: string
  ) {
    super(
      requiredBy == null
        ? `e2: missing service ${service} - no provider supplies it`
        : `e2: missing service ${service} - required by ${requiredBy}, but no provider supplies it`
    )
  }
}

/**
 * A provider marked `lazy` failed while being built inside somebody's
 * request.
 *
 * Its typed failure cannot appear in that request's signature - the request
 * never mentioned the service's construction - so it is reported as a defect
 * that names the service and carries the original error.
 */
export class ProviderFailed extends TaggedError<'ProviderFailed'> {
  readonly _tag = 'ProviderFailed' as const

  constructor(
    readonly service: string,
    readonly error: unknown
  ) {
    super(`e2: building service ${service} failed`, { cause: error })
  }
}

export type GraphError = DuplicateProvider | CyclicDependency | MissingProvider

