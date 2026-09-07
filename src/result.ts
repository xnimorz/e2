import { SingleShot, type Fx, type FxIterator, type FxVariance, type FxYield } from './fx.ts'
import { FxTypeId, type Maybe } from './types.ts'

/**
 * `Result` is the pure subset of `Fx`.
 *
 * `Ok` IS `succeed`; `Err` IS `fail`. These two classes are also the
 * interpreter's `Succeed` and `Fail` instructions - there is no separate
 * representation and no adapter. The consequences are worth stating:
 *
 *   - `yield* someResult` short-circuits, which is the `?` operator TypeScript
 *     does not have.
 *   - `run` returns a `Result`, which feeds straight back into an `fx` body.
 *   - `Exit<Value, Error> = Result<Value, Cause<Error>>` reuses the same type
 *     rather than introducing a third error vocabulary.
 *
 * They are classes rather than object literals for `instanceof`, a monomorphic
 * shape the interpreter can branch on, and prototype methods that allocate no
 * closures. `_tag` is a string rather than a symbol so `console.log`,
 * `JSON.stringify` and `bun:test` diffs all stay readable. The redundant
 * `ok: true | false` is there because `if (result.ok)` is the cheapest
 * narrowing available and reads better than comparing `_tag`.
 */
export class Ok<out Value> implements Fx<Value, never, never> {
  readonly _tag = 'Ok' as const
  readonly ok = true as const

  declare readonly [FxTypeId]: FxVariance<Value, never, never>

  constructor(readonly value: Value) {}

  [Symbol.iterator](): FxIterator<FxYield<Value, never, never>, Value> {
    return new SingleShot(this) as never
  }

  map<Next>(transform: (value: Value) => Next): Ok<Next> {
    return new Ok(transform(this.value))
  }

  mapErr(_transform: (error: never) => unknown): this {
    return this
  }

  andThen<Next, NextError>(
    transform: (value: Value) => Result<Next, NextError>
  ): Result<Next, NextError> {
    return transform(this.value)
  }

  orElse(_recover: (error: never) => unknown): this {
    return this
  }

  match<OnOk, OnErr>(cases: {
    ok: (value: Value) => OnOk
    err: (error: never) => OnErr
  }): OnOk | OnErr {
    return cases.ok(this.value)
  }

  tap(effect: (value: Value) => void): this {
    effect(this.value)
    return this
  }

  tapErr(_effect: (error: never) => void): this {
    return this
  }

  getOrElse<Fallback>(_fallback: Fallback): Value {
    return this.value
  }

  getOrThrow(): Value {
    return this.value
  }

  getOrNull(): Value {
    return this.value
  }

  toTuple(): [Value, null] {
    return [this.value, null]
  }

  toUnion(): Value {
    return this.value
  }
}

export class Err<out Error> implements Fx<never, Error, never> {
  readonly _tag = 'Err' as const
  readonly ok = false as const

  declare readonly [FxTypeId]: FxVariance<never, Error, never>

  constructor(readonly error: Error) {}

  [Symbol.iterator](): FxIterator<FxYield<never, Error, never>, never> {
    return new SingleShot(this) as never
  }

  map(_transform: (value: never) => unknown): this {
    return this
  }

  mapErr<Next>(transform: (error: Error) => Next): Err<Next> {
    return new Err(transform(this.error))
  }

  andThen(_transform: (value: never) => unknown): this {
    return this
  }

  orElse<Next, NextError>(
    recover: (error: Error) => Result<Next, NextError>
  ): Result<Next, NextError> {
    return recover(this.error)
  }

  match<OnOk, OnErr>(cases: {
    ok: (value: never) => OnOk
    err: (error: Error) => OnErr
  }): OnOk | OnErr {
    return cases.err(this.error)
  }

  tap(_effect: (value: never) => void): this {
    return this
  }

  tapErr(effect: (error: Error) => void): this {
    effect(this.error)
    return this
  }

  getOrElse<Fallback>(fallback: Fallback): Fallback {
    return fallback
  }

  getOrThrow(): never {
    throw this.error
  }

  getOrNull(): null {
    return null
  }

  toTuple(): [null, Error] {
    return [null, this.error]
  }

  toUnion(): Error {
    return this.error
  }
}

export type Result<Value, Error = never> = Ok<Value> | Err<Error>
export type AnyResult = Result<any, any>

/** The value a `Result` carries when it succeeds. */
export type OkOf<Of> = Of extends Ok<infer Value> ? Value : never
/** The failure a `Result` carries when it fails. */
export type ErrOf<Of> = Of extends Err<infer Error> ? Error : never

export const ok = <Value>(value: Value): Ok<Value> => new Ok(value)
export const err = <Error>(error: Error): Err<Error> => new Err(error)

export const isOk = <Value, Error>(result: Result<Value, Error>): result is Ok<Value> =>
  result.ok

export const isErr = <Value, Error>(result: Result<Value, Error>): result is Err<Error> =>
  !result.ok

export const isResult = (value: unknown): value is AnyResult =>
  value instanceof Ok || value instanceof Err

/** Lifts a throwing function. The thrown value is passed through `onThrow`. */
export function attempt<Value, Error>(
  body: () => Value,
  onThrow: (thrown: unknown) => Error
): Result<Value, Error> {
  try {
    return new Ok(body())
  } catch (thrown) {
    return new Err(onThrow(thrown))
  }
}

export function fromNullable<Value, Error>(
  value: Maybe<Value>,
  onNullish: () => Error
): Result<Value, Error> {
  return value == null ? new Err(onNullish()) : new Ok(value)
}

/**
 * Collects a tuple of results, failing on the first `Err`.
 *
 * The `const` type parameter keeps the input a tuple so the success type is a
 * tuple too, rather than an array of a union.
 */
export function all<const Results extends readonly AnyResult[]>(
  results: Results
): Result<{ -readonly [K in keyof Results]: OkOf<Results[K]> }, ErrOf<Results[number]>> {
  const values: unknown[] = []
  for (const result of results) {
    if (!result.ok) {
      return result as never
    }
    values.push(result.value)
  }
  return new Ok(values) as never
}

/** Splits results into their successes and their failures, keeping both. */
export function partition<Value, Error>(
  results: readonly Result<Value, Error>[]
): { readonly values: Value[]; readonly errors: Error[] } {
  const values: Value[] = []
  const errors: Error[] = []
  for (const result of results) {
    if (result.ok) {
      values.push(result.value)
    } else {
      errors.push(result.error)
    }
  }
  return { values, errors }
}
