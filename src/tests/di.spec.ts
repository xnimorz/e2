import { describe, expect, test } from 'bun:test'
import { MissingProvider } from '../errors.ts'
import { Gen } from '../fx.ts'
import { acquire } from '../ops.ts'
import { Ok } from '../result.ts'
import { Provider, lazy } from '../provider.ts'
import { NOT_FOUND, ServiceMap, services } from '../service_map.ts'
import { Defaulted, Service, service } from '../service.ts'
import { assertType, type Equals } from '../types.ts'

interface CfgSvc {
  readonly url: string
}
interface LogSvc {
  info(message: string): void
}

const Config = service<CfgSvc>()('Config')
const Logger = service<LogSvc>()('Logger')

describe('Service', () => {
  test('infers its name as a literal, not string', () => {
    assertType<Equals<typeof Config, Service<'Config', CfgSvc>>>()
    expect(Config.id).toBe('Config')
  })

  test('is itself an Fx, so `yield* Service` needs no accessor', () => {
    const iterator = Config[Symbol.iterator]()
    const first = iterator.next()
    expect(first.done).toBe(false)
    expect(first.value).toBe(Config as never)
    expect(iterator.next({ url: 'x' }).value).toEqual({ url: 'x' } as never)
  })

  test('carries the resolve instruction service', () => {
    expect(Config._tag).toBe('Service')
  })

  test('prints readably', () => {
    expect(String(Config)).toBe('Service(Config)')
  })
})

describe('ServiceMap', () => {
  test('resolves by name', () => {
    const map = services([Config, { url: 'postgres://' }])
    expect(map.get(Config).url).toBe('postgres://')
    expect(map.has(Config)).toBe(true)
    expect(map.has(Logger)).toBe(false)
  })

  test('throws a named error for an absent service', () => {
    expect(() => ServiceMap.empty().get(Config)).toThrow(MissingProvider)
    expect(() => ServiceMap.empty().get(Config)).toThrow('missing service Config')
  })

  test('getMaybe returns undefined rather than throwing', () => {
    expect(ServiceMap.empty().getMaybe(Config)).toBeUndefined()
  })

  test('with() creates an overlay and leaves the parent untouched', () => {
    const base = services([Config, { url: 'base' }])
    const overlay = base.with(Config, { url: 'override' })
    expect(overlay.get(Config).url).toBe('override')
    expect(base.get(Config).url).toBe('base')
  })

  test('an overlay still sees services it does not shadow', () => {
    const base = services([Config, { url: 'base' }], [Logger, { info: () => {} }])
    const overlay = base.with(Config, { url: 'override' })
    expect(overlay.has(Logger)).toBe(true)
    expect(overlay.get(Config).url).toBe('override')
  })

  test('overlays nest', () => {
    const map = services([Config, { url: 'a' }])
      .with(Config, { url: 'b' })
      .with(Config, { url: 'c' })
    expect(map.get(Config).url).toBe('c')
  })

  test('presence is decided by key, so an undefined service is still present', () => {
    // A value of undefined must not read as absent and fall through to the parent.
    const base = services([Config, { url: 'parent' }])
    const overlay = base.with(Config, undefined as unknown as CfgSvc)
    expect(overlay.has(Config)).toBe(true)
    expect(overlay.get(Config)).toBeUndefined()
  })

  test('withAll overrides several at once', () => {
    const map = ServiceMap.empty().withAll([
      [Config, { url: 'x' }],
      [Logger, { info: () => {} }],
    ])
    expect(map.names()).toEqual(['Config', 'Logger'])
  })

  test('names() reports the whole visible chain, deduplicated', () => {
    const map = services([Config, { url: 'a' }]).with(Config, { url: 'b' })
    expect(map.names()).toEqual(['Config'])
  })

  test('a registered but unbuilt provider is resolvable, not has', () => {
    const cell = { built: () => NOT_FOUND, join: () => new Ok(undefined) }
    const root = ServiceMap.root(new Map([['Config', cell]]))
    expect(root.has(Config)).toBe(false)
    expect(root.resolvable('Config')).toBe(cell)
    // and the registry is visible through overlays
    expect(root.with(Logger, { info: () => {} }).resolvable('Config')).toBe(cell)
  })
})

