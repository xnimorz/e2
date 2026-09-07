import { describe, expect, test } from 'bun:test'
import {
  Err,
  Ok,
  all,
  attempt,
  err,
  fromNullable,
  isErr,
  isOk,
  isResult,
  ok,
  partition,
  type Result,
} from '../result.ts'

class ParseError {
  readonly _tag = 'ParseError' as const
  constructor(readonly input: string) {}
}
class RangeErr {
  readonly _tag = 'RangeErr' as const
}

/** Narrows to Ok, failing the test otherwise. Results do not expose `.value`
 *  until narrowed - that is the point - so tests narrow like real code does. */
function okValue<Value, Error>(result: Result<Value, Error>): Value {
  if (!result.ok) {
    throw new Error(`expected Ok, received Err(${String(result.error)})`)
  }
  return result.value
}

function errValue<Value, Error>(result: Result<Value, Error>): Error {
  if (result.ok) {
    throw new Error(`expected Err, received Ok(${String(result.value)})`)
  }
  return result.error
}

describe('construction', () => {
  test('ok carries its value and narrows', () => {
    const result = ok(42)
    expect(result.ok).toBe(true)
    expect(result._tag).toBe('Ok')
    expect(result.value).toBe(42)
    expect(result instanceof Ok).toBe(true)
  })

  test('err carries its error and narrows', () => {
    const result = err(new ParseError('x'))
    expect(result.ok).toBe(false)
    expect(result._tag).toBe('Err')
    expect(result.error.input).toBe('x')
    expect(result instanceof Err).toBe(true)
  })

  test('isOk / isErr / isResult', () => {
    const good: Result<number, ParseError> = ok(1)
    const bad: Result<number, ParseError> = err(new ParseError('x'))
    expect(isOk(good)).toBe(true)
    expect(isErr(good)).toBe(false)
    expect(isOk(bad)).toBe(false)
    expect(isErr(bad)).toBe(true)
    expect(isResult(good)).toBe(true)
    expect(isResult({ ok: true, value: 1 })).toBe(false)
    expect(isResult(null)).toBe(false)
  })

  test('results serialise readably - _tag is a string, not a symbol', () => {
    // Key order is not a contract; being plain JSON-visible data is.
    expect(JSON.parse(JSON.stringify(ok(1)))).toEqual({ _tag: 'Ok', ok: true, value: 1 })
    expect(JSON.parse(JSON.stringify(err('boom')))).toEqual({
      _tag: 'Err',
      ok: false,
      error: 'boom',
    })
  })
})

describe('map / mapErr', () => {
  test('map transforms Ok', () => {
    expect(ok(2).map((n) => n * 3).value).toBe(6)
  })

  test('map leaves Err untouched and identical', () => {
    const original = err(new ParseError('x'))
    const mapped = original.map((n: never) => n)
    expect(mapped).toBe(original)
  })

  test('mapErr transforms Err', () => {
    const mapped = err(new ParseError('x')).mapErr((e) => e.input.toUpperCase())
    expect(mapped.error).toBe('X')
  })

  test('mapErr leaves Ok untouched and identical', () => {
    const original = ok(1)
    expect(original.mapErr(() => 'nope')).toBe(original)
  })
})

describe('andThen / orElse', () => {
  const parse = (raw: string): Result<number, ParseError> => {
    const n = Number(raw)
    return Number.isNaN(n) ? err(new ParseError(raw)) : ok(n)
  }

  test('andThen chains on Ok', () => {
    expect(okValue(ok('12').andThen(parse))).toBe(12)
  })

  test('andThen propagates the first Err and short-circuits', () => {
    let called = false
    const result = err(new RangeErr()).andThen(() => {
      called = true
      return ok(1)
    })
    expect(called).toBe(false)
    expect(result.ok).toBe(false)
  })

  test('orElse recovers from Err', () => {
    expect(okValue(err(new ParseError('x')).orElse(() => ok(0)))).toBe(0)
  })

  test('orElse is skipped on Ok', () => {
    let called = false
    ok(1).orElse(() => {
      called = true
      return ok(2)
    })
    expect(called).toBe(false)
  })
})

