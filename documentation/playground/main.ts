/**
 * The e2 playground: Monaco with e2's own sources loaded into its TypeScript
 * service, so hovers, completions and the compile-time diagnostics are the
 * real ones, and a sandbox frame that runs the emitted JavaScript against the
 * browser build of e2.
 *
 * Everything this page loads is produced by `scripts/build-site.ts`:
 * `e2.js` (the library), `e2-lib.json` (its sources, for the type checker),
 * `examples.json`, `bridge.js` (the frame's console bridge) and the two
 * Monaco workers.
 */
import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/typescript/register'
import {
  ModuleKind,
  getTypeScriptWorker,
  typescriptDefaults,
  type ModuleResolutionKind,
  type ScriptTarget,
} from 'monaco-editor/languages/features/typescript/register'

interface Example {
  readonly id: string
  readonly title: string
  readonly code: string
}

interface Entry {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'system'
  readonly text: string
}

const here = new URL('./', import.meta.url)
const asset = (name: string): string => new URL(name, here).href

;(self as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id, label) =>
    new Worker(asset(label === 'typescript' || label === 'javascript' ? 'ts.worker.js' : 'editor.worker.js'), {
      type: 'module',
      name: label,
    }),
}

const element = <Type extends HTMLElement>(id: string): Type => {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`playground: #${id} is missing`)
  return found as Type
}

const ui = {
  editor: element<HTMLDivElement>('pg-editor'),
  examples: element<HTMLSelectElement>('pg-examples'),
  run: element<HTMLButtonElement>('pg-run'),
  share: element<HTMLButtonElement>('pg-share'),
  reset: element<HTMLButtonElement>('pg-reset'),
  status: element<HTMLSpanElement>('pg-status'),
  output: element<HTMLOListElement>('pg-output'),
  problems: element<HTMLOListElement>('pg-problems'),
  problemCount: element<HTMLSpanElement>('pg-problem-count'),
  clear: element<HTMLButtonElement>('pg-clear'),
}

// --- the type checker -------------------------------------------------------

/**
 * The same options the repository is checked with, plus what emitting needs:
 * `rewriteRelativeImportExtensions` allows e2's `./fx.ts` imports where
 * `allowImportingTsExtensions` would forbid emit. ES2022 output downlevels
 * `await using`, which not every browser parses yet.
 */
// Monaco's enums stop short of ES2022 and Bundler; the worker's TypeScript has both.
typescriptDefaults.setCompilerOptions({
  target: 9 as ScriptTarget, // ES2022
  module: ModuleKind.ESNext,
  moduleResolution: 100 as ModuleResolutionKind, // Bundler
  // No `lib`: the default for the target, lib.es2022.full.d.ts, includes the DOM.
  strict: true,
  noUncheckedIndexedAccess: true,
  useDefineForClassFields: true,
  rewriteRelativeImportExtensions: true,
  moduleDetection: 3, // force: every file is a module, so top-level await works
  skipLibCheck: true,
})
typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false })
typescriptDefaults.setEagerModelSync(true)

const loadLibrary = async (): Promise<void> => {
  const sources = (await (await fetch(asset('e2-lib.json'))).json()) as Record<string, string>
  for (const [name, text] of Object.entries(sources)) {
    typescriptDefaults.addExtraLib(text, `file:///node_modules/e2/${name}`)
  }
}

// --- the editor --------------------------------------------------------------

const model = monaco.editor.createModel('', 'typescript', monaco.Uri.parse('file:///playground.ts'))

const editor = monaco.editor.create(ui.editor, {
  model,
  theme: 'vs-dark',
  automaticLayout: true,
  minimap: { enabled: false },
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 13.5,
  lineHeight: 21,
  tabSize: 2,
  scrollBeyondLastLine: false,
  padding: { top: 14, bottom: 14 },
  renderLineHighlight: 'gutter',
  wordWrap: 'on',
  wrappingIndent: 'same',
  fixedOverflowWidgets: true,
})
void document.fonts.ready.then(() => monaco.editor.remeasureFonts())

editor.addAction({
  id: 'e2.run',
  label: 'Run',
  keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
  run: () => {
    void execute()
  },
})

// --- problems ------------------------------------------------------------------

const renderProblems = (): void => {
  const markers = monaco.editor
    .getModelMarkers({ resource: model.uri })
    .sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber)
  const errors = markers.filter((marker) => marker.severity === monaco.MarkerSeverity.Error).length
  const others = markers.length - errors
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

  ui.problemCount.textContent =
    markers.length === 0
      ? 'none'
      : [errors > 0 ? count(errors, 'error') : '', others > 0 ? count(others, 'warning') : ''].filter(Boolean).join(', ')
  ui.problems.replaceChildren(
    ...markers.map((marker) => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = marker.severity === monaco.MarkerSeverity.Error ? 'err' : 'warn'
      const where = document.createElement('span')
      where.className = 'where'
      where.textContent = `${marker.startLineNumber}:${marker.startColumn}`
      const message = document.createElement('span')
      message.className = 'msg'
      message.textContent = marker.message
      button.append(where, message)
      button.addEventListener('click', () => {
        editor.setPosition({ lineNumber: marker.startLineNumber, column: marker.startColumn })
        editor.revealPositionInCenter({ lineNumber: marker.startLineNumber, column: marker.startColumn })
        editor.focus()
      })
      item.append(button)
      return item
    })
  )
}
monaco.editor.onDidChangeMarkers((uris) => {
  if (uris.some((uri) => uri.toString() === model.uri.toString())) renderProblems()
})

// --- output ----------------------------------------------------------------------