describe('Service.of', () => {
  test('is a provider with no dependencies', () => {
    const live = Config.of({ url: 'x' })
    expect(live).toBeInstanceOf(Provider)
    expect(live.provides).toBe(Config)
    expect(live.lazy).toBe(false)
    assertType<Equals<typeof live, Provider<'Config', never, never>>>()
  })

  test('builds an already-resolved service', () => {
    const built = Config.of({ url: 'x' }).build()
    expect(built).toBeInstanceOf(Ok)
    expect((built as Ok<CfgSvc>).value.url).toBe('x')
  })
})

describe('Service.make', () => {
  test('defers its body until built', () => {
    let calls = 0
    const live = Logger.make(function* () {
      calls += 1
      return { info: () => {} }
    })
    expect(calls).toBe(0)
    const built = live.build()
    expect(built).toBeInstanceOf(Gen)
    expect(calls).toBe(0) // still deferred - Gen holds a thunk, not a generator
  })

  test('each build produces a fresh Gen, so a provider is re-runnable', () => {
    const live = Logger.make(function* () {
      return { info: () => {} }
    })
    const first = live.build()
    const second = live.build()
    expect(first).not.toBe(second)
    // and a Gen hands out a fresh generator per run
    expect((first as Gen<unknown, never, never>).body()).not.toBe(
      (first as Gen<unknown, never, never>).body()
    )
  })

  test('infers Needs from what the body yields', () => {
    const live = Logger.make(function* () {
      const cfg = yield* Config
      return { info: () => void cfg.url }
    })
    assertType<Equals<typeof live, Provider<'Logger', 'Config', never>>>()
  })

  test('a body that yields nothing has no Needs', () => {
    const live = Logger.make(function* () {
      return { info: () => {} }
    })
    assertType<Equals<typeof live, Provider<'Logger', never, never>>>()
  })

  test('Scope is stripped: every provider runs inside the runtime scope', () => {
    const live = Logger.make(function* () {
      yield* acquire(
        () => 'handle',
        () => {}
      )
      return { info: () => {} }
    })
    assertType<Equals<typeof live, Provider<'Logger', never, never>>>()
  })

  test('parameters of returned methods are typed by the contract', () => {
    const live = Logger.make(function* () {
      return {
        // `message` is `string` with no annotation
        info: (message) => void message.toUpperCase(),
      }
    })
    expect(live.provides).toBe(Logger)
  })

  test('prints its shape', () => {
    expect(String(Config.of({ url: 'x' }))).toBe('Provider(Config)')
    expect(String(lazy(Config.of({ url: 'x' })))).toBe('Provider(Config, lazy)')
  })
})

describe('lazy', () => {
  test('marks a provider as skipped by the warm-up and keeps everything else', () => {
    const live = Config.of({ url: 'x' })
    const deferred = lazy(live)
    expect(deferred.lazy).toBe(true)
    expect(deferred.provides).toBe(Config)
    expect(deferred.build).toBe(live.build)
    assertType<Equals<typeof deferred, Provider<'Config', never, never>>>()
  })
})

describe('service with a default', () => {
  const Clock = service('Clock', function* () {
    const cfg = yield* Config
    return { now: () => cfg.url.length }
  })

  test('is a Service', () => {
    expect(Clock).toBeInstanceOf(Service)
    expect(Clock.id).toBe('Clock')
    expect(Clock._tag).toBe('Service')
  })

  test('is structurally a Provider for itself, with Needs inferred from the body', () => {
    expect(Clock).toBeInstanceOf(Defaulted)
    expect(Clock.provides).toBe(Clock)
    expect(Clock.lazy).toBe(false)
    expect(Clock.build()).toBeInstanceOf(Gen)
    assertType<
      Equals<typeof Clock, Defaulted<'Clock', { now: () => number }, 'Config', never>>
    >()
  })

  test('still makes alternatives from the same key', () => {
    const stub = Clock.of({ now: () => 0 })
    assertType<Equals<typeof stub, Provider<'Clock', never, never>>>()
    expect(stub.provides).toBe(Clock)
  })

  test('prints readably', () => {
    expect(String(Clock)).toBe('Service(Clock, with default)')
  })
})
