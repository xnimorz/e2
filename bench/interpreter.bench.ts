/**
 * Per-run cost of the interpreter, broken down by what a run allocates.
 *
 *   bun run bench            # every case
 *   bun run bench service    # cases whose name contains "service"
 *
 * The question this answers: an `fx` body that does `yield* Codec` and calls
 * one method costs roughly 80x a direct call. Each row isolates one layer of
 * that run, so a change to the interpreter shows up as a move in the row it
 * targets rather than as one opaque total.
 *
 * Numbers are ns per operation, the median of several rounds after a warm-up.
 * They are for comparing rows and commits on one machine, not for quoting.
 */
import { Cell } from '../src/cell.ts'
import { Fiber } from '../src/fiber.ts'
import { sync, type FxYield } from '../src/fx.ts'
import { fx, gen } from '../src/gen.ts'
import { interpretSync } from '../src/interpreter.ts'
import { Ok } from '../src/result.ts'
import { runSync } from '../src/run.ts'
import { ServiceMap } from '../src/service_map.ts'
import { service } from '../src/service.ts'

interface Codec {
  len(text: string): number
}
const Codec = service<Codec>()('Codec')
const codec: Codec = { len: (text) => text.length }
const map = ServiceMap.of(new Map([['Codec', codec]]))

// What a `runtime` hands its requests: an empty root with the providers'
// cells behind it, every cell already built by the warm-up.
const registry = new Map<string, Cell>()
const runtimeMap = ServiceMap.root(registry)
registry.set('Codec', new Cell('Codec', () => new Ok(codec), runtimeMap))
interpretSync(Codec, runtimeMap)

// Ten distinct services, for the per-yield marginal cost.
const many = Array.from({ length: 10 }, (_, index) => service<Codec>()(`S${index}`))
const manyMap = ServiceMap.of(new Map(many.map((key) => [key.id, codec])))

const measure = fx(function* (text: string) {
  const resolved = yield* Codec
  return resolved.len(text)
})

const measureTen = fx(function* (text: string) {
  let total = 0
  for (const key of many) {
    total += (yield* key).len(text)
  }
  return total
})

const pure = gen(function* () {
  return 5
})

// The same nesting written two ways. `level` defines its body once, as an `fx`
// at module scope; `inline` builds `gen(function* () {})` inside the function
// it is returned from, so every call creates a new generator function.
const level = fx(function* (depth: number): Generator<FxYield<number, never, 'Codec'>, number, never> {
  return depth === 0 ? yield* measure('hello') : yield* level(depth - 1)
})

const inline = (depth: number): ReturnType<typeof measure> =>
  depth === 0
    ? measure('hello')
    : (gen(function* () {
        return yield* inline(depth - 1)
      }) as ReturnType<typeof measure>)

const okNode = new Ok(5)
const syncNode = sync(() => 5)
const CodecLive = Codec.of(codec)

// The same body driven by hand, with no interpreter:
// the floor for the generator protocol alone.
function* bareBody(text: string): Generator<unknown, number, unknown> {
  const resolved: Codec = yield* Codec
  return resolved.len(text)
}
const driveBare = (text: string): number => {
  const iterator = bareBody(text)
  let step = iterator.next()
  while (step.done !== true) {
    step = iterator.next(codec)
  }
  return step.value
}

interface Case {
  readonly name: string
  readonly run: () => unknown
}

const cases: Case[] = [
  { name: 'baseline: direct call', run: () => codec.len('hello') },
  { name: 'baseline: same body, driven by hand', run: () => driveBare('hello') },
  { name: 'alloc: new AbortController', run: () => new AbortController() },
  { name: 'alloc: new Fiber', run: () => new Fiber(okNode, map) },
  { name: 'alloc: fx call (node only)', run: () => measure('hello') },
  { name: 'interpretSync: Ok', run: () => interpretSync(okNode, map) },
  { name: 'interpretSync: Sync', run: () => interpretSync(syncNode, map) },
  { name: 'interpretSync: gen, no yields', run: () => interpretSync(pure, map) },
  { name: 'interpretSync: 1 service', run: () => interpretSync(measure('hello'), map) },
  { name: 'interpretSync: 1 service, built by runtime', run: () => interpretSync(measure('hello'), runtimeMap) },
  { name: 'interpretSync: 10 services', run: () => interpretSync(measureTen('hello'), manyMap) },
  { name: 'interpretSync: 1 service, 5 fx levels', run: () => interpretSync(level(5), map) },
  { name: 'interpretSync: 1 service, 5 inline gen', run: () => interpretSync(inline(5), map) },
  { name: 'runSync: 1 service, graph built per call', run: () => runSync(measure('hello'), [CodecLive]) },
]

// Results are folded into this so no case can be dead-code eliminated.
let sink = 0
const consume = (value: unknown): void => {
  sink = (sink + (typeof value === 'number' ? value : 1)) | 0
}

const ROUNDS = 7
const ROUND_MS = 150

function timeRound(run: () => unknown): number {
  // Grow the batch until one batch is long enough to time reliably.
  let batch = 64
  for (;;) {
    const started = performance.now()
    for (let index = 0; index < batch; index++) {
      consume(run())
    }
    const elapsed = performance.now() - started
    if (elapsed >= ROUND_MS) {
      return (elapsed * 1e6) / batch
    }
    batch *= 2
  }
}

function bench(entry: Case): number {
  timeRound(entry.run) // warm-up, lets the JIT settle
  const samples: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    samples.push(timeRound(entry.run))
  }
  samples.sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)] as number
}

const filter = process.argv[2]
const selected = filter === undefined ? cases : cases.filter((entry) => entry.name.includes(filter))
const direct = bench(cases[0] as Case)

console.log(`${'case'.padEnd(46)}${'ns/op'.padStart(10)}${'x direct'.padStart(10)}`)
for (const entry of selected) {
  const ns = entry === cases[0] ? direct : bench(entry)
  console.log(
    `${entry.name.padEnd(46)}${ns.toFixed(1).padStart(10)}${(ns / direct).toFixed(1).padStart(10)}`
  )
}
if (sink === 0.5) console.log(sink) // unreachable; keeps `sink` observable
