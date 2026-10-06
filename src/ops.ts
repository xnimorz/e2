import { Die, Fail, Interrupt, type AnyCause, type Exit } from './cause.ts'
import { Cell } from './cell.ts'
import { Fiber } from './fiber.ts'
import {
  Async,
  Chain,
  Raise,
  Recover,
  Suspend,
  Sync,
  Transform,
  WithFiber,
  WithServices,
  type AnyFx,
  type Fx,
} from './fx.ts'
import { asyncAllowed, start } from './interpreter.ts'
import { Err, Ok, err, ok, type Result } from './result.ts'
import { Scope, ScopeService, type Finalizer } from './scope.ts'
import type { ScopeName } from './service.ts'
import type { Maybe } from './types.ts'

/** Turns a settled outcome back into an effect that reproduces it exactly. */
const fromExit = <Value, Error>(exit: Exit<Value, Error>): Fx<Value, Error> =>
  exit.ok ? (new Ok(exit.value) as Fx<Value, Error>) : new Raise(exit.error)

// --- suspension ------------------------------------------------------------

/** Completes after `milliseconds`, cancelling its timer if interrupted. */
export const sleep = (milliseconds: number): Fx<void> =>
  new Async<void, never>((resume) => {
    const timer = setTimeout(() => resume(new Ok(undefined)), milliseconds)
    return () => clearTimeout(timer)
  })

/**
 * Lifts a promise-returning function.
 *
 * The fiber's `AbortSignal` is handed in explicitly, so cancellation reaches
 * `fetch` and anything else that speaks the standard protocol. There is no
 * ambient context to read it from, which is exactly why this works unchanged
 * in a browser.
 */
/**
 * Lifts a promise-returning function.
 *
 * Without `onReject` a rejection is a **defect**, exactly as a throw inside
 * `sync` is. That keeps the error channel honest: an unmapped failure is one
 * nobody has decided how to handle, and widening every caller's `Error` to
 * `unknown` would make exhaustive recovery impossible. Pass `onReject` to make
 * a failure expected.
 *
 * The fiber's `AbortSignal` is handed in explicitly, so cancellation reaches
 * `fetch` and anything else speaking the standard protocol. There is no
 * ambient context to read it from, which is why this works unchanged in a
 * browser.
 */
export function fromPromise<Value>(
  make: (signal: AbortSignal) => Promise<Value>
): Fx<Value, never>
export function fromPromise<Value, Error>(
  make: (signal: AbortSignal) => Promise<Value>,
  onReject: (reason: unknown) => Error
): Fx<Value, Error>
export function fromPromise<Value, Error>(
  make: (signal: AbortSignal) => Promise<Value>,
  onReject?: (reason: unknown) => Error
): Fx<Value, Error> {
  return new Async<Value, Error>((resume, signal) => {
    make(signal).then(
      (value) => resume(new Ok(value) as never),
      (reason) =>
        resume(
          onReject === undefined
            ? (new Raise(new Die(reason)) as never)
            : (new Err(onReject(reason)) as never)
        )
    )
    return undefined
  })
}

// --- fibers ----------------------------------------------------------------

/**
 * Runs an effect on a child fiber.
 *
 * The child's lifetime is bound to the forking fiber: it inherits abort, and
 * the parent cannot complete until every child has settled. Forked work can
 * never outlive the thing that forked it.
 */
export const fork = <Value, Error, Dependency extends string>(
  effect: Fx<Value, Error, Dependency>
): Fx<Fiber, never, Dependency> =>
  new WithFiber((parent: Fiber) => {
    const child = parent.fork(effect as AnyFx)
    start(child, true)
    return new Ok(child)
  })

/** Waits for a fiber and reproduces its outcome, defects and all. */
export const join = <Value, Error>(fiber: Fiber): Fx<Value, Error> =>
  new Async<Value, Error>((resume) => {
    fiber.onSettle((exit) => resume(fromExit(exit as Exit<Value, Error>)))
    return undefined
  })

/** Waits for a fiber and reports its outcome as a value. Never fails. */
export const joinExit = <Value, Error>(fiber: Fiber): Fx<Exit<Value, Error>> =>
  new Async<Exit<Value, Error>, never>((resume) => {
    fiber.onSettle((exit) => resume(new Ok(exit as Exit<Value, Error>)))
    return undefined
  })

