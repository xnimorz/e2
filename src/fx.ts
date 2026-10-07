import { FxTypeId, type Covariant, type Maybe, type YieldTypeId } from './types.ts'

/**
 * Phantom struct forcing Fx's type parameters into value positions.
 *
 * `Fx` is recursive through `[Symbol.iterator]`. The explicit `out` annotations
 * on it let TS compare two `Fx`s by type arguments instead of falling back to
 * deep structural comparison on every one of the thousands of such checks a
 * real program performs.
 */
export interface FxVariance<out Value, out Error, out Dependency> {
  readonly _Value: Covariant<Value>
  readonly _Error: Covariant<Error>
  readonly _Dependency: Covariant<Dependency>
}

/**
 * Occupies the TYield slot of every e2 generator.
 *
 * Deliberately NOT iterable. `Fx` being `Iterable<Fx>` makes the checker loop -
 * the circularity Effect had to patch in v3 (PR #2625, "Avoid circularity on
 * generators"). Effect's fix was a `YieldWrap` class allocated on every
 * `yield*`; ours is purely phantom, because at runtime we yield the Fx node
 * itself and only lie about its type here. Zero allocations.
 */
export interface FxYield<out Value, out Error, out Dependency extends string> {
  readonly [YieldTypeId]: FxVariance<Value, Error, Dependency>
}

/**
 * The iterator every {@link Fx} hands to `yield*`.
 *
 * `next` takes `...args: ReadonlyArray<any>` rather than a typed TNext.
 * Declaring `Iterator<Yielded, Value, never>` instead fails on *every* `yield*`
 * with TS2766 ("the 'next' method of its iterator expects type 'never', but the
 * containing generator will always send 'any'"), because when TS checks the
 * delegation the containing generator's own TNext is still uninferred `any`.
 *
 * `return` and `throw` are deliberately absent: their own type parameters leak
 * into the result type of `yield*`, so `const log = yield* Logger` infers
 * `LogSvc | Of` instead of `LogSvc`. TS needs only `next` to type a delegation.
 */
export interface FxIterator<out Yielded, out Value> {
  next(...args: ReadonlyArray<any>): IteratorResult<Yielded, Value>
}

/**
 * A lazy description of a computation producing `Value`, failing with `Error`,
 * and requiring the services named by `Dependency`.
 *
 * `Dependency` holds service *names* (`'Db' | 'Logger'`) rather than service types.
 * That keeps hovers and diagnostics readable - `Fx<User, DbError, 'Db'>` rather
 * than `Fx<User, DbError, Service<'Db', DbSvc>>` - and makes `Exclude` nominal by
 * construction. Two tags may not share a name; `Plan.from` enforces that.
 */
export interface Fx<out Value, out Error = never, out Dependency extends string = never> {
  readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value>
}

export type AnyFx = Fx<any, any, any>
export type AnyYield = FxYield<any, any, any>

/** The value an `Fx` produces when it succeeds. */
export type SuccessOf<Of> = Of extends Fx<infer Value, any, any> ? Value : never
/** The failures an `Fx` can produce. */
export type FailureOf<Of> = Of extends Fx<any, infer Error, any> ? Error : never
/** The service names an `Fx` requires. */
export type DependencyOf<Of> =
  Of extends Fx<any, any, infer Dependency> ? Dependency : never

/**
 * A generator body awaiting interpretation.
 *
 * `body` is a THUNK, called fresh on every run. Generator objects are
 * single-use, so storing one here would make the effect work exactly once -
 * the classic bug in hand-rolled effect systems. All mutable state belongs to
 * the fiber, never to a node: nodes are immutable and re-runnable.
 */
export class Gen<out Value, out Error, out Dependency extends string>
  implements Fx<Value, Error, Dependency>
{
  readonly _tag = 'Gen' as const

  declare readonly [FxTypeId]: FxVariance<Value, Error, Dependency>

  constructor(readonly body: () => Generator<AnyYield, Value, never>) {}

  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value> {
    return new SingleShot(this) as never
  }
}

