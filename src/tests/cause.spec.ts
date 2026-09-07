import { describe, expect, test } from 'bun:test'
import {
  Die,
  Fail,
  Interrupt,
  die,
  fail,
  interrupt,
  isDie,
  isFail,
  isInterrupt,
  pretty,
  squash,
  type Cause,
} from '../cause.ts'
import {
  AsyncBoundary,
  CyclicDependency,
  DuplicateProvider,
  Interrupted,
  MissingProvider,
  TaggedError,
} from '../errors.ts'
import { JsError } from '../types.ts'

describe('Cause', () => {
  test('the three constructors service themselves', () => {
    expect(fail('boom')._tag).toBe('Fail')
    expect(die(new JsError('bug'))._tag).toBe('Die')
    expect(interrupt('timeout')._tag).toBe('Interrupt')
    expect(fail('boom') instanceof Fail).toBe(true)
    expect(die(1) instanceof Die).toBe(true)
    expect(interrupt() instanceof Interrupt).toBe(true)
  })

  test('guards narrow each case', () => {
    const causes: Cause<string>[] = [fail('boom'), die('bug'), interrupt('stop')]
    expect(causes.filter(isFail).map((c) => c.error)).toEqual(['boom'])
    expect(causes.filter(isDie).map((c) => c.defect)).toEqual(['bug'])
    expect(causes.filter(isInterrupt).map((c) => c.reason)).toEqual(['stop'])
  })

  test('squash unwraps Fail and Die to the original value', () => {
    const boom = { _tag: 'DbError' }
    expect(squash(fail(boom))).toBe(boom)
    expect(squash(die(boom))).toBe(boom)
  })

  test('squash turns interruption into a throwable', () => {
    const squashed = squash(interrupt('timeout'))
    expect(squashed instanceof JsError).toBe(true)
    expect((squashed as Error).message).toContain('timeout')
  })

  test('pretty renders each case', () => {
    expect(pretty(fail('boom'))).toBe('Fail(boom)')
    expect(pretty(die('bug'))).toBe('Die(bug)')
    expect(pretty(interrupt())).toBe('Interrupt')
    expect(pretty(interrupt('timeout'))).toBe('Interrupt(timeout)')
  })
})

describe('TaggedError', () => {
  class DbError extends TaggedError<'DbError'> {
    readonly _tag = 'DbError' as const
  }

  test('is a real Error, so stacks and instanceof work', () => {
    const error = new DbError('connection refused')
    expect(error instanceof JsError).toBe(true)
    expect(error instanceof DbError).toBe(true)
    expect(error.message).toBe('connection refused')
    expect(typeof error.stack).toBe('string')
  })

  test('names itself after the concrete subclass', () => {
    expect(new DbError('x').name).toBe('DbError')
  })

  test('carries _tag for exhaustive matching', () => {
    expect(new DbError('x')._tag).toBe('DbError')
  })

  test('forwards cause', () => {
    const root = new JsError('root')
    expect(new DbError('wrapped', { cause: root }).cause).toBe(root)
  })
})

describe('library errors carry actionable messages', () => {
  test('AsyncBoundary names the escape route', () => {
    expect(new AsyncBoundary().message).toContain('Use run() instead')
    expect(new AsyncBoundary('getUser').message).toContain('getUser')
  })

  test('Interrupted', () => {
    expect(new Interrupted().message).toBe('e2: interrupted')
    expect(new Interrupted('timeout').message).toContain('timeout')
  })

  test('DuplicateProvider names the service and both indices', () => {
    const error = new DuplicateProvider('Db', [0, 3])
    expect(error.message).toContain('"Db"')
    expect(error.message).toContain('index 0 and 3')
    expect(error.service).toBe('Db')
  })

  test('CyclicDependency prints the cycle', () => {
    expect(new CyclicDependency(['Db', 'Cache', 'Db']).message).toContain(
      'Db -> Cache -> Db'
    )
  })

  test('MissingProvider mirrors the compile-time diagnostic wording', () => {
    expect(new MissingProvider('Db').message).toContain('missing service Db')
    expect(new MissingProvider('Db', 'Cache').message).toContain('required by Cache')
  })
})
