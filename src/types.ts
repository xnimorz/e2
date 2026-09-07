/**
 * Shared vocabulary: brands, variance helpers, and the two escape hatches
 * (`Maybe` and `Wildcard`) that the rest of the library is allowed to use.
 */

/**
 * Brand identifying an {@link Fx} node. Type-only on instances (`declare`), so
 * it costs nothing at runtime; discrimination in the interpreter is by `_tag`.
 *
 * Registered globally via `Symbol.for` so two copies of e2 in one bundle still
 * agree on what an Fx is.
 */
export const FxTypeId: unique symbol = Symbol.for('e2/Fx')
export type FxTypeId = typeof FxTypeId

/** Brand for the phantom token that occupies a generator's TYield slot. */
export const YieldTypeId: unique symbol = Symbol.for('e2/FxYield')
export type YieldTypeId = typeof YieldTypeId

/** Brand for a service key. */
export const ServiceTypeId: unique symbol = Symbol.for('e2/Service')
export type ServiceTypeId = typeof ServiceTypeId

/** Brand for a service constructor. */
export const ProviderTypeId: unique symbol = Symbol.for('e2/Provider')
export type ProviderTypeId = typeof ProviderTypeId

/**
 * The global `Error`.
 *
 * Type parameters named `Error` shadow the global inside every generic scope
 * that declares one, which is most of this library. Always reach for this
 * alias instead of the bare name - it is both the type and the constructor.
 */
export type JsError = globalThis.Error
export const JsError = globalThis.Error

/** A deliberate `any`. Marks an escape hatch as intentional, not an oversight. */
export type Wildcard = any

export type Maybe<Value> = Value | null | undefined

/** Narrows a {@link Maybe} in place, throwing when it is null or undefined. */
export function just<Value>(
  maybe: Maybe<Value>,
  message?: string
): asserts maybe is Value {
  if (maybe == null) {
    throw new TypeError(message ?? 'e2: expected a value, received null or undefined')
  }
}

/**
 * Phantom marker putting a type parameter in a covariant value position.
 *
 * Without one of these TS treats the parameter as unmeasured and makes
 * `Fx<string>` and `Fx<number>` mutually assignable.
 */
export type Covariant<Of> = (_: never) => Of

/** Phantom marker putting a type parameter in an invariant value position. */
export type Invariant<Of> = (_: Of) => Of

/** Compile-time type equality. Used by the type tests. */
export type Equals<Left, Right> =
  (<Of>() => Of extends Left ? 1 : 2) extends <Of>() => Of extends Right ? 1 : 2
    ? true
    : false

/** Fails to compile unless its argument is exactly `true`. */
export const assertType = <_Passed extends true>(): void => {}

/** Exhaustiveness check for discriminated unions. */
export function assertNever(value: never): never {
  throw new TypeError(`e2: unhandled case ${String(value)}`)
}
