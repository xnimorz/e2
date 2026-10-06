import { ESLintUtils, TSESTree } from '@typescript-eslint/utils'
import type * as ts from 'typescript'

/**
 * An Fx is a lazy description. Creating one and not `yield*`-ing it does
 * nothing at all, silently.
 *
 * The type system catches most shapes of this mistake - `Fx` carries a
 * `unique symbol` brand, so it is structurally incompatible with anything you
 * might mistake it for, and the return-position guard rejects
 * `return someFx()`. What types cannot catch is a value simply being
 * discarded, or coerced to a boolean, or awaited. That is what this rule is
 * for, and it is cheap precisely because the brand makes detection exact.
 */

const createRule = ESLintUtils.RuleCreator(() => 'https://xnimorz.github.io/e2/effects.html#footgun')

/**
 * The brand appears in the type as a computed property whose escaped name is
 * `__@FxTypeId@<declaration id>`. Matching on the prefix identifies an Fx
 * without needing to resolve the library's module from the linted project.
 */
const FX_BRAND_PREFIX = '__@FxTypeId@'

function hasBrand(type: ts.Type): boolean {
  if (type.isUnion() || type.isIntersection()) {
    return type.types.every((member) => hasBrand(member))
  }
  return type.getProperties().some((symbol) => symbol.getName().startsWith(FX_BRAND_PREFIX))
}

/**
 * `Ok` and `Err` carry the Fx brand too - Result is the pure subset of Fx -
 * but they are *eager*. By the time you hold one the work has happened, so
 * discarding it is not the mistake this rule is about. (Silently dropping a
 * failure is a real mistake, but a different one, for a different rule.)
 */
function isEagerResult(checker: ts.TypeChecker, type: ts.Type): boolean {
  const members = type.isUnion() ? type.types : [type]
  return members.every((member) => {
    const service = member.getProperty('_tag')
    if (service === undefined) {
      return false
    }
    const tagType = checker.getTypeOfSymbolAtLocation(
      service,
      service.valueDeclaration ?? (service.declarations?.[0] as ts.Declaration)
    )
    return (
      tagType.isStringLiteral() && (tagType.value === 'Ok' || tagType.value === 'Err')
    )
  })
}

export const noFloatingFx = createRule({
  name: 'no-floating-fx',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an Fx to be used, since building one without running it does nothing',
    },
    messages: {
      floating:
        'This Fx is never run. Did you forget `yield*`? Building an Fx has no effect on its own.',
      condition:
        'An Fx is always truthy, so this condition is meaningless. Did you forget `yield*`?',
      awaited:
        'Awaiting an Fx returns the Fx itself, not its value. Use `yield*` inside an fx body, or `run(...)`.',
      spread:
        'Spreading an Fx yields the Fx itself, not its value. Did you forget `yield*`?',
      promiseCombinator:
        'An Fx is not a promise, so {{combinator}} resolves it to the Fx itself. Use e2\u2019s `all` or `race` instead.',
    },
    schema: [],
  },
  defaultOptions: [],

  create(context) {
    const services = ESLintUtils.getParserServices(context)
    const checker = services.program.getTypeChecker()

    const isFx = (node: TSESTree.Node): boolean => {
      const type = checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node))
      return hasBrand(type) && !isEagerResult(checker, type)
    }

    const reportIfFx = (
      node: TSESTree.Node,
      messageId: 'floating' | 'condition' | 'awaited' | 'spread'
    ): void => {
      if (isFx(node)) {
        context.report({ node, messageId })
      }
    }

    const PROMISE_COMBINATORS = new Set(['all', 'allSettled', 'race', 'any'])

    /** `Promise.all([...])` and friends, which silently resolve to the Fx. */
    const promiseCombinatorName = (node: TSESTree.CallExpression): string | undefined => {
      const { callee } = node
      if (
        callee.type !== TSESTree.AST_NODE_TYPES.MemberExpression ||
        callee.object.type !== TSESTree.AST_NODE_TYPES.Identifier ||
        callee.object.name !== 'Promise' ||
        callee.property.type !== TSESTree.AST_NODE_TYPES.Identifier ||
        !PROMISE_COMBINATORS.has(callee.property.name)
      ) {
        return undefined
      }
      return `Promise.${callee.property.name}`
    }

    return {
      // `db.query(id)` on a line of its own: built, then dropped.
      ExpressionStatement(node): void {
        const { expression } = node
        // An assignment statement evaluates to the assigned value, but the
        // value is stored, not dropped. `fiber.current = node.source` is the
        // interpreter doing its job, not a forgotten yield*.
        if (
          expression.type === TSESTree.AST_NODE_TYPES.AssignmentExpression ||
          // Handled by their own visitors.
          expression.type === TSESTree.AST_NODE_TYPES.YieldExpression ||
          expression.type === TSESTree.AST_NODE_TYPES.AwaitExpression
        ) {
          return
        }
        reportIfFx(expression, 'floating')
      },

      // `if (someFx)`, `while (someFx)`, `someFx ? a : b` - always truthy.
      IfStatement(node): void {
        reportIfFx(node.test, 'condition')
      },
      WhileStatement(node): void {
        reportIfFx(node.test, 'condition')
      },
      DoWhileStatement(node): void {
        reportIfFx(node.test, 'condition')
      },
      ConditionalExpression(node): void {
        reportIfFx(node.test, 'condition')
      },
      UnaryExpression(node): void {
        if (node.operator === '!') {
          reportIfFx(node.argument, 'condition')
        }
      },

      // `await someFx` resolves to the Fx, because it has no `then`.
      AwaitExpression(node): void {
        reportIfFx(node.argument, 'awaited')
      },

      // `[...someFx]`, `f(...someFx)`.
      SpreadElement(node): void {
        reportIfFx(node.argument, 'spread')
      },

      // `Promise.all([someFx])` - the array is a promise combinator's input,
      // so every Fx in it resolves to itself rather than to its value.
      CallExpression(node): void {
        const combinator = promiseCombinatorName(node)
        if (combinator === undefined) {
          return
        }
        const [first] = node.arguments
        if (first?.type !== TSESTree.AST_NODE_TYPES.ArrayExpression) {
          return
        }
        for (const element of first.elements) {
          if (element != null && isFx(element)) {
            context.report({
              node: element,
              messageId: 'promiseCombinator',
              data: { combinator },
            })
          }
        }
      },
    }
  },
})
