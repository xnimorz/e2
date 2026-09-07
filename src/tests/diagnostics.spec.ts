import { describe, expect, test } from 'bun:test'

/**
 * The missing-dependency diagnostic is the main thing e2 offers over Effect,
 * so it is tested like a feature rather than asserted like a claim.
 *
 * This compiles `src/tests/diagnostics/*.fixture.ts` - files that are supposed
 * to fail - and pins the exact wording tsc produces. A TypeScript upgrade that
 * degrades the message turns this red instead of silently eroding the reason
 * the library exists.
 */

interface Diagnostic {
  readonly line: number
  readonly code: string
  /** The first line: "Argument of type X is not assignable to Y". */
  readonly summary: string
  /** Indented follow-on lines, outermost first. */
  readonly detail: string[]
}

const HEADER = /^[^(]+\((\d+),\d+\): error (TS\d+): (.*)$/

function compileFixtures(): Diagnostic[] {
  const result = Bun.spawnSync({
    cmd: ['bunx', 'tsc', '-p', 'src/tests/diagnostics', '--pretty', 'false'],
    cwd: new URL('../../', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  const diagnostics: Diagnostic[] = []

  for (const raw of output.split('\n')) {
    if (raw.trim() === '') continue
    const header = HEADER.exec(raw)
    if (header !== null) {
      diagnostics.push({
        line: Number(header[1]),
        code: header[2] as string,
        summary: header[3] as string,
        detail: [],
      })
    } else {
      diagnostics.at(-1)?.detail.push(raw.trim())
    }
  }
  return diagnostics
}

const diagnostics = compileFixtures()
const all = diagnostics.map((d) => [d.summary, ...d.detail].join('\n'))
const find = (needle: string): Diagnostic => {
  const hit = diagnostics.find((d) => [d.summary, ...d.detail].some((l) => l.includes(needle)))
  if (hit === undefined) {
    throw new Error(
      `no diagnostic mentioning ${JSON.stringify(needle)}. Got:\n${all.join('\n---\n')}`
    )
  }
  return hit
}

describe('the fixtures actually fail', () => {
  test('tsc reports one diagnostic per deliberate error', () => {
    expect(diagnostics.length).toBe(7)
    expect(new Set(diagnostics.map((d) => d.code))).toEqual(new Set(['TS2345', 'TS2339']))
  })

  test('diagnostics arrive in source order', () => {
    const lines = diagnostics.map((d) => d.line)
    expect([...lines].sort((a, b) => a - b)).toEqual(lines)
  })
})

describe('missing service', () => {
  test('names the missing service on its own final line', () => {
    const diagnostic = find('e2: missing service Logger')
    expect(diagnostic.detail.at(-1)).toBe(
      `Type 'Fx<User, DbError, "Db" | "Logger">' is not assignable to type '"e2: missing service Logger"'.`
    )
  })

  test('stays two lines - the whole point is that it is readable', () => {
    // Effect's equivalent makes you diff two Context unions by eye. If a TS
    // upgrade turns this into an eight-level structural walk, that is a
    // regression in the headline feature.
    const diagnostic = find('e2: missing service Logger')
    expect(diagnostic.detail).toHaveLength(1)
  })

  test('the dependency channel prints as names, not service types', () => {
    // 'Db' | 'Logger', never Service<'Db', DbSvc> | Service<'Logger', LogSvc>.
    const diagnostic = find('e2: missing service Logger')
    expect(diagnostic.summary).toContain(`Fx<User, DbError, "Db" | "Logger">`)
    expect(diagnostic.summary).not.toContain('Service<')
  })

  test('reports every missing service when several are absent', () => {
    const several = diagnostics.find(
      (d) =>
        d.summary.includes('"e2: missing service Logger"') &&
        d.summary.includes('"e2: missing service Config"')
    )
    expect(several).toBeDefined()
  })

  test('catches a service required only transitively by another provider', () => {
    // Nothing in the program mentions Config; only DbNeedsConfig does. The
    // filter on the code keeps the single-line `runtime` diagnostic out.
    const transitive = diagnostics.filter(
      (d) =>
        d.code === 'TS2345' &&
        [d.summary, ...d.detail].some((l) => l.includes('e2: missing service Config'))
    )
    expect(transitive.length).toBeGreaterThanOrEqual(1)
    expect(transitive.at(-1)?.detail.at(-1)).toBe(
      `Type 'Fx<User, DbError, "Db" | "Logger">' is not assignable to type '"e2: missing service Config"'.`
    )
  })
})

describe('an implementation that violates its contract', () => {
  test('names the smuggled dependency against the contract', () => {
    // The contract says `query` needs nothing; the body reaches for Logger.
    const diagnostic = find(`Type '"Logger"' is not assignable`)
    expect(diagnostic.detail.at(-1)).toBe(`Type '"Logger"' is not assignable to type 'never'.`)
    expect(diagnostic.detail.at(-2)).toContain(
      `is not assignable to type 'Fx<User, DbError, never>'`
    )
  })

  test('fires at the implementation, not at its use site', () => {
    // 66 is the Db.make(...) call in the fixture.
    expect(find(`Type '"Logger"' is not assignable`).line).toBe(66)
  })

  test('KNOWN ROUGH EDGE: the useful line is buried in a structural walk', () => {
    // This one walks through Generator and IteratorResult before it reaches
    // the method. Pinned so that an improvement is visible rather than
    // accidental.
    const diagnostic = find(`Type '"Logger"' is not assignable`)
    expect(diagnostic.detail).toHaveLength(9)
  })
})

describe('a runtime whose list is not closed', () => {
  test('is a single line naming the missing service', () => {
    const diagnostic = find(`Property 'then' does not exist`)
    expect(diagnostic.code).toBe('TS2339')
    expect(diagnostic.summary).toBe(
      `Property 'then' does not exist on type '"e2: missing service Config"'.`
    )
    expect(diagnostic.detail).toHaveLength(0)
  })
})

describe('forgotten yield*', () => {
  test('returning an Fx is reported where the effect is used', () => {
    const diagnostic = find('did you forget')
    expect(diagnostic.summary).toContain(
      `Argument of type '"e2: this generator returns an Fx - did you forget \`yield*\`?"'`
    )
  })

  test('a bare yield is rejected by the yielded-token constraint', () => {
    const diagnostic = find('[YieldTypeId]')
    expect(diagnostic.detail.at(-1)).toBe(
      `Property '[YieldTypeId]' is missing in type 'Service<"Db", DbSvc>' but required in type 'FxYield<any, any, any>'.`
    )
  })
})

describe('snapshot of the full diagnostic set', () => {
  test('wording is pinned', () => {
    expect(all.join('\n\n')).toMatchSnapshot()
  })
})
