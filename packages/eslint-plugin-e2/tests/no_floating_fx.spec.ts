import { RuleTester } from '@typescript-eslint/rule-tester'
import { afterAll, describe, it } from 'bun:test'
import { noFloatingFx } from '../src/no_floating_fx.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: new URL('./fixture', import.meta.url).pathname,
    },
  },
})

/**
 * A minimal stand-in for the real Fx type. The rule identifies an Fx by its
 * `unique symbol` brand rather than by resolving the e2 module, so a local
 * declaration is enough - and proves the detection does not depend on how the
 * linted project imports the library.
 */
const PRELUDE = `
declare const FxTypeId: unique symbol
interface Fx<Value, Error = never> {
  readonly [FxTypeId]: { _Value: (_: never) => Value; _Error: (_: never) => Error }
  [Symbol.iterator](): Iterator<Fx<Value, Error>, Value>
}
interface User { readonly name: string }
declare const db: { query(id: string): Fx<User> }
declare const log: { info(message: string): Fx<void> }
declare function plain(): number
declare const maybeUser: User | undefined
`

ruleTester.run('no-floating-fx', noFloatingFx, {
  valid: [
    // Actually running it.
    `${PRELUDE}
     function* body() { const user = yield* db.query('1'); return user.name }`,
    // Yielding for its effect, with no value taken.
    `${PRELUDE}
     function* body() { yield* log.info('hi') }`,
    // Passing it along rather than discarding it.
    `${PRELUDE}
     declare function runIt(effect: Fx<User>): void
     runIt(db.query('1'))`,
    // Storing it for later.
    `${PRELUDE}
     const pending = db.query('1')`,
    // Returning it from a plain function is a legitimate way to build one.
    `${PRELUDE}
     function makeQuery(): Fx<User> { return db.query('1') }`,
    // Ordinary values are untouched.
    `${PRELUDE}
     plain()`,
    `${PRELUDE}
     if (maybeUser) { plain() }`,
    `${PRELUDE}
     const items = [1, 2, 3]; const copy = [...items]`,
    `${PRELUDE}
     async function f() { await Promise.resolve(1) }`,
    // Collecting effects into an array for e2's own combinators is correct.
    `${PRELUDE}
     declare function all(effects: readonly Fx<User>[]): Fx<User[]>
     const collected = all([db.query('1'), db.query('2')])`,
  ],

  invalid: [
    {
      // The one the type system cannot catch: built, then dropped.
      code: `${PRELUDE}
             function* body() { db.query('1') }`,
      errors: [{ messageId: 'floating' }],
    },
    {
      code: `${PRELUDE}
             log.info('hi')`,
      errors: [{ messageId: 'floating' }],
    },
    {
      code: `${PRELUDE}
             if (db.query('1')) { plain() }`,
      errors: [{ messageId: 'condition' }],
    },
    {
      code: `${PRELUDE}
             while (db.query('1')) { plain() }`,
      errors: [{ messageId: 'condition' }],
    },
    {
      code: `${PRELUDE}
             const n = db.query('1') ? 1 : 2`,
      errors: [{ messageId: 'condition' }],
    },
    {
      code: `${PRELUDE}
             const n = !db.query('1')`,
      errors: [{ messageId: 'condition' }],
    },
    {
      code: `${PRELUDE}
             async function f() { const user = await db.query('1'); return user }`,
      errors: [{ messageId: 'awaited' }],
    },
    {
      code: `${PRELUDE}
             const spread = [...db.query('1')]`,
      errors: [{ messageId: 'spread' }],
    },
    {
      code: `${PRELUDE}
             async function f() { await Promise.all([db.query('1')]) }`,
      errors: [{ messageId: 'promiseCombinator' }],
    },
    {
      code: `${PRELUDE}
             async function f() { await Promise.race([db.query('1'), db.query('2')]) }`,
      errors: [{ messageId: 'promiseCombinator' }, { messageId: 'promiseCombinator' }],
    },
    {
      // Several in one body.
      code: `${PRELUDE}
             function* body() { db.query('1'); log.info('hi') }`,
      errors: [{ messageId: 'floating' }, { messageId: 'floating' }],
    },
  ],
})

/**
 * Regression tests for false positives found by running the rule against e2's
 * own source. Both categories accounted for every hit on a clean codebase, so
 * they matter more than the positive cases.
 */
ruleTester.run('no-floating-fx (false positives)', noFloatingFx, {
  valid: [
    // An assignment statement evaluates to the assigned value, but the value
    // is stored, not dropped.
    `${PRELUDE}
     let pending: Fx<User> | undefined
     pending = db.query('1')`,
    `${PRELUDE}
     const box: { current?: Fx<User> } = {}
     box.current = db.query('1')`,
    `${PRELUDE}
     let chain = db.query('1')
     chain = db.query('2')`,
    // Result is the pure subset of Fx, but it is eager: by the time you hold
    // one the work has happened, so discarding it is not this rule's concern.
    `declare const FxTypeId: unique symbol
     interface Fx<Value, Error = never> {
       readonly [FxTypeId]: { _Value: (_: never) => Value; _Error: (_: never) => Error }
     }
     interface Ok<Value> extends Fx<Value, never> { readonly _tag: 'Ok'; readonly value: Value }
     interface Err<Error> extends Fx<never, Error> { readonly _tag: 'Err'; readonly error: Error }
     type Result<Value, Error> = Ok<Value> | Err<Error>
     declare function runSync(): Result<number, string>
     runSync()`,
    `declare const FxTypeId: unique symbol
     interface Fx<Value, Error = never> {
       readonly [FxTypeId]: { _Value: (_: never) => Value; _Error: (_: never) => Error }
     }
     interface Ok<Value> extends Fx<Value, never> {
       readonly _tag: 'Ok'
       tap(f: (value: Value) => void): Ok<Value>
     }
     declare const good: Ok<number>
     good.tap(() => {})`,
  ],
  invalid: [],
})
