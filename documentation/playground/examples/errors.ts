// Errors: Result is the pure subset of Fx.
//
// A plain function returning a Result can be yielded inside a body, and
// `yield*` short-circuits on Err: the `?` operator TypeScript does not have.
import { Cause, TaggedError, catchAll, err, fx, ok, run, runExit, sync, type Result } from 'e2'

class ParseError extends TaggedError<'ParseError'> {
  readonly _tag = 'ParseError' as const
}
class PortError extends TaggedError<'PortError'> {
  readonly _tag = 'PortError' as const
}

// Plain, synchronous, fallible functions. No effects involved.
const parseAddress = (raw: string): Result<{ host: string; port: string }, ParseError> => {
  const [host, port] = raw.split(':')
  return host && port ? ok({ host, port }) : err(new ParseError(`expected host:port, got "${raw}"`))
}

const parsePort = (raw: string): Result<number, PortError> => {
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port < 65_536
    ? ok(port)
    : err(new PortError(`${raw} is not a port`))
}

const load = fx(function* (raw: string) {
  const address = yield* parseAddress(raw) // stops here on ParseError
  const port = yield* parsePort(address.port) // or here on PortError
  return { host: address.host, port }
})
// (raw: string) => Fx<{ host: string; port: number }, ParseError | PortError>

for (const raw of ['localhost:8080', 'localhost', 'localhost:99999']) {
  const result = await run(load(raw), [])
  console.log(raw.padEnd(16), '→', result.ok ? result.value : `${result.error._tag}: ${result.error.message}`)
}

// catchAll recovers from the failures in the type, and removes them from it.
const withDefault = catchAll((_: ParseError | PortError) => ok({ host: 'localhost', port: 80 }))(
  load('nonsense')
)
// Fx<{ host: string; port: number }, never>
console.log('with a default  →', await run(withDefault, []))

// A throw is a defect, not an expected failure: catchAll does not see it, and
// it is not in the type. runExit reports the whole Cause.
const buggy = catchAll(() => ok('recovered'))(
  sync((): string => {
    throw new Error('a bug, not an outcome')
  })
)
const exit = await runExit(buggy, [])
if (!exit.ok) console.log(Cause.pretty(exit.error))