const print = (entry: Entry): void => {
  const line = document.createElement('li')
  line.className = entry.level
  line.textContent = entry.text
  ui.output.append(line)
  line.scrollIntoView({ block: 'nearest' })
}

const setStatus = (text: string, state: 'idle' | 'running' | 'ok' | 'failed'): void => {
  ui.status.textContent = text
  ui.status.dataset.state = state
}

ui.clear.addEventListener('click', () => ui.output.replaceChildren())

// --- running -----------------------------------------------------------------------

let frame: HTMLIFrameElement | undefined
let currentRun = ''
let startedAt = 0

const emit = async (): Promise<string> => {
  const worker = await (await getTypeScriptWorker())(model.uri)
  const output = await worker.getEmitOutput(model.uri.toString())
  const js = output.outputFiles.find((file) => file.name.endsWith('.js'))
  if (js === undefined) throw new Error('TypeScript produced no JavaScript for this file')
  return js.text
}

/**
 * A fresh frame per run. Removing the previous one is what stops whatever it
 * left behind - timers, forked fibers, pending promises - without the user's
 * code having to cooperate.
 */
const execute = async (): Promise<void> => {
  frame?.remove()
  ui.output.replaceChildren()
  setStatus('Compiling…', 'running')

  let js: string
  try {
    js = await emit()
  } catch (error) {
    print({ level: 'error', text: String(error) })
    setStatus('Could not compile', 'failed')
    return
  }

  const errors = monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter((marker) => marker.severity === monaco.MarkerSeverity.Error).length
  if (errors > 0) {
    print({ level: 'system', text: `Running despite ${errors} type error${errors === 1 ? '' : 's'}; see Problems.` })
  }

  currentRun = crypto.randomUUID()
  startedAt = performance.now()
  setStatus('Running…', 'running')

  const module = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }))
  const importMap = JSON.stringify({ imports: { e2: asset('e2.js') } })
  frame = document.createElement('iframe')
  frame.name = currentRun
  frame.title = 'Playground sandbox'
  frame.hidden = true
  frame.srcdoc = `<!doctype html><meta charset="utf-8">
<script type="importmap">${importMap}</script>
<script src="${asset('bridge.js')}"></script>
<script type="module">import(${JSON.stringify(module)}).then(() => __settle(false), (reason) => __settle(true, reason))</script>`
  document.body.append(frame)
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { source?: string; runId?: string; kind?: string; entry?: Entry; failed?: boolean }
  if (data?.source !== 'e2-playground' || data.runId !== currentRun) return
  if (data.kind === 'console' && data.entry !== undefined) print(data.entry)
  if (data.kind === 'done') {
    const elapsed = Math.round(performance.now() - startedAt)
    setStatus(data.failed ? `Failed after ${elapsed} ms` : `Done in ${elapsed} ms`, data.failed ? 'failed' : 'ok')
  }
})

ui.run.addEventListener('click', () => void execute())

// --- examples and sharing ------------------------------------------------------------

const SHARED = 'shared'
let examples: readonly Example[] = []

const encode = async (text: string): Promise<string> => {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const decode = async (encoded: string): Promise<string> => {
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

const show = (code: string, selected: string): void => {
  model.setValue(code)
  ui.examples.value = selected
  ui.reset.disabled = selected === SHARED
  editor.setScrollTop(0)
}

/** `#services` opens an example; `#code=…` opens shared code. */
const fromHash = async (): Promise<boolean> => {
  const hash = location.hash.slice(1)
  if (hash.startsWith('code=')) {
    try {
      show(await decode(hash.slice('code='.length)), SHARED)
      return true
    } catch {
      print({ level: 'error', text: 'That shared link could not be decoded.' })
      return false
    }
  }
  const example = examples.find((candidate) => candidate.id === hash)
  if (example !== undefined) show(example.code, example.id)
  return example !== undefined
}

ui.examples.addEventListener('change', () => {
  const example = examples.find((candidate) => candidate.id === ui.examples.value)
  if (example === undefined) return
  history.replaceState(null, '', `#${example.id}`)
  show(example.code, example.id)
  void execute()
})

ui.reset.addEventListener('click', () => {
  const example = examples.find((candidate) => candidate.id === ui.examples.value)
  if (example !== undefined) show(example.code, example.id)
})

ui.share.addEventListener('click', async () => {
  const url = new URL(location.href)
  url.hash = `code=${await encode(model.getValue())}`
  history.replaceState(null, '', url)
  if (ui.examples.querySelector(`option[value="${SHARED}"]`) === null) {
    ui.examples.append(new Option('Shared code', SHARED))
  }
  ui.examples.value = SHARED
  ui.reset.disabled = true
  try {
    await navigator.clipboard.writeText(url.href)
    setStatus('Link copied', 'ok')
  } catch {
    setStatus('Link is in the address bar', 'ok')
  }
})

window.addEventListener('hashchange', () => {
  void fromHash().then(async (loaded) => {
    if (loaded) await execute()
  })
})

// --- start -------------------------------------------------------------------------

const start = async (): Promise<void> => {
  setStatus('Loading…', 'running')
  const [loaded] = await Promise.all([fetch(asset('examples.json')).then((response) => response.json()), loadLibrary()])
  examples = loaded as readonly Example[]
  ui.examples.replaceChildren(...examples.map((example) => new Option(example.title, example.id)))
  if (location.hash.startsWith('#code=')) ui.examples.append(new Option('Shared code', SHARED))

  const first = examples[0]
  if (!(await fromHash()) && first !== undefined) show(first.code, first.id)
  renderProblems()
  setStatus('Ready', 'idle')
  await execute()
}

void start().catch((error: unknown) => {
  print({ level: 'error', text: `The playground failed to start: ${String(error)}` })
  setStatus('Failed to start', 'failed')
})
