/**
 * The namespaced surface.
 *
 * `import { Fx, Result, Service } from 'e2'` and then reach for what you need,
 * rather than importing thirty loose names. Each namespace is a plain frozen
 * object, so it tree-shakes when a bundler can see through it and reads as one
 * vocabulary when it cannot.
 *
 * Where a concept is already a class - `Service`, `Runtime`, `Scope`,
 * `Schedule` - its operations live on the instance or as statics, so there
 * is exactly one name for it and it is both the type and the namespace. Only
 * the two that are not classes, `Fx` and `Result`, need a separate object
 * here.
 */

import {
  Async,
  Chain,
  Gen,
  Raise,
  Recover,
  Suspend,
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
import { fx as fxFn, gen } from './gen.ts'
import {
  Err,
  Ok,
  all as allResults,
  attempt as attemptResult,
  err,
  fromNullable,
  isErr,
  isOk,
  isResult,
  ok,
  partition,
} from './result.ts'
import {
  Schedule,
  acquire,
  addFinalizer,
  all,
  attempt,
  batch,
  ensuring,
  forEach,
  fork,
  fromPromise,
  interruptFiber,
  join,
  joinExit,
  mapError,
  memo,
  race,
  repeat,
  retry,
  scoped,
  sleep,
  timeout,
} from './ops.ts'
import { run, runExit, runSync, runSyncExit } from './run.ts'

/**
 * Everything you do to an effect.
 *
 * `succeed`/`fail` are `Ok`/`Err` under a friendlier name, because Result is
 * the pure subset of Fx and there is no separate representation.
 */
export const Fx = {
  // construction
  succeed: ok,
  fail: err,
  sync,
  suspend,
  async: async_,
  gen,
  fn: fxFn,
  fromPromise,
  sleep,

  // transformation
  map,
  flatMap,
  catchAll,
  mapError,
  attempt,

  // concurrency
  all,
  race,
  timeout,
  forEach,
  fork,
  join,
  joinExit,
  interrupt: interruptFiber,

  // policies
  retry,
  repeat,

  // resources and sharing
  scoped,
  acquire,
  addFinalizer,
  ensuring,
  memo,
  batch,

  // running
  run,
  runExit,
  runSync,
  runSyncExit,

  // instruction nodes, for building your own primitives
  nodes: {
    Async,
    Chain,
    Gen,
    Raise,
    Recover,
    Suspend,
    Sync,
    Transform,
    WithFiber,
    WithServices,
  },
} as const

/** The pure subset of Fx: an outcome you already hold. */
export const Result = {
  ok,
  err,
  isOk,
  isErr,
  is: isResult,
  all: allResults,
  attempt: attemptResult,
  partition,
  fromNullable,
  Ok,
  Err,
} as const

export { Schedule }
