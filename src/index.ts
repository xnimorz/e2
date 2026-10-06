/**
 * e2 - typed dependency injection and structured control flow for TypeScript.
 */

// Explicit resource management is still landing across runtimes (Bun 1.3.12,
// Safari TP 250), so we interoperate with the protocol rather than depend on
// the syntax being present.
;(Symbol as { asyncDispose?: symbol }).asyncDispose ??= Symbol.for('Symbol.asyncDispose')
;(Symbol as { dispose?: symbol }).dispose ??= Symbol.for('Symbol.dispose')

// --- namespaces ------------------------------------------------------------
// `Fx` and `Result` are a type alias plus a const of the same name: a type and
// a value live in different declaration spaces, so `Fx<User, DbError, 'Db'>`
// and `Fx.map(...)` both work without Effect's `Effect.Effect<...>` stutter.
export { Fx, Result } from './namespace.ts'

import type { Fx as FxType } from './fx.ts'
import type { Result as ResultType } from './result.ts'

export type Fx<
  Value,
  Error = never,
  Dependency extends string = never,
> = FxType<Value, Error, Dependency>

export type Result<Value, Error = never> = ResultType<Value, Error>

export type {
  AnyFx,
  DependencyOf,
  FailureOf,
  FxIterator,
  FxVariance,
  FxYield,
  SuccessOf,
} from './fx.ts'
export {
  Async,
  Chain,
  Gen,
  Recover,
  Suspend,
  Raise,
  Sync,
  Transform,
  WithFiber,
  WithServices,
  async_,
  catchAll,
  flatMap,
  map,
  suspend,
  sync,
} from './fx.ts'

/** `succeed` and `fail` are `ok` and `err`: Result is the pure subset of Fx. */
export { ok as succeed, err as fail } from './result.ts'

export { fx, gen } from './gen.ts'
export type { DependenciesOf, ErrorOf, Returned } from './gen.ts'

export { Err, Ok, all, attempt, err, fromNullable, isErr, isOk, isResult, ok, partition } from './result.ts'
export type { AnyResult, ErrOf, OkOf } from './result.ts'

export { Die, Fail, Interrupt } from './cause.ts'
export type { AnyCause, Exit } from './cause.ts'

import type { Cause as CauseType } from './cause.ts'
/** Re-declared as an alias so the name can carry both the type and the
 *  namespace object below; `export type { Cause }` would collide with it. */
export type Cause<Error> = CauseType<Error>

import {
  die as causeDie,
  fail as causeFail,
  interrupt as causeInterrupt,
  isDie,
  isFail,
  isInterrupt,
  pretty,
  squash,
} from './cause.ts'

/**
 * Cause constructors and helpers.
 *
 * Namespaced because the top-level `fail` is the effect constructor - the one
 * you reach for constantly - while `Cause.fail` wraps an error for the
 * interpreter, which application code rarely touches.
 */
export const Cause = {
  fail: causeFail,
  die: causeDie,
  interrupt: causeInterrupt,
  isFail,
  isDie,
  isInterrupt,
  squash,
  pretty,
} as const

export {
  AsyncBoundary,
  CyclicDependency,
  DuplicateProvider,
  Interrupted,
  MissingProvider,
  ProviderFailed,
  TaggedError,
} from './errors.ts'
export type { GraphError } from './errors.ts'

// --- dependency injection --------------------------------------------------
// The whole surface: `service` defines a contract (optionally with its
// default), `.make` / `.of` implement it, `memo` defers work to first use,
// `lazy` keeps a provider out of the startup warm-up, and `run` / `runtime`
// take the flat list. `Provider` is the type the implementations have;
// nobody constructs one by hand.
export { SCOPE_NAME, Defaulted, Service, service } from './service.ts'
export type { AnyService, ApiOf, NameOf, ScopeName } from './service.ts'

export { ServiceMap, services } from './service_map.ts'

export { Provider, lazy } from './provider.ts'
export type {
  AnyProvider,
  Check,
  FailsWith,
  MissingServices,
  MissingMsg,
  NeedsOf,
  ProvidesOf,
} from './provider.ts'

export { Scope, ScopeService } from './scope.ts'
export type { Finalizer } from './scope.ts'

export type { Batcher } from './ops.ts'
export {
  Schedule,
  acquire,
  addFinalizer,
  all as allConcurrent,
  attempt as attemptFx,
  batch,
  ensuring,
  fork,
  fromPromise,
  interruptFiber,
  join,
  joinExit,
  forEach,
  mapError,
  memo,
  race,
  repeat,
  retry,
  scoped,
  sleep,
  timeout,
} from './ops.ts'

export { Fiber } from './fiber.ts'
export { interpretAsync, interpretSync, start } from './interpreter.ts'

export { Runtime, run, runExit, runSync, runSyncExit, runtime } from './run.ts'
export type { RuntimeOf, ServiceReport } from './run.ts'

export { assertNever, just } from './types.ts'
export type { Covariant, Equals, Invariant, JsError, Maybe, Wildcard } from './types.ts'