/** Interrupts a fiber and waits for it to finish unwinding. */
export const interruptFiber = (fiber: Fiber, reason?: string): Fx<void> =>
  new Async<void, never>((resume) => {
    fiber.onSettle(() => resume(new Ok(undefined)))
    fiber.interrupt(reason)
    return undefined
  })

// --- concurrency -----------------------------------------------------------

/**
 * Runs effects concurrently, failing as soon as any one of them does.
 *
 * On failure the survivors are interrupted and awaited before the failure
 * propagates, so nothing is left running behind the caller's back.
 */
export const all = <const Effects extends readonly AnyFx[]>(
  effects: Effects
): Fx<
  {
    -readonly [Index in keyof Effects]: Effects[Index] extends Fx<infer Value, any, any>
      ? Value
      : never
  },
  // The [never] guards matter: `Effects[number]` on an empty tuple is `never`,
  // and because an indexed access is not a naked type parameter the
  // conditional does not distribute - `never extends Fx<...>` is true and the
  // inference slots resolve to `unknown`, poisoning the channel.
  [Effects[number]] extends [never]
    ? never
    : Effects[number] extends Fx<any, infer Error, any>
      ? Error
      : never,
  [Effects[number]] extends [never]
    ? never
    : Effects[number] extends Fx<any, any, infer Dependency extends string>
      ? Dependency
      : never
> =>
  new WithFiber((parent: Fiber) => {
    if (effects.length === 0) {
      return new Ok([])
    }
    const fibers = effects.map((effect) => {
      const child = parent.fork(effect)
      start(child, true)
      return child
    })

    return new Async((resume) => {
      const values = new Array<unknown>(fibers.length)
      let remaining = fibers.length
      let done = false

      const stopOthers = (except: number, cause: AnyCause): void => {
        let pending = 0
        for (const [index, fiber] of fibers.entries()) {
          if (index !== except && fiber.state !== 'done') {
            pending += 1
            fiber.onSettle(() => {
              pending -= 1
              if (pending === 0) resume(new Raise(cause))
            })
            fiber.interrupt('sibling failed')
          }
        }
        if (pending === 0) resume(new Raise(cause))
      }

      for (const [index, fiber] of fibers.entries()) {
        fiber.onSettle((exit) => {
          if (done) return
          if (!exit.ok) {
            done = true
            stopOthers(index, exit.error)
            return
          }
          values[index] = exit.value
          remaining -= 1
          if (remaining === 0) {
            done = true
            resume(new Ok(values) as never)
          }
        })
      }
      return undefined
    })
  }) as never

/**
 * Runs two effects concurrently and takes whichever settles first.
 *
 * The loser is interrupted and *awaited* before the winner's result is
 * returned, so its finalizers have observably run - and observed
 * `Exit = Interrupt` - by the time the race resolves.
 */
export const race = <Value, Error, Dependency extends string>(
  left: Fx<Value, Error, Dependency>,
  right: Fx<Value, Error, Dependency>
): Fx<Value, Error, Dependency> =>
  new WithFiber((parent: Fiber) => {
    const first = parent.fork(left as AnyFx)
    const second = parent.fork(right as AnyFx)
    start(first, true)
    start(second, true)

    return new Async<Value, Error>((resume) => {
      let decided = false
      const settleWith = (loser: Fiber) => (exit: Exit<unknown, unknown>) => {
        if (decided) return
        decided = true
        if (loser.state === 'done') {
          resume(fromExit(exit as Exit<Value, Error>))
          return
        }
        loser.onSettle(() => resume(fromExit(exit as Exit<Value, Error>)))
        loser.interrupt('lost the race')
      }
      first.onSettle(settleWith(second))
      second.onSettle(settleWith(first))
      return undefined
    })
  })

/** Fails with `onTimeout` if the effect has not settled in time. */
export const timeout =
  <TimedOut>(milliseconds: number, onTimeout: () => TimedOut) =>
  <Value, Error, Dependency extends string>(
    effect: Fx<Value, Error, Dependency>
  ): Fx<Value, Error | TimedOut, Dependency> =>
    race<Value, Error | TimedOut, Dependency>(
      effect,
      new Chain(sleep(milliseconds), () => new Err(onTimeout())) as Fx<
        Value,
        Error | TimedOut,
        Dependency
      >
    )

// --- sharing ---------------------------------------------------------------

let memoCount = 0