/**
 * The iterator returned by every Fx node.
 *
 * Yields the node once so the interpreter can reduce it, then returns whatever
 * the interpreter sends back as the value of the `yield*`. Because it is
 * single-shot, native `yield*` delegation depth is always 1 no matter how deep
 * the chain of `fx`-defined functions runs: a 20-deep call chain costs 20
 * entries on the fiber's own continuation stack rather than 20 levels of
 * delegation for V8 to re-walk on every `next()`.
 */
export class SingleShot<Node> {
  done = false
  value: unknown
  private used = false

  constructor(node: Node) {
    this.value = node
  }

  next(...args: ReadonlyArray<any>): IteratorResult<Node, any> {
    // The iterator is its own result. `yield*` reads `done` and `value` off a
    // result before it calls `next` again, so handing back the same object,
    // updated, saves the two result objects every `yield*` used to allocate.
    if (this.used) {
      this.done = true
      this.value = args[0]
    } else {
      this.used = true
    }
    return this as IteratorResult<Node, any>
  }
}

// ---------------------------------------------------------------------------
// Instructions
//
// Every node is a small immutable class carrying a string `_tag` the
// interpreter switches on. Two constraints hold across all of them:
//
//   - A node is a description, never a thunk that returns a promise. Hiding
//     work behind an opaque closure would make trampolining, interruption and
//     runSync impossible.
//   - A node is immutable and re-runnable. All mutable state lives on the
//     fiber. That is why `Gen` and `Suspend` hold thunks: generator objects
//     are single-use, so storing one would make the effect work exactly once.
// ---------------------------------------------------------------------------

/** A synchronous side effect. Throwing inside `run` becomes a defect. */
export class Sync<out Value> implements Fx<Value, never, never> {
  readonly _tag = 'Sync' as const
  declare readonly [FxTypeId]: FxVariance<Value, never, never>
  constructor(readonly run: () => Value) {}
  [Symbol.iterator](): FxIterator<FxYield<Value, never, never>, Value> {
    return new SingleShot(this) as never
  }
}

/**
 * The one asynchronous primitive.
 *
 * Exactly one instruction can suspend, which is all `runSync` has to detect,
 * and it is the single place an `AbortSignal` enters the system. The signal is
 * handed over explicitly rather than read from ambient context - that is what
 * lets e2 run unchanged in a browser with no AsyncLocalStorage.
 */
export class Async<out Value, out Error> implements Fx<Value, Error, never> {
  readonly _tag = 'Async' as const
  declare readonly [FxTypeId]: FxVariance<Value, Error, never>
  constructor(
    readonly register: (
      resume: (result: Fx<Value, Error, never>) => void,
      signal: AbortSignal
    ) => Maybe<() => void>
  ) {}
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, never>, Value> {
    return new SingleShot(this) as never
  }
}

/** Defers building an effect until it is reached. The basis of recursion. */
export class Suspend<out Value, out Error, out Dependency extends string>
  implements Fx<Value, Error, Dependency>
{
  readonly _tag = 'Suspend' as const
  declare readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  constructor(readonly make: () => Fx<Value, Error, Dependency>) {}
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value> {
    return new SingleShot(this) as never
  }
}

/** Maps the success value. */
export class Transform<out Value, out Error, out Dependency extends string>
  implements Fx<Value, Error, Dependency>
{
  readonly _tag = 'Transform' as const
  declare readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  constructor(
    readonly source: AnyFx,
    readonly transform: (value: any) => Value
  ) {}
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value> {
    return new SingleShot(this) as never
  }
}

/** Sequences a dependent effect after a successful one. */
export class Chain<out Value, out Error, out Dependency extends string>
  implements Fx<Value, Error, Dependency>
{
  readonly _tag = 'Chain' as const
  declare readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  constructor(
    readonly source: AnyFx,
    readonly transform: (value: any) => AnyFx
  ) {}
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value> {
    return new SingleShot(this) as never
  }
}

