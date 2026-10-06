/**
 * A small TypeScript highlighter for the documentation's code blocks.
 *
 * It emits the same classes the hand-highlighted pages use (`k` keyword, `s`
 * string, `t` type, `c` comment, `n` number, `y` for `yield*`), so generated
 * and hand-written blocks look identical. It is a tokenizer, not a parser:
 * a capitalised name is a type where the syntax around it says so - after
 * `:`, `extends`, `new` and friends, or inside generic brackets.
 */

const KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'constructor',
  'continue', 'declare', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally',
  'for', 'from', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let',
  'new', 'null', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'static',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'keyof', 'undefined', 'using',
  'var', 'void', 'while', 'yield',
])

const PRIMITIVES = new Set(['string', 'number', 'boolean', 'unknown', 'never', 'any', 'bigint', 'symbol', 'object'])

/** Words after which a capitalised name is a type. */
const TYPE_CONTEXT = new Set([':', '<', '|', '&', 'extends', 'implements', 'interface', 'class', 'type', 'new', 'as', 'satisfies', 'keyof', 'typeof'])

const TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\byield\s*\*)|(\bfunction\s*\*)|(\b\d[\d_]*(?:\.\d+)?n?\b)|([A-Za-z_$][\w$]*)|(=>|[<>{}()[\];:,.|&?=+\-*/!%])|(\s+)|(.)/g

const escape = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const span = (cls: string, text: string): string => `<span class="${cls}">${escape(text)}</span>`

export function highlight(source: string): string {
  let out = ''
  let previous = ''
  let previousWasName = false
  let genericDepth = 0

  for (const match of source.matchAll(TOKEN)) {
    const [text, comment, string, yieldStar, generator, number, name, punct, space] = match
    if (space !== undefined) {
      out += text
      continue
    }
    let isName = false
    if (comment !== undefined) out += span('c', text)
    else if (string !== undefined) out += span('s', text)
    else if (yieldStar !== undefined) out += span('y', 'yield*')
    else if (generator !== undefined) out += span('k', 'function*')
    else if (number !== undefined) out += span('n', text)
    else if (name !== undefined) {
      isName = true
      const next = source[match.index + text.length]
      if (KEYWORDS.has(text)) out += span('k', text)
      else if (PRIMITIVES.has(text) && (TYPE_CONTEXT.has(previous) || genericDepth > 0 || previous === ',')) out += span('t', text)
      else if (/^[A-Z]/.test(text) && (TYPE_CONTEXT.has(previous) || genericDepth > 0 || next === '<')) out += span('t', text)
      else out += escape(text)
    } else if (punct !== undefined) {
      // `<` straight after a name opens type arguments; `a < b` has a space.
      if (text === '<' && previousWasName) genericDepth += 1
      else if (text === '>' && genericDepth > 0) genericDepth -= 1
      // A comparison written without spaces never closes; a statement end resets it.
      else if (text === ';') genericDepth = 0
      out += escape(text)
    } else out += escape(text)

    previous = text
    previousWasName = isName
  }
  return out
}

/** Lines between `// #region name` and `// #endregion`, dedented. */
export function region(source: string, name: string, file: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.trim() === `// #region ${name}`)
  if (start === -1) throw new Error(`highlight: ${file} has no region "${name}"`)
  const end = lines.findIndex((line, index) => index > start && line.trim() === '// #endregion')
  if (end === -1) throw new Error(`highlight: region "${name}" in ${file} is not closed`)
  const body = lines.slice(start + 1, end)
  const indent = Math.min(...body.filter((line) => line.trim() !== '').map((line) => line.length - line.trimStart().length))
  return body.map((line) => line.slice(indent)).join('\n').replace(/\s+$/, '')
}

/** The source as the playground shows it: region markers removed. */
export const withoutRegions = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*\/\/ #(end)?region\b/.test(line))
    .join('\n')