/**
 * Runs an effect at most once per handle and shares the outcome.
 *
 * The primitive behind "initialise lazily, once, and let the first use
 * wait". Yielding `memo(fx)` does NOT run `fx`: it records fx's requirements
 * against the body it is yielded in (so they land in a provider's `Needs`),
 * captures the current service map and scope, and returns a handle with no
 * requirements of its own. Yielding the handle runs `fx` on first demand and
 * joins every concurrent demand to that one run; later demands get the
 * value.
 *
 * The run happens against the *captured* map, on a fiber with no parent. So
 * an `acquire` inside registers on the scope the memo was created in - the
 * runtime's, when created in a provider body - and a demander interrupted
 * while waiting stops waiting without cancelling the shared run. Failure is
 * not cached: joiners receive it, the cell resets, the next demand retries.
 *
 * A service key is an `Fx`, so `memo(Mps)` is how a provider says "I will
 * need Mps, later": `'Mps'` lands in its `Needs` now, and the handle resolves
 * - builds, joins, or returns - at the point of use.
 *
 * `eager` starts the run at the point of creation, in the background, so
 * demands arriving before it settles wait and demands arriving after do not.
 */
export const memo = <Value, Error, Dependency extends string>(
  effect: Fx<Value, Error, Dependency>,
  options?: { readonly eager?: boolean }
): Fx<Fx<Value, Error>, never, Dependency> =>
  new WithFiber((owner: Fiber) => {
    memoCount += 1
    const cell = new Cell(`memo#${memoCount}`, () => effect as AnyFx, owner.services)
    if (options?.eager === true) {
      cell.start(owner.chain, asyncAllowed(owner))
    }
    return new Ok(new WithFiber((demander: Fiber) => cell.demand(demander)))
  }) as Fx<Fx<Value, Error>, never, Dependency>

// --- batching --------------------------------------------------------------

/** What `batch` hands back: one operation over many items, reached one item at a time. */
export interface Batcher<In, Out, Error> {
  /**
   * Adds an item and waits for the batch it lands in. Each caller receives
   * its own element of the result, by position.
   */
  readonly add: (item: In) => Fx<Out, Error>
  /**
   * Adds an item and returns at once. The batch runs on the batcher's own
   * fiber; `flush` waits for it. This is write-behind.
   */
  readonly enqueue: (item: In) => Fx<void>
  /** Runs whatever is pending now and waits for every batch in flight. */
  readonly flush: Fx<void, Error>
  /** Items added but not yet handed to a run. */
  readonly pending: Fx<number>
}

type Waiter<Out, Error> = (exit: Exit<Out, Error>) => void

/**
 * Turns an operation over many items into one over single items whose calls
 * are coalesced: everything added while a batch is collecting goes into the
 * same run.
 *
 * A batch is collected until `window` milliseconds have passed since its
 * first item (default 0: the next turn of the event loop, which is what
 * makes "a hundred puts in one synchronous burst" one write) or until it
 * holds `maxSize` items, whichever comes first. The run happens on a fiber
 * with no parent, against the service map captured when the batcher was
 * made, so an `acquire` inside it registers on the scope the batcher was
 * created in, and a caller interrupted while waiting does not cancel a
 * shared run. Whatever is still pending when that scope closes is flushed
 * by a finalizer, so nothing enqueued is lost at shutdown.
 *
 * Failure of a run reaches every `add` waiting on it and the next `flush`;
 * the following batch is independent. A run that produces a different number
 * of results than it was given items is a defect.
 *
 * `add` parks, so it needs an asynchronous entry point; `enqueue` and `flush`
 * work under `runSync` when the run itself is synchronous.
 */
