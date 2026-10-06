/**
 * Runs inside the playground's sandbox frame, before the user's code.
 *
 * Forwards console output and uncaught failures to the playground, formatted
 * here because only this frame can see the values. Results print as
 * `Ok(…)` / `Err(…)` rather than as class instances with a dozen methods.
 */

interface Entry {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  readonly text: string
}

/** The playground names each frame after its run, so stale output is ignored. */
const runId = window.name

const post = (message: Record<string, unknown>): void => {
  parent.postMessage({ source: 'e2-playground', runId, ...message }, '*')
}

const WIDTH = 72

function inspect(value: unknown, depth = 0, seen: Set<object> = new Set()): string {
  if (typeof value === 'string') return depth === 0 ? value : JSON.stringify(value)
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return `[Function${value.name ? ` ${value.name}` : ''}]`
  if (typeof value !== 'object') return String(value)

  if (seen.has(value)) return '[Circular]'
  if (depth > 5) return '[…]'
  seen.add(value)
  try {
    const nested = (inner: unknown): string => inspect(inner === undefined ? undefined : inner, depth + 1, seen)
    const tagged = value as { _tag?: unknown; value?: unknown; error?: unknown }

    if (tagged._tag === 'Ok' && 'value' in tagged) return `Ok(${nested(tagged.value)})`
    if (tagged._tag === 'Err' && 'error' in tagged) return `Err(${nested(tagged.error)})`
    if (value instanceof Error) {
      const extra = Object.keys(value).filter((key) => !['_tag', 'name', 'message', 'stack'].includes(key))
      const head = `${value.name}: ${value.message}`
      return extra.length === 0
        ? head
        : group(`${head} {`, extra.map((key) => `${key}: ${nested((value as never)[key])}`), '}')
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
    if (value instanceof RegExp) return value.toString()
    if (Array.isArray(value)) return group('[', value.map(nested), ']')
    if (value instanceof Map) {
      return group(`Map(${value.size}) {`, [...value].map(([key, inner]) => `${nested(key)} => ${nested(inner)}`), '}')
    }
    if (value instanceof Set) return group(`Set(${value.size}) {`, [...value].map(nested), '}')
    if (value instanceof Promise) return 'Promise { … }'

    const name = (value as { constructor?: { name?: string } }).constructor?.name
    const prefix = name && name !== 'Object' ? `${name} ` : ''
    const keys = Object.keys(value)
    if (keys.length === 0) return `${prefix}{}`
    return group(`${prefix}{`, keys.map((key) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${nested((value as never)[key])}`), '}')
  } finally {
    seen.delete(value)
  }
}

/** One line when it fits, otherwise one member per line. */
function group(open: string, members: readonly string[], close: string): string {
  if (members.length === 0) return `${open}${close}`
  const spaced = open.endsWith('{') ? ' ' : ''
  const flat = `${open}${spaced}${members.join(', ')}${spaced}${close}`
  if (flat.length <= WIDTH && !flat.includes('\n')) return flat
  const indented = members.map((member) => `  ${member.replaceAll('\n', '\n  ')}`)
  return `${open}\n${indented.join(',\n')}\n${close}`
}

const format = (parts: readonly unknown[]): string => parts.map((part) => inspect(part)).join(' ')

for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console)
  console[level] = (...parts: unknown[]) => {
    original(...parts)
    post({ kind: 'console', entry: { level, text: format(parts) } satisfies Entry })
  }
}

const describe = (reason: unknown): string =>
  reason instanceof Error ? `${reason.name}: ${reason.message}` : `Uncaught ${inspect(reason)}`

window.addEventListener('error', (event: ErrorEvent) => {
  post({ kind: 'console', entry: { level: 'error', text: describe(event.error ?? event.message) } satisfies Entry })
})
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  post({ kind: 'console', entry: { level: 'error', text: `Unhandled rejection: ${describe(event.reason)}` } satisfies Entry })
})

/** Called by the frame's loader once the user's module settles. */
;(self as unknown as { __settle: (failed: boolean, reason?: unknown) => void }).__settle = (failed, reason) => {
  if (failed) {
    post({ kind: 'console', entry: { level: 'error', text: describe(reason) } satisfies Entry })
  }
  post({ kind: 'done', failed })
}