/**
 * Recovers from a failure.
 *
 * By default only expected failures are caught; defects and interrupts pass
 * through, because folding them into the error channel would force every call
 * site to handle `Error | Defect`. With `all` set the handler receives the
 * whole `Cause` instead - that is how a Scope keeps running its remaining
 * finalizers after a defective one, and it is deliberately not public.
 */
export class Recover<out Value, out Error, out Dependency extends string>
  implements Fx<Value, Error, Dependency>
{
  readonly _tag = 'Recover' as const
  declare readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  constructor(
    readonly source: AnyFx,
    readonly recover: (error: any) => AnyFx,
    readonly all = false
  ) {}
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value> {
    return new SingleShot(this) as never
  }
}

/** Runs an effect against an overlaid service map. */
export class WithServices<out Value, out Error, out Dependency extends string>
  implements Fx<Value, Error, Dependency>
{
  readonly _tag = 'WithServices' as const
  declare readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  constructor(
    readonly source: AnyFx,
    readonly overrides: readonly (readonly [{ readonly id: string }, unknown])[]
  ) {}
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value> {
    return new SingleShot(this) as never
  }
}

// --- constructors ----------------------------------------------------------

/** Lifts a synchronous computation. A throw inside becomes a defect. */
export const sync = <Value>(run: () => Value): Fx<Value> => new Sync(run)

/** Defers construction, so recursive effects do not build eagerly. */
export const suspend = <Value, Error, Dependency extends string>(
  make: () => Fx<Value, Error, Dependency>
): Fx<Value, Error, Dependency> => new Suspend(make)

export const map =
  <Value, Next>(transform: (value: Value) => Next) =>
  <Error, Dependency extends string>(
    self: Fx<Value, Error, Dependency>
  ): Fx<Next, Error, Dependency> =>
    new Transform(self, transform)

export const flatMap =
  <Value, Next, NextError, NextDependency extends string>(
    transform: (value: Value) => Fx<Next, NextError, NextDependency>
  ) =>
  <Error, Dependency extends string>(
    self: Fx<Value, Error, Dependency>
  ): Fx<Next, Error | NextError, Dependency | NextDependency> =>
    new Chain(self, transform)

export const catchAll =
  <Error, Next, NextError, NextDependency extends string>(
    recover: (error: Error) => Fx<Next, NextError, NextDependency>
  ) =>
  <Value, Dependency extends string>(
    self: Fx<Value, Error, Dependency>
  ): Fx<Value | Next, NextError, Dependency | NextDependency> =>
    new Recover(self, recover)

/**
 * Reaches the running fiber.
 *
 * The general escape hatch that keeps the instruction set small: `fork`,
 * `join`, `interrupt` and scope access are all expressed with this rather than
 * with an instruction each.
 */
export class WithFiber<out Value, out Error, out Dependency extends string>
  implements Fx<Value, Error, Dependency>
{
  readonly _tag = 'WithFiber' as const
  declare readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  constructor(readonly use: (fiber: any) => AnyFx) {}
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value> {
    return new SingleShot(this) as never
  }
}

/**
 * Suspends until `resume` is called, handing over the fiber's abort signal.
 *
 * The signal is passed explicitly rather than read from ambient context, which
 * is precisely why e2 needs no AsyncLocalStorage and runs unchanged in a
 * browser. Return a cleanup function to be run if the fiber is interrupted
 * while parked.
 */
export const async_ = <Value, Error = never>(
  register: (
    resume: (result: Fx<Value, Error, never>) => void,
    signal: AbortSignal
  ) => Maybe<() => void>
): Fx<Value, Error> => new Async(register)

/**
 * Fails with a complete `Cause`.
 *
 * `Err` covers expected failures, but re-raising a child fiber's outcome, or a
 * scope's saved cause, needs to reproduce a defect or an interruption exactly
 * as it was. Internal: application code constructs failures with `fail`.
 */
export class Raise<out Value, out Error, out Dependency extends string>
  implements Fx<Value, Error, Dependency>
{
  readonly _tag = 'Raise' as const
  declare readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  constructor(readonly cause: unknown) {}
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value> {
    return new SingleShot(this) as never
  }
}