export const batch = <In, Out, Error, Dependency extends string>(
  run: (items: readonly In[]) => Fx<readonly Out[], Error, Dependency>,
  options: { readonly window?: number; readonly maxSize?: number } = {}
): Fx<Batcher<In, Out, Error>, never, Dependency | ScopeName> =>
  new Chain(ScopeService, (scope: Scope) =>
    new WithFiber((owner: Fiber) => {
      const window = options.window ?? 0
      const maxSize = options.maxSize ?? Number.POSITIVE_INFINITY
      let items: In[] = []
      let waiters: Maybe<Waiter<Out, Error>>[] = []
      let timer: ReturnType<typeof setTimeout> | undefined
      const inFlight = new Set<Fiber>()

      const startBatch = (allowAsync: boolean): void => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (items.length === 0) {
          return
        }
        const batchItems = items
        const batchWaiters = waiters
        items = []
        waiters = []

        const fiber = new Fiber(run(batchItems) as AnyFx, owner.services)
        fiber.chain = owner.chain
        inFlight.add(fiber)
        fiber.onSettle((exit) => {
          inFlight.delete(fiber)
          let outcome: (index: number) => Exit<Out, Error>
          if (!exit.ok) {
            outcome = () => exit as Exit<Out, Error>
          } else {
            const results = exit.value as readonly Out[]
            outcome =
              results.length === batchItems.length
                ? (index) => ok(results[index] as Out)
                : () =>
                    err(
                      new Die(
                        new Error(
                          `e2: batch produced ${results.length} results for ${batchItems.length} items`
                        )
                      )
                    )
          }
          batchWaiters.forEach((waiter, index) => waiter?.(outcome(index)))
        })
        start(fiber, allowAsync)
      }

      const submit = (item: In, waiter: Maybe<Waiter<Out, Error>>, demander: Fiber): void => {
        items.push(item)
        waiters.push(waiter)
        if (items.length >= maxSize) {
          startBatch(asyncAllowed(demander))
        } else if (timer === undefined) {
          timer = setTimeout(() => startBatch(true), window)
        }
      }

      const add = (item: In): Fx<Out, Error> =>
        new WithFiber((demander: Fiber) =>
          new Async<Out, Error>((resume) => {
            submit(item, (exit) => resume(fromExit(exit) as never), demander)
            return undefined
          })
        )

      const enqueue = (item: In): Fx<void> =>
        new WithFiber((demander: Fiber) => {
          submit(item, undefined, demander)
          return new Ok(undefined)
        })

      const flush: Fx<void, Error> = new WithFiber((demander: Fiber) => {
        startBatch(asyncAllowed(demander))
        const running = [...inFlight]
        if (running.length === 0) {
          return new Ok(undefined)
        }
        return new Async<void, Error>((resume) => {
          let remaining = running.length
          let failed: Maybe<AnyCause>
          for (const fiber of running) {
            fiber.onSettle((exit) => {
              if (!exit.ok && failed == null) {
                failed = exit.error
              }
              remaining -= 1
              if (remaining === 0) {
                resume((failed == null ? new Ok(undefined) : new Raise(failed)) as never)
              }
            })
          }
          return undefined
        })
      })

      const pending: Fx<number> = new Sync(() => items.length)

      scope.addFinalizer(() => flush as AnyFx)

      const batcher: Batcher<In, Out, Error> = { add, enqueue, flush, pending }
      return new Ok(batcher)
    })
  ) as Fx<Batcher<In, Out, Error>, never, Dependency | ScopeName>

// --- scopes and resources --------------------------------------------------

/** Registers a finalizer on the ambient scope. */
export const addFinalizer = (finalizer: Finalizer): Fx<void, never, ScopeName> =>
  new Chain(ScopeService, (scope: Scope) =>
    new Sync(() => scope.addFinalizer(finalizer))
  ) as Fx<void, never, ScopeName>

/**
 * Acquires a resource and registers its release on the ambient scope.
 *
 * `close` receives the `Exit` that closed the scope, so it can distinguish
 * success from failure from interruption - commit versus rollback, or "this
 * request was cancelled, do not bill for it". That distinction is the whole
 * reason a scope is not just a list of cleanup callbacks.
 *
 * As with `fromPromise`, a failure to open is a defect unless `onError` maps
 * it into the error channel. Release failures are always swallowed: a scope
 * that stops closing halfway through is worse than a lost cleanup error.
 */
/**
 * Whether `value` is a promise. Not `instanceof Promise`: that is false for a
 * promise from another realm (an iframe, a worker's transfer, a VM context)
 * and for runtimes' own subclasses - Bun's `node:fs/promises` returns one.
 */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function'

