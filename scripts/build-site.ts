/**
 * Builds the documentation site, playground included, into `out/site`.
 *
 *   bun run site          build
 *   bun run site:serve    build, then serve on http://localhost:8732
 *
 * The output is static and relative-linked, so it works from any base path:
 * GitHub Pages serves it under `/e2/`.
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { highlight, region, withoutRegions } from './highlight.ts'

const root = join(import.meta.dir, '..')
const docs = join(root, 'documentation')
const out = join(root, 'out', 'site')
const playground = join(out, 'playground')

/** Examples in the order the playground lists them, keyed by file name. */
const EXAMPLES = ['services', 'errors', 'lazy', 'batch', 'concurrency', 'testing'] as const

/** The guides page, in order. Each is also a playground example. */
const GUIDES = [
  'guide-first-service',
  'guide-wire-an-app',
  'guide-failures',
  'guide-testing',
  'guide-lazy',
  'guide-batching',
  'guide-cancellation',
] as const

const exampleSource = (id: string): Promise<string> =>
  Bun.file(join(docs, 'playground', 'examples', `${id}.ts`)).text()

const fail = (what: string, logs: readonly unknown[]): never => {
  for (const log of logs) console.error(log)
  throw new Error(`site: ${what} failed`)
}

async function bundle(
  what: string,
  options: Omit<Parameters<typeof Bun.build>[0], 'target'> & { target?: 'browser' }
): Promise<void> {
  const result = await Bun.build({ target: 'browser', minify: true, ...options })
  if (!result.success) fail(what, result.logs)
}

const unescape = (html: string): string =>
  html.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&')

/**
 * Fills code blocks at build time, so the code on a page is code that runs:
 *
 *   <pre class="code" data-snippet="guide-lazy#memo"></pre>   a region of a playground example
 *   <pre class="code" data-highlight>const a = 1</pre>         inline code, highlighted
 */
async function render(html: string, page: string): Promise<string> {
  const snippets = [...html.matchAll(/<pre class="code" data-snippet="([\w-]+)#([\w-]+)"><\/pre>/g)]
  for (const [block, id, name] of snippets) {
    const code = region(await exampleSource(id!), name!, `${id}.ts`)
    html = html.replace(block, `<pre class="code"><code>${highlight(code)}</code></pre>`)
  }
  html = html.replace(
    /<pre class="code" data-highlight>([\s\S]*?)<\/pre>/g,
    (_, code: string) => `<pre class="code"><code>${highlight(unescape(code))}</code></pre>`
  )
  if (html.includes('data-snippet=')) throw new Error(`site: ${page} has a malformed data-snippet block`)
  return html
}

async function pages(): Promise<void> {
  await mkdir(out, { recursive: true })
  for (const entry of await readdir(docs, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) {
      const html = await Bun.file(join(docs, entry.name)).text()
      await Bun.write(join(out, entry.name), await render(html, entry.name))
    }
  }
  await cp(join(docs, 'assets'), join(out, 'assets'), { recursive: true })
}

/** The library, as the browser build the sandbox frame imports. */
async function library(): Promise<void> {
  await bundle('e2.js', {
    entrypoints: [join(root, 'src', 'index.ts')],
    outdir: playground,
    naming: 'e2.js',
    format: 'esm',
    // Error classes name themselves after their constructor; keep the names readable.
    minify: { whitespace: true, syntax: true, identifiers: false },
  })
}

/** e2's own sources, for the editor's type checker. Tests are not part of the library. */
async function librarySources(): Promise<void> {
  const sources: Record<string, string> = {}
  for (const entry of await readdir(join(root, 'src'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      sources[entry.name] = await Bun.file(join(root, 'src', entry.name)).text()
    }
  }
  await Bun.write(join(playground, 'e2-lib.json'), JSON.stringify(sources))
}

/** Each example's title is its first comment line, up to the colon. */
async function examples(): Promise<void> {
  const entries = [
    ...EXAMPLES.map((id) => ({ id, group: 'Examples', prefix: '' })),
    ...GUIDES.map((id, index) => ({ id, group: 'Guides', prefix: `${index + 1}. ` })),
  ]
  const list = await Promise.all(
    entries.map(async ({ id, group, prefix }) => {
      const code = withoutRegions(await exampleSource(id))
      const title = /^\/\/ ([^:\n]+):/.exec(code)?.[1]
      if (title === undefined) throw new Error(`site: examples/${id}.ts needs a "// Title: …" first line`)
      return { id, group, title: `${prefix}${title}`, code }
    })
  )
  await Bun.write(join(playground, 'examples.json'), JSON.stringify(list))
}

async function editor(): Promise<void> {
  const monaco = join(root, 'node_modules', 'monaco-editor', 'esm', 'vs')
  await bundle('playground', {
    entrypoints: [join(docs, 'playground', 'main.ts')],
    outdir: playground,
    root: join(docs, 'playground'),
    format: 'esm',
    naming: { entry: '[name].[ext]', asset: '[name]-[hash].[ext]' },
  })
  await bundle('bridge', {
    entrypoints: [join(docs, 'playground', 'bridge.ts')],
    outdir: playground,
    format: 'iife',
    naming: 'bridge.js',
  })
  await bundle('editor worker', {
    entrypoints: [join(monaco, 'editor', 'editor.worker.js')],
    outdir: playground,
    format: 'esm',
    naming: 'editor.worker.js',
  })
  await bundle('typescript worker', {
    entrypoints: [join(monaco, 'languages', 'features', 'typescript', 'ts.worker.js')],
    outdir: playground,
    format: 'esm',
    naming: 'ts.worker.js',
  })
}

async function build(): Promise<void> {
  const started = performance.now()
  await rm(out, { recursive: true, force: true })
  await pages()
  await Promise.all([library(), librarySources(), examples(), editor()])
  console.log(`site: built ${relative(root, out)} in ${Math.round(performance.now() - started)} ms`)
}

async function serve(port: number): Promise<void> {
  const server = Bun.serve({
    port,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname)
      const file = Bun.file(join(out, path.endsWith('/') ? `${path}index.html` : path))
      if (!file.name?.startsWith(out) || !(await file.exists())) {
        return new Response('not found', { status: 404 })
      }
      return new Response(file)
    },
  })
  console.log(`site: http://localhost:${server.port}/`)
}

await build()
if (process.argv.includes('--serve')) await serve(8732)