describe('match / tap', () => {
  test('match picks the ok branch', () => {
    expect(ok(1).match({ ok: (n) => `ok:${n}`, err: () => 'err' })).toBe('ok:1')
  })

  test('match picks the err branch', () => {
    expect(err('boom').match({ ok: () => 'ok', err: (e) => `err:${e}` })).toBe('err:boom')
  })

  test('tap runs only on Ok and returns the same instance', () => {
    const seen: number[] = []
    const original = ok(5)
    expect(original.tap((n) => seen.push(n))).toBe(original)
    expect(seen).toEqual([5])
    err('x').tap(() => seen.push(99))
    expect(seen).toEqual([5])
  })

  test('tapErr runs only on Err', () => {
    const seen: string[] = []
    err('boom').tapErr((e) => seen.push(e))
    ok(1).tapErr(() => seen.push('nope'))
    expect(seen).toEqual(['boom'])
  })
})

describe('extraction', () => {
  test('getOrElse', () => {
    expect(ok(1).getOrElse(9)).toBe(1)
    expect(err('x').getOrElse(9)).toBe(9)
  })

  test('getOrThrow returns on Ok and throws the error itself on Err', () => {
    expect(ok(1).getOrThrow()).toBe(1)
    // The error is rethrown as-is, never wrapped - identity is the contract,
    // and it must work for failures that are not Error subclasses.
    const boom = new ParseError('bad')
    let thrown: unknown
    try {
      err(boom).getOrThrow()
    } catch (caught) {
      thrown = caught
    }
    expect(thrown).toBe(boom)
  })

  test('getOrNull', () => {
    expect(ok(1).getOrNull()).toBe(1)
    expect(err('x').getOrNull()).toBe(null)
  })

  test('toTuple gives a Go-style pair', () => {
    expect(ok(1).toTuple()).toEqual([1, null])
    expect(err('x').toTuple()).toEqual([null, 'x'])
  })

  test('toUnion collapses both sides', () => {
    expect(ok(1).toUnion()).toBe(1)
    expect(err('x').toUnion()).toBe('x')
  })
})

describe('statics', () => {
  test('attempt captures a throw', () => {
    const thrown = attempt(
      () => {
        throw new RangeErr()
      },
      (e) => e as RangeErr
    )
    expect(thrown.ok).toBe(false)
    expect(okValue(attempt(() => 7, () => 'never'))).toBe(7)
  })

  test('fromNullable', () => {
    expect(okValue(fromNullable(1, () => 'nope'))).toBe(1)
    expect(errValue(fromNullable(null, () => 'nope'))).toBe('nope')
    expect(errValue(fromNullable(undefined, () => 'nope'))).toBe('nope')
    expect(okValue(fromNullable(0, () => 'nope'))).toBe(0)
  })

  test('all collects a tuple and keeps positions', () => {
    const collected = all([ok(1), ok('two'), ok(true)])
    expect(okValue(collected)).toEqual([1, 'two', true])
  })

  test('all fails on the first Err and short-circuits', () => {
    const collected = all([ok(1), err('first'), err('second')])
    expect(errValue(collected)).toBe('first')
  })

  test('all of an empty tuple is Ok', () => {
    expect(all([]).ok).toBe(true)
  })

  test('partition keeps both sides in order', () => {
    const { values, errors } = partition<number, string>([
      ok(1),
      err('a'),
      ok(2),
      err('b'),
    ])
    expect(values).toEqual([1, 2])
    expect(errors).toEqual(['a', 'b'])
  })
})

describe('Result is the pure subset of Fx', () => {
  test('every Result is iterable, yielding itself exactly once', () => {
    const node = ok(1)
    const iterator = node[Symbol.iterator]()
    const first = iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toBe(node as never)
    // the interpreter sends the reduced value back in
    const second = iterator.next('sent')
    expect(second.done).toBe(true)
    expect(second.value).toBe('sent' as never)
  })

  test('a fresh iterator is handed out per delegation, so Results are reusable', () => {
    const node = err('boom')
    expect(node[Symbol.iterator]()).not.toBe(node[Symbol.iterator]())
    expect(node[Symbol.iterator]().next().done).toBe(false)
  })
})