export function acquire<Value>(
  open: (signal: AbortSignal) => Value | Promise<Value>,
  close: (resource: Value, exit: Exit<unknown, unknown>) => void | Promise<void>
): Fx<Value, never, ScopeName>
export function acquire<Value, Error>(
  open: (signal: AbortSignal) => Value | Promise<Value>,
  close: (resource: Value, exit: Exit<unknown, unknown>) => void | Promise<void>,
  onError: (reason: unknown) => Error
): Fx<Value, Error, ScopeName>
export function acquire<Value, Error>(
  open: (signal: AbortSignal) => Value | Promise<Value>,
  close: (resource: Value, exit: Exit<unknown, unknown>) => void | Promise<void>,
  onError?: (reason: unknown) => Error
): Fx<Value, Error, ScopeName> {
  const failed = (reason: unknown): AnyFx =>
    onError === undefined ? new Raise(new Die(reason)) : new Err(onError(reason))

  return new Chain(ScopeService, (scope: Scope) =>
    new Chain(
      new Async<Value, Error>((resume, signal) => {
        try {
          const opened = open(signal)
          if (isThenable(opened)) {
            opened.then(
              (resource) => resume(new Ok(resource) as never),
              (reason) => resume(failed(reason) as never)
            )
          } else {
            resume(new Ok(opened) as never)
          }
        } catch (thrown) {
          resume(failed(thrown) as never)
        }
        return undefined
      }),
      (resource: Value) =>
        new Sync(() => {
          scope.addFinalizer((exit) =>
            new Async<void, never>((resume) => {
              try {
                const closed = close(resource, exit)
                if (isThenable(closed)) {
                  closed.then(
                    () => resume(new Ok(undefined)),
                    () => resume(new Ok(undefined))
                  )
                } else {
                  resume(new Ok(undefined))
                }
              } catch {
                resume(new Ok(undefined))
              }
              return undefined
            })
          )
          return resource
        })
    )
  ) as Fx<Value, Error, ScopeName>
}

/**
 * Runs an effect with a fresh scope, closing it when the effect settles.
 *
 * Discharges the `Scope` requirement, which is why the result no longer names
 * it as a dependency.
 */
export const scoped = <Value, Error, Dependency extends string>(
  effect: Fx<Value, Error, Dependency>
): Fx<Value, Error, Exclude<Dependency, ScopeName>> =>
  new Suspend(() => {
    const scope = new Scope()
    const provided = new WithServices(effect, [[ScopeService, scope]])
    return new Chain(
      new Recover(
        provided,
        (cause: AnyCause) =>
          new Chain(scope.close(err(cause)), () => new Raise(cause)),
        true
      ),
      (value: Value) => new Chain(scope.close(ok(value)), () => new Ok(value))
    )
  }) as Fx<Value, Error, Exclude<Dependency, ScopeName>>

/** Runs a finalizer when the effect settles, whatever the outcome. */
export const ensuring =
  (finalizer: Finalizer) =>
  <Value, Error, Dependency extends string>(
    effect: Fx<Value, Error, Dependency>
  ): Fx<Value, Error, Dependency> =>
    new Chain(
      new Recover(
        effect,
        (cause: AnyCause) => new Chain(finalizer(err(cause)), () => new Raise(cause)),
        true
      ),
      (value: Value) => new Chain(finalizer(ok(value)), () => new Ok(value))
    ) as Fx<Value, Error, Dependency>

/** Maps a failure without touching the success path. */
export const mapError =
  <Error, Next>(transform: (error: Error) => Next) =>
  <Value, Dependency extends string>(
    effect: Fx<Value, Error, Dependency>
  ): Fx<Value, Next, Dependency> =>
    new Recover(effect, (error: Error) => new Err(transform(error))) as Fx<
      Value,
      Next,
      Dependency
    >

/** Surfaces the outcome as a value, so nothing can fail. */
export const attempt = <Value, Error, Dependency extends string>(
  effect: Fx<Value, Error, Dependency>
): Fx<Result<Value, Error>, never, Dependency> =>
  new Transform(
    new Recover(effect, (error: Error) => new Ok(new Err(error))),
    (value: unknown) => (value instanceof Err ? value : new Ok(value))
  ) as Fx<Result<Value, Error>, never, Dependency>

export type { Maybe, Interrupt, Fail, Die }

// --- schedules -------------------------------------------------------------

/**
 * A retry or repeat policy.
 *
 * Deliberately one function rather than the full stateful-schedule algebra:
 * given the attempt number and the last error, say how long to wait, or
 * nothing to stop. That covers every policy anyone actually writes, composes
 * with plain methods, and is small enough to read in one sitting.
 */
export class Schedule {
  constructor(
    readonly next: (attempt: number, error: unknown) => Maybe<number>
  ) {}

  /** Retry immediately, at most `times` extra attempts. */
  static recurs(times: number): Schedule {
    return new Schedule((attempt) => (attempt < times ? 0 : undefined))
  }

  /** Retry forever, waiting a fixed interval. */
  static spaced(milliseconds: number): Schedule {
    return new Schedule(() => milliseconds)
  }

