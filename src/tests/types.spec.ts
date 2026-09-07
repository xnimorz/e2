import { describe, expect, test } from 'bun:test'
import { Err, err, ok, type Result } from '../result.ts'
import type { Cause, Exit } from '../cause.ts'
import { TaggedError } from '../errors.ts'
import { JsError, assertType, just, type Equals, type Maybe } from '../types.ts'

class ParseError extends TaggedError<'ParseError'> {
  readonly _tag = 'ParseError' as const
}
class RangeErr extends TaggedError<'RangeErr'> {
  readonly _tag = 'RangeErr' as const
}

// ===========================================================================
// The early-return ergonomic: `return someErr` inside a Result-returning
// function must typecheck with NO cast.
//
// This is the whole reason Err is parameterised on the failure alone rather
// than being Result<never, Error>: it makes Err<ParseError> a member of the
// declared return union, so the narrowed value flows straight out.
// ===========================================================================

function parsePort(raw: string): Result<number, ParseError> {
  const port = Number(raw)
  return Number.isInteger(port) ? ok(port) : err(new ParseError(raw))
}

function checkRange(port: number): Result<number, RangeErr> {
  return port > 0 && port < 65536 ? ok(port) : err(new RangeErr(String(port)))
}

function configure(raw: string): Result<number, ParseError | RangeErr> {
  const port = parsePort(raw)
  if (!port.ok) {
    return port // <- no cast, no widening helper, no `as`
  }
  return checkRange(port.value)
}

// and the narrowing is precise, not just assignable
function narrowsToErr(raw: string): ParseError | number {
  const port = parsePort(raw)
  if (!port.ok) {
    assertType<Equals<typeof port, Err<ParseError>>>()
    return port.error
  }
  assertType<Equals<typeof port.value, number>>()
  return port.value
}

// ===========================================================================
// The `Error` shadowing hazard: inside any generic scope declaring a type
// parameter named `Error`, the global is only reachable as JsError.
// ===========================================================================

function insideGenericScope<Error>(error: Error): JsError {
  // `Error` here is the type parameter, NOT the global constructor.
  assertType<Equals<Error, Error>>()
  return new JsError(String(error))
}

class BoxInGenericScope<Error> {
  constructor(readonly cause: Cause<Error>) {}
  describe(): JsError {
    return new JsError(this.cause._tag)
  }
}

// TaggedError still extends the real Error even though this module is full of
// `Error` type parameters.
class ShadowedError extends TaggedError<'ShadowedError'> {
  readonly _tag = 'ShadowedError' as const
}

// ===========================================================================
// Exit reuses Result rather than introducing a third vocabulary
// ===========================================================================

assertType<Equals<Exit<number, ParseError>, Result<number, Cause<ParseError>>>>()

// Maybe / just
assertType<Equals<Maybe<number>, number | null | undefined>>()

describe('type-level guarantees (compilation is the assertion)', () => {
  test('early return of an Err needs no cast', () => {
    expect(configure('80').ok).toBe(true)
    expect(narrowsToErr('80')).toBe(80)
  })

  test('the global Error stays reachable as JsError under shadowing', () => {
    expect(insideGenericScope<string>('boom') instanceof JsError).toBe(true)
    expect(new ShadowedError('x') instanceof JsError).toBe(true)
    expect(new BoxInGenericScope<string>({ _tag: 'Die', defect: 1 } as never).describe()
      instanceof JsError).toBe(true)
  })

  test('just narrows and throws on nullish', () => {
    const value: Maybe<number> = 1
    just(value)
    expect(value).toBe(1)
    expect(() => just(null as Maybe<number>)).toThrow(TypeError)
    expect(() => just(undefined, 'custom')).toThrow('custom')
  })

  test('sanity: ok/err still construct', () => {
    expect(ok(1).value).toBe(1)
    expect(err(new ParseError('x')).error._tag).toBe('ParseError')
  })
})
