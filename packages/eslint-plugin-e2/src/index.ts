import { createRequire } from 'node:module'
import { noFloatingFx } from './no_floating_fx.ts'

// Same relative path from src/ and from the published lib/.
const { name, version } = createRequire(import.meta.url)('../package.json') as { name: string; version: string }

export const rules = {
  'no-floating-fx': noFloatingFx,
}

export default {
  meta: { name, version },
  rules,
}

export { noFloatingFx }
