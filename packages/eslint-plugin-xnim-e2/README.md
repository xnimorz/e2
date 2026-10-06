# eslint-plugin-xnim-e2

Lint rules for [e2](https://xnimorz.github.io/e2/).

An e2 effect is a description: building one and not running it does nothing, silently. The type system catches most shapes of that mistake; `e2/no-floating-fx` catches the rest:

| Mistake | |
|---|---|
| `db.query(id)` as a bare statement | flagged |
| `if (someFx)`, `!someFx`, `someFx ? a : b` | flagged |
| `await someFx` | flagged |
| `[...someFx]`, `Promise.all([someFx])` | flagged |

A discarded `Result` is not flagged: it is eager, so by the time you hold one the work has happened.

## Install

```bash
npm install --save-dev eslint-plugin-xnim-e2 @typescript-eslint/parser
```

The rule needs type information, so it runs with typed linting.

```js
// eslint.config.mjs
import parser from '@typescript-eslint/parser'
import e2 from 'eslint-plugin-xnim-e2'

export default [
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { e2 },
    rules: { 'e2/no-floating-fx': 'error' },
  },
]
```

Flat config registers a plugin under whatever key you give it; `e2` keeps the rule id `e2/no-floating-fx`.

The rule recognises an effect by the brand on e2's `Fx` type, so it does not need to resolve the `e2` module and works however e2 is installed.
