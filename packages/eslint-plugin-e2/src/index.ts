import { noFloatingFx } from './no_floating_fx.ts'

export const rules = {
  'no-floating-fx': noFloatingFx,
}

export default {
  meta: { name: 'eslint-plugin-e2', version: '0.0.0' },
  rules,
}

export { noFloatingFx }
