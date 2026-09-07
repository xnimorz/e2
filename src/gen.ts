import { Gen, type AnyFx, type AnyYield, type Fx, type FxYield } from './fx.ts'
import type { AnyResult } from './result.ts'

/**
 * The failures a generator body can produce, collected across every `yield*`.
 *
 * The `[Of]` tuple wrapping is mandatory. Without it the conditional
 * distributes over the union of yielded tokens and you get back the last
 * member instead of the union of all their error types.
 */
export type ErrorOf<Yielded> = [Yielded] extends [never]
  ? never
  : [Yielded] extends [FxYield<infer _Value, infer Error, infer _Dependency>]
    ? Error
    : never

/** The service names a generator body requires, collected across every `yield*`. */
export type DependenciesOf<Yielded> = [Yielded] extends [never]
  ? never
  : [Yielded] extends [FxYield<infer _Value, infer _Error, infer Dependency>]
    ? Dependency
    : never

/**
 * The type `gen`/`fx` produce, with a guard on the return position.
 *
 * Returning an `Fx` without `yield*` is the one shape of the forgotten-yield
 * mistake that the type system can catch on its own, so it is caught here and
 * reported as a readable string rather than as a confusing `Fx<Fx<...>>`.
 *
 * `Result` is carved out first because returning a `Result` deliberately - to
 * hand the caller both branches rather than short-circuiting - is legitimate.
 */
export type Returned<Value, Yielded extends AnyYield> = [Value] extends [AnyResult]
  ? Fx<Value, ErrorOf<Yielded>, DependenciesOf<Yielded>>
  : [Value] extends [AnyFx]
    ? 'e2: this generator returns an Fx - did you forget `yield*`?'
    : Fx<Value, ErrorOf<Yielded>, DependenciesOf<Yielded>>

/**
 * Builds an `Fx` from a generator body.
 *
 * Do NOT annotate the body's return type. Writing
 * `function* (): Generator<..., User>` supplies a contextual type that
 * disables inference of the yielded token, collapsing `Error` and `Dependency`
 * to whatever was written by hand.
 */
export function gen<Yielded extends AnyYield, Value>(
  body: () => Generator<Yielded, Value, never>
): Returned<Value, Yielded> {
  return new Gen(body as never) as never
}

/** The same, for a generator body that takes arguments. */
export function fx<Args extends readonly unknown[], Yielded extends AnyYield, Value>(
  body: (...args: Args) => Generator<Yielded, Value, never>
): (...args: Args) => Returned<Value, Yielded> {
  return (...args: Args) => new Gen(() => body(...args) as never) as never
}