  /** Retry forever, doubling the wait each time. */
  static exponential(baseMilliseconds: number, factor = 2): Schedule {
    return new Schedule((attempt) => baseMilliseconds * factor ** attempt)
  }

  /** Never retry. */
  static readonly stop = new Schedule(() => undefined)

  /** Stop after `times` attempts, whatever the underlying policy says. */
  upTo(times: number): Schedule {
    return new Schedule((attempt, error) =>
      attempt < times ? this.next(attempt, error) : undefined
    )
  }

  /** Clamp the wait, so exponential backoff does not run away. */
  maxDelay(milliseconds: number): Schedule {
    return new Schedule((attempt, error) => {
      const delay = this.next(attempt, error)
      return delay == null ? undefined : Math.min(delay, milliseconds)
    })
  }

  /**
   * Spread the wait randomly across `[delay * (1 - factor), delay]`.
   *
   * Without this, every client that failed at the same moment retries at the
   * same moment, and the thundering herd takes the service down again.
   */
  jittered(factor = 0.5): Schedule {
    return new Schedule((attempt, error) => {
      const delay = this.next(attempt, error)
      return delay == null ? undefined : delay * (1 - factor * Math.random())
    })
  }

  /** Keep going only while the failure satisfies `predicate`. */
  whileError(predicate: (error: never) => boolean): Schedule {
    return new Schedule((attempt, error) =>
      predicate(error as never) ? this.next(attempt, error) : undefined
    )
  }
}

/**
 * Re-runs an effect while it keeps failing, following `schedule`.
 *
 * The effect is a description, not a running computation, so retrying is
 * simply reducing it again - no re-invocation ceremony, and no risk of
 * accidentally retrying a half-consumed generator.
 */
export const retry =
  (schedule: Schedule) =>
  <Value, Error, Dependency extends string>(
    effect: Fx<Value, Error, Dependency>
  ): Fx<Value, Error, Dependency> =>
    new Suspend(() => {
      let attempt = 0
      const again = (): AnyFx =>
        new Recover(effect, (error: Error) => {
          const delay = schedule.next(attempt, error)
          attempt += 1
          if (delay == null) {
            return new Err(error)
          }
          return new Chain(sleep(delay), () => again())
        })
      return again()
    }) as Fx<Value, Error, Dependency>

/** Re-runs an effect while it keeps succeeding, returning the last value. */
export const repeat =
  (schedule: Schedule) =>
  <Value, Error, Dependency extends string>(
    effect: Fx<Value, Error, Dependency>
  ): Fx<Value, Error, Dependency> =>
    new Suspend(() => {
      let attempt = 0
      const again = (): AnyFx =>
        new Chain(effect, (value: Value) => {
          const delay = schedule.next(attempt, undefined)
          attempt += 1
          if (delay == null) {
            return new Ok(value)
          }
          return new Chain(sleep(delay), () => again())
        })
      return again()
    }) as Fx<Value, Error, Dependency>

// --- iteration -------------------------------------------------------------

/**
 * Applies an effectful function to every item.
 *
 * `concurrency` defaults to 1 - sequential - because unbounded concurrency
 * over a list of unknown length is how you exhaust a connection pool. Pass
 * `'unbounded'` deliberately.
 */
export const forEach =
  <Item, Value, Error, Dependency extends string>(
    apply: (item: Item, index: number) => Fx<Value, Error, Dependency>,
    options: { readonly concurrency?: number | 'unbounded' } = {}
  ) =>
  (items: Iterable<Item>): Fx<Value[], Error, Dependency> => {
    const list = [...items]
    const limit =
      options.concurrency === 'unbounded'
        ? list.length
        : Math.max(1, options.concurrency ?? 1)

    if (list.length === 0) {
      return new Ok([]) as Fx<Value[], Error, Dependency>
    }

    if (limit >= list.length) {
      return all(list.map(apply) as readonly AnyFx[]) as unknown as Fx<
        Value[],
        Error,
        Dependency
      >
    }

    return new Suspend(() => {
      const results = new Array<Value>(list.length)
      let cursor = 0

      const worker = (): AnyFx =>
        new Suspend(() => {
          if (cursor >= list.length) {
            return new Ok(undefined)
          }
          const index = cursor
          cursor += 1
          return new Chain(apply(list[index] as Item, index), (value: Value) => {
            results[index] = value
            return worker()
          })
        })

      return new Transform(
        all(Array.from({ length: limit }, worker)),
        () => results
      )
    }) as Fx<Value[], Error, Dependency>
  }
