import { describe, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The playground's examples are documentation that runs. `tsc` already checks
 * that they compile; this checks that they still run to completion, each in
 * its own process, as the playground's sandbox frame would.
 */
const directory = join(import.meta.dir, 'examples')
const examples = (await readdir(directory)).filter((name) => name.endsWith('.ts'))

describe('playground examples', () => {
  for (const name of examples) {
    test(`${name} runs to completion`, async () => {
      const child = Bun.spawn(['bun', 'run', join(directory, name)], { stdout: 'pipe', stderr: 'pipe' })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect(stderr).toBe('')
      expect(code).toBe(0)
    })
  }
})
