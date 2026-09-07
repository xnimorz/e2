import { describe, expect, test } from 'bun:test'

/**
 * e2 targets Bun *and* the browser, which means no `node:async_hooks` and no
 * Node globals anywhere in the core. That claim is only worth making if it is
 * checked, so this bundles the library for the browser and runs it with every
 * Node global shadowed out of scope.
 */

const entry = new URL('./browser/entry.ts', import.meta.url).pathname

const built = await Bun.build({
  entrypoints: [entry],
  target: 'browser',
  format: 'iife',
  minify: false,
})

const bundle = built.success ? await (built.outputs[0] as Bun.BuildArtifact).text() : ''

describe('browser bundle', () => {
  test('builds for --target=browser', () => {
    expect(built.success).toBe(true)
    expect(bundle.length).toBeGreaterThan(0)
  })

  test('pulls in no Node builtins', () => {
    // The whole reason the dependency channel is threaded through the
    // interpreter rather than through AsyncLocalStorage.
    for (const builtin of [
      'node:async_hooks',
      'node:process',
      'node:buffer',
      'node:fs',
      'async_hooks',
    ]) {
      expect(bundle).not.toContain(builtin)
    }
  })

  test('references no Node globals', () => {
    for (const global of ['process.env', '__dirname', '__filename', 'Buffer.from']) {
      expect(bundle).not.toContain(global)
    }
  })

  test('is small enough to ship', () => {
    // A whole DI + control-flow runtime. effect@3.22.1 unpacks to 27 MB.
    expect(bundle.length).toBeLessThan(120_000)
  })
})

describe('running in a browser-shaped environment', () => {
  test('the three-service example works with Node globals shadowed', async () => {
    // Naming these as parameters shadows them inside the bundle, so any use
    // of `process`, `require` and friends would throw rather than silently
    // succeed because Bun happens to provide them.
    const evaluate = new Function(
      'process',
      'Buffer',
      'require',
      'module',
      'exports',
      '__dirname',
      '__filename',
      'global',
      `${bundle}\nreturn globalThis.__e2_browser_result`
    ) as () => Promise<Record<string, unknown>>

    const result = await evaluate()

    expect(result.found).toEqual({ id: '1', name: 'Ada' })
    expect(result.missingIsErr).toBe(true)
    expect(result.missingId).toBe('nope')
    // setTimeout, AbortSignal and structured concurrency
    expect(result.raced).toBe('fast')
    // retry with real delays
    expect(result.retried).toBe(3)
    expect(result.viaRuntime).toEqual({ id: '1', name: 'Ada' })
    expect(result.logged).toContain('load 1')
    // Teardown ran after every entry point. Note the count: `run` builds AND
    // tears down its own graph per call - four runs plus one runtime is five
    // releases. Anything long-lived wants `runtime`, not `run` in a loop.
    expect(result.released).toHaveLength(5)
    expect(new Set(result.released as string[])).toEqual(new Set(['pool']))
  })
})
