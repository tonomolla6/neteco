import { readFile, readdir } from 'node:fs/promises'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import {
  OrderOperationsBrowserDiagnosticError,
  ORDER_OPERATIONS_BROWSER_SCENARIOS
} from '../../scripts/lib/audit-native-order-operations-browser'
import {
  ORDER_RETURNS_BROWSER_SCENARIOS,
  OrderReturnsBrowserDiagnosticError
} from '../../scripts/lib/audit-native-order-returns-browser'
import { CATALOG_RELATIONS_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-catalog-relations-browser'
import { COMPANY_REVIEW_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-company-review-browser'
import { ADMIN_NAVIGATION_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-admin-navigation-browser'
import { CART_ADD_RECOVERY_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-cart-add-recovery-browser'
import { ACCOUNT_SETTINGS_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-account-settings-browser'
import { QUICK_ORDER_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-quick-order-browser'
import { GUEST_ORDER_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-guest-order-browser'
import { INVENTORY_ALERTS_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-inventory-alerts-browser'
import { SATISFACTION_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-satisfaction-browser'
import { PACKING_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-order-packing-browser'
import { PROMOTIONS_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-promotions-browser'
import { CART_SNAPSHOTS_BROWSER_SCENARIOS } from '../../scripts/lib/audit-native-cart-snapshots-browser'
import {
  INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS,
  InventoryCountImportBrowserError
} from '../../scripts/lib/audit-native-inventory-count-import-browser'

const source = await readFile(new URL('../../scripts/audit-cloudflare-shop.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('audit-cloudflare-shop.ts', source, ts.ScriptTarget.ESNext, true)
const declaration = ast.statements.find(
  (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'parseNativeShopAuditOptions'
)
if (!declaration) throw new Error('missing_native_audit_cli_parser')
// Evaluate only the real pure parser declaration. Never import/execute the
// audit module, instantiate Miniflare, inspect build artifacts or open browsers.
const compiled = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const exports: { parseNativeShopAuditOptions?: (args: string[]) => { browserMode: 'required' | 'not-run' } } = {}
new Function('exports', compiled.outputText)(exports)
const parse = exports.parseNativeShopAuditOptions!

describe('native shop audit explicit browser CLI and honest evidence integration', () => {
  it('connects count-import browser evidence to a lazy real warehouse preparation and its registry entry', () => {
    const calls: ts.CallExpression[] = []
    const declarations = new Map<string, ts.VariableDeclaration>()
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'auditNativeInventoryCountImportBrowser')
        calls.push(node)
      if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    const argument = call.arguments[0]
    if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error('missing_count_import_browser_arguments')
    const properties = new Map(argument.properties.map((property) => [property.name?.getText(ast), property]))
    for (const [name, expected] of [
      ['dispatch', 'nativeDispatch'],
      ['database', 'database'],
      ['browserMode', 'nativeBrowserMode']
    ] as const) {
      const property = properties.get(name)
      expect(
        property && ts.isPropertyAssignment(property) ? property.initializer.getText(ast) : property?.getText(ast)
      ).toBe(expected)
    }
    const prepare = properties.get('prepare')
    expect(
      prepare &&
        ts.isMethodDeclaration(prepare) &&
        prepare.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ).toBe(true)
    const prepareCalls: ts.CallExpression[] = []
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) prepareCalls.push(node)
      ts.forEachChild(node, visit)
    }
    visit(prepare!)
    const actors = prepareCalls.filter((node) => node.expression.getText(ast) === 'identity')
    expect(actors).toHaveLength(2)
    for (const actor of actors) {
      expect(actor.arguments[0] && ts.isStringLiteral(actor.arguments[0]) ? actor.arguments[0].text : null).toBe(
        'warehouse'
      )
      expect(actor.arguments[1]?.kind).toBe(ts.SyntaxKind.TrueKeyword)
    }
    expect(prepareCalls.some((node) => node.expression.getText(ast) === 'adminInventoryVariantSchema.parse')).toBe(true)
    expect(prepare!.getText(ast)).toMatch(/\/api\/admin\/inventory\/variants\//)
    const returnedFields = new Set<string>()
    let incrementedCurrentPhysical = false
    const dataFlow = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression))
        for (const property of node.expression.properties)
          if (property.name) returnedFields.add(property.name.getText(ast))
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === 'physicalQuantity' &&
        ts.isNumericLiteral(node.right) &&
        node.right.text === '1'
      )
        incrementedCurrentPhysical = true
      ts.forEachChild(node, dataFlow)
    }
    dataFlow(prepare!)
    expect(incrementedCurrentPhysical).toBe(true)
    for (const field of [
      'proposerCookie',
      'approverCookie',
      'variantLegacyId',
      'sku',
      'physicalQuantity',
      'balanceVersion',
      'countedPhysicalQuantity'
    ])
      expect(returnedFields.has(field)).toBe(true)
    expect(prepare!.getText(ast)).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:inventory_|identity_roles|role_permissions)/i
    )
    const result = declarations.get('inventoryCountImportBrowserAudit')
    expect(result?.initializer && ts.isAwaitExpression(result.initializer) ? result.initializer.expression : null).toBe(
      call
    )
    const registry = declarations.get('browserScenarioCounts')?.initializer
    if (!registry || !ts.isArrayLiteralExpression(registry)) throw new Error('missing_browser_registry')
    const entry = registry.elements.find(
      (element) =>
        ts.isObjectLiteralExpression(element) &&
        element.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(ast) === 'executed' &&
            property.initializer.getText(ast) === 'inventoryCountImportBrowserAudit.scenarios'
        )
    )
    expect(entry).toBeDefined()
    expect(entry!.getText(ast)).toContain('INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS.length')
    let counted = false,
      reported = false
    const evidence = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
        node.left.getText(ast) === 'completed' &&
        node.right.getText(ast) === 'inventoryCountImportBrowserAudit.scenarios'
      )
        counted = true
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(ast) === 'inventoryCountImportBrowser' &&
        node.initializer.getText(ast) === 'inventoryCountImportBrowserAudit'
      )
        reported = true
      ts.forEachChild(node, evidence)
    }
    evidence(ast)
    expect(counted).toBe(true)
    expect(reported).toBe(true)
  })
  it('prepares packing lazily from a paid parcel checkout and real guarded preparation commands, never fabricated fulfillment facts', () => {
    const calls: ts.CallExpression[] = []
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'auditNativeOrderPackingBrowser')
        calls.push(node)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(calls).toHaveLength(1)
    const argument = calls[0]!.arguments[0]!
    if (!ts.isObjectLiteralExpression(argument)) throw new Error('missing_packing_arguments')
    const properties = new Map(
      argument.properties.map((property) => [
        property.name?.getText(ast),
        ts.isPropertyAssignment(property) ? property.initializer.getText(ast) : property.getText(ast)
      ])
    )
    expect(properties.get('dispatch')).toBe('nativeDispatch')
    expect(properties.get('database')).toBe('database')
    expect(properties.get('browserMode')).toBe('nativeBrowserMode')
    const prepare = properties.get('prepare')!
    expect(prepare).toContain('auditNativeCheckoutPayment')
    expect(prepare).toContain("shippingMethod: 'parcel'")
    expect(prepare).toContain('quantity: 4')
    expect(prepare).toContain("['picking', 'packed']")
    expect(prepare).toContain('fulfillmentCommandReceiptSchema')
    expect(prepare).toContain('adminOrderFulfillmentSchema')
    expect(prepare).toContain("identity('admin', true)")
    expect(prepare).not.toMatch(
      /UPDATE (inventory|orders|order_fulfillments)|INSERT INTO (orders|order_payment_states)|DELETE FROM identity_rate_limits/
    )
    expect(source).toContain('completed += packingBrowserAudit.scenarios')
    expect(source).toContain('packingBrowser: packingBrowserAudit')
  })
  it('wires saved-cart journeys lazily from real owner carts, without fabricated prices or inventory', () => {
    const calls: ts.CallExpression[] = []
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'auditNativeCartSnapshotsBrowser')
        calls.push(node)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(calls).toHaveLength(1)
    const argument = calls[0]!.arguments[0]!
    if (!ts.isObjectLiteralExpression(argument)) throw new Error('missing_cart_snapshot_arguments')
    const properties = new Map(
      argument.properties.map((property) => [
        property.name?.getText(ast),
        ts.isPropertyAssignment(property) ? property.initializer.getText(ast) : property.getText(ast)
      ])
    )
    expect(properties.get('dispatch')).toBe('nativeDispatch')
    expect(properties.get('database')).toBe('database')
    expect(properties.get('browserMode')).toBe('nativeBrowserMode')
    expect(properties.get('prepare')).toContain('createCart')
    expect(properties.get('prepare')).toContain('setCartLine')
    expect(properties.get('prepare')).not.toMatch(/UPDATE inventory|INSERT INTO variants|price_gross_cents\s*=/)
    expect(source).toContain('completed += cartSnapshotsBrowserAudit.scenarios')
    expect(source).toContain('cartSnapshotsBrowser: cartSnapshotsBrowserAudit')
  })
  it('counts all51 actual browser scenarios as pending when no journey executed, preserving all49 previous journeys', () => {
    let initializer: ts.Expression | undefined
    const inspect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'browserScenarioCounts')
        initializer = node.initializer
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(initializer).toBeDefined()
    const names = [
      'analyticsBrowserAudit',
      'catalogExportAudit',
      'nativeImportBrowserProof',
      'typedAttributesAudit',
      'checkoutRecoveryBrowserAudit',
      'cartAddRecoveryBrowserAudit',
      'adminNavigationBrowserAudit',
      'orderOperationsBrowserAudit',
      'orderReturnsBrowserAudit',
      'companyReviewBrowserAudit',
      'accountSettingsBrowserAudit',
      'quickOrderBrowserAudit',
      'guestOrderBrowserAudit',
      'inventoryAlertsBrowserAudit',
      'satisfactionBrowserAudit',
      'packingBrowserAudit',
      'promotionsBrowserAudit',
      'CART_ADD_RECOVERY_BROWSER_SCENARIOS',
      'ADMIN_NAVIGATION_BROWSER_SCENARIOS',
      'ORDER_OPERATIONS_BROWSER_SCENARIOS',
      'ORDER_RETURNS_BROWSER_SCENARIOS',
      'COMPANY_REVIEW_BROWSER_SCENARIOS',
      'ACCOUNT_SETTINGS_BROWSER_SCENARIOS',
      'QUICK_ORDER_BROWSER_SCENARIOS',
      'GUEST_ORDER_BROWSER_SCENARIOS',
      'INVENTORY_ALERTS_BROWSER_SCENARIOS',
      'SATISFACTION_BROWSER_SCENARIOS',
      'PACKING_BROWSER_SCENARIOS',
      'PROMOTIONS_BROWSER_SCENARIOS',
      'cartSnapshotsBrowserAudit',
      'CART_SNAPSHOTS_BROWSER_SCENARIOS',
      'catalogRelationsBrowserAudit',
      'CATALOG_RELATIONS_BROWSER_SCENARIOS',
      'inventoryCountImportBrowserAudit',
      'INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS'
    ]
    const counts = new Function(...names, `return ${initializer!.getText(ast)}`)(
      { scenarios: 0 },
      { browser: { status: 'not_run' } },
      { scenarios: 0 },
      { browserScenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      { scenarios: 0 },
      CART_ADD_RECOVERY_BROWSER_SCENARIOS,
      ADMIN_NAVIGATION_BROWSER_SCENARIOS,
      ORDER_OPERATIONS_BROWSER_SCENARIOS,
      ORDER_RETURNS_BROWSER_SCENARIOS,
      COMPANY_REVIEW_BROWSER_SCENARIOS,
      ACCOUNT_SETTINGS_BROWSER_SCENARIOS,
      QUICK_ORDER_BROWSER_SCENARIOS,
      GUEST_ORDER_BROWSER_SCENARIOS,
      INVENTORY_ALERTS_BROWSER_SCENARIOS,
      SATISFACTION_BROWSER_SCENARIOS,
      PACKING_BROWSER_SCENARIOS,
      PROMOTIONS_BROWSER_SCENARIOS,
      { scenarios: 0 },
      CART_SNAPSHOTS_BROWSER_SCENARIOS,
      { scenarios: 0 },
      CATALOG_RELATIONS_BROWSER_SCENARIOS,
      { scenarios: 0 },
      INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS
    ) as Array<{ expected: number; executed: number }>
    expect(counts.reduce((sum, row) => sum + row.executed, 0)).toBe(0)
    expect(counts.reduce((sum, row) => sum + row.expected - row.executed, 0)).toBe(51)
    expect(counts.slice(0, -1).reduce((sum, row) => sum + row.expected, 0)).toBe(49)
    expect(INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS).toHaveLength(2)
    expect(counts.filter((row) => row.expected === ORDER_RETURNS_BROWSER_SCENARIOS.length)).toHaveLength(3)
    expect(ACCOUNT_SETTINGS_BROWSER_SCENARIOS).toEqual([
      'native_account_settings_compiled_preferences_receipt_privacy_export_desktop',
      'native_account_settings_compiled_preferences_receipt_privacy_export_mobile'
    ])
    const full = new Function(...names, `return ${initializer!.getText(ast)}`)(
      { scenarios: 2 },
      { browser: { status: 'passed' } },
      { scenarios: 7 },
      { browserScenarios: 2 },
      { scenarios: 2 },
      { scenarios: CART_ADD_RECOVERY_BROWSER_SCENARIOS.length },
      { scenarios: ADMIN_NAVIGATION_BROWSER_SCENARIOS.length },
      { scenarios: ORDER_OPERATIONS_BROWSER_SCENARIOS.length },
      { scenarios: ORDER_RETURNS_BROWSER_SCENARIOS.length },
      { scenarios: COMPANY_REVIEW_BROWSER_SCENARIOS.length },
      { scenarios: ACCOUNT_SETTINGS_BROWSER_SCENARIOS.length },
      { scenarios: QUICK_ORDER_BROWSER_SCENARIOS.length },
      { scenarios: GUEST_ORDER_BROWSER_SCENARIOS.length },
      { scenarios: INVENTORY_ALERTS_BROWSER_SCENARIOS.length },
      { scenarios: SATISFACTION_BROWSER_SCENARIOS.length },
      { scenarios: PACKING_BROWSER_SCENARIOS.length },
      { scenarios: PROMOTIONS_BROWSER_SCENARIOS.length },
      CART_ADD_RECOVERY_BROWSER_SCENARIOS,
      ADMIN_NAVIGATION_BROWSER_SCENARIOS,
      ORDER_OPERATIONS_BROWSER_SCENARIOS,
      ORDER_RETURNS_BROWSER_SCENARIOS,
      COMPANY_REVIEW_BROWSER_SCENARIOS,
      ACCOUNT_SETTINGS_BROWSER_SCENARIOS,
      QUICK_ORDER_BROWSER_SCENARIOS,
      GUEST_ORDER_BROWSER_SCENARIOS,
      INVENTORY_ALERTS_BROWSER_SCENARIOS,
      SATISFACTION_BROWSER_SCENARIOS,
      PACKING_BROWSER_SCENARIOS,
      PROMOTIONS_BROWSER_SCENARIOS,
      { scenarios: CART_SNAPSHOTS_BROWSER_SCENARIOS.length },
      CART_SNAPSHOTS_BROWSER_SCENARIOS,
      { scenarios: CATALOG_RELATIONS_BROWSER_SCENARIOS.length },
      CATALOG_RELATIONS_BROWSER_SCENARIOS,
      { scenarios: INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS.length },
      INVENTORY_COUNT_IMPORT_BROWSER_SCENARIOS
    ) as Array<{ expected: number; executed: number }>
    expect(full.reduce((sum, row) => sum + row.executed, 0)).toBe(51)
    expect(full.reduce((sum, row) => sum + Math.max(0, row.expected - row.executed), 0)).toBe(0)
  })
  it('wires satisfaction lazily through actual resolved support and delivered order sources without synthetic stock writes', () => {
    const calls: ts.CallExpression[] = []
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'auditNativeSatisfactionBrowser')
        calls.push(node)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(calls).toHaveLength(1)
    const argument = calls[0]!.arguments[0]!
    expect(ts.isObjectLiteralExpression(argument)).toBe(true)
    const properties = new Map(
      (argument as ts.ObjectLiteralExpression).properties.map((property) => [
        property.name?.getText(ast),
        ts.isPropertyAssignment(property) ? property.initializer.getText(ast) : property.getText(ast)
      ])
    )
    expect(properties.get('dispatch')).toBe('nativeDispatch')
    expect(properties.get('database')).toBe('database')
    expect(properties.get('origin')).toBe('origin')
    expect(properties.get('browserMode')).toBe('nativeBrowserMode')
    expect(properties.get('prepare')).toMatch(/supportReceiptSchema/)
    expect(properties.get('prepare')).toContain("state: 'resolved'")
    expect(properties.get('prepare')).toContain('ownedCheckoutAudit.orderId')
    expect(properties.get('prepare')).toContain('financialCheckoutAudit.orderId')
    expect(properties.get('prepare')).not.toMatch(/UPDATE inventory|INSERT INTO orders/)
    expect(source).toContain('completed += satisfactionBrowserAudit.scenarios')
    expect(source).toContain('satisfactionBrowser: satisfactionBrowserAudit')
  })
  it('wires inventory alerts lazily with actual inventory snapshots and counts only executed journeys', () => {
    const calls: ts.CallExpression[] = []
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'auditNativeInventoryAlertsBrowser')
        calls.push(node)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(calls).toHaveLength(1)
    const argument = calls[0]!.arguments[0]!
    expect(ts.isObjectLiteralExpression(argument)).toBe(true)
    const properties = new Map(
      (argument as ts.ObjectLiteralExpression).properties.map((property) => [
        property.name?.getText(ast),
        ts.isPropertyAssignment(property) ? property.initializer.getText(ast) : property.getText(ast)
      ])
    )
    expect(properties.get('dispatch')).toBe('nativeDispatch')
    expect(properties.get('browserMode')).toBe('nativeBrowserMode')
    expect(properties.get('prepareVariant')).toMatch(/adminInventoryVariantSchema/)
    expect(properties.get('snapshotInventory')).toMatch(/inventory_balances/)
    expect(properties.get('snapshotInventory')).toMatch(/inventory_movements/)
    expect(source).toContain('completed += inventoryAlertsBrowserAudit.scenarios')
    expect(source).toContain('inventoryAlertsBrowser: inventoryAlertsBrowserAudit')
  })
  it('wires guest order access once with lazy per-viewport preparation and only executed evidence', () => {
    const calls: ts.CallExpression[] = []
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'auditNativeGuestOrderBrowser') calls.push(node)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(calls).toHaveLength(1)
    const argument = calls[0]!.arguments[0]!
    expect(ts.isObjectLiteralExpression(argument)).toBe(true)
    const properties = new Map(
      (argument as ts.ObjectLiteralExpression).properties.map((property) => [
        property.name?.getText(ast),
        ts.isPropertyAssignment(property) ? property.initializer.getText(ast) : property.getText(ast)
      ])
    )
    expect(properties.get('dispatch')).toBe('nativeDispatch')
    expect(properties.get('browserMode')).toBe('nativeBrowserMode')
    expect(properties.get('prepareGuestOrder')).toMatch(/createNativeUnpaidOrder/)
    expect(properties.get('prepareGuestOrder')).toMatch(/deliverEmailTransport/)
    expect(properties.get('prepareGuestOrder')).toMatch(/guestOrderLinks/)
    expect(source).toContain('completed += guestOrderBrowserAudit.scenarios')
    expect(source).toContain('guestOrderBrowser: guestOrderBrowserAudit')
  })

  it('wires quick order once with lazy per-viewport preparation and only actual executed evidence', () => {
    const calls: ts.CallExpression[] = []
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'auditNativeQuickOrderBrowser') calls.push(node)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(calls).toHaveLength(1)
    const argument = calls[0]!.arguments[0]
    if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error('missing_quick_order_arguments')
    const properties = new Map(
      argument.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property)) return [[property.name.getText(ast), property.initializer.getText(ast)]]
        if (ts.isShorthandPropertyAssignment(property)) return [[property.name.text, property.name.text]]
        if (ts.isMethodDeclaration(property)) return [[property.name.getText(ast), property.getText(ast)]]
        return []
      })
    )
    expect(properties.get('dispatch')).toBe('nativeDispatch')
    expect(properties.get('database')).toBe('database')
    expect(properties.get('origin')).toBe('origin')
    expect(properties.get('browserMode')).toBe('nativeBrowserMode')
    expect(properties.get('prepareQuickOrder')).toMatch(/^async prepareQuickOrder\(viewport\)/)
    expect(properties.has('scenario')).toBe(true)
    expect(source).toContain('completed += quickOrderBrowserAudit.scenarios')
    expect(source).toContain('quickOrderBrowser: quickOrderBrowserAudit')
    expect(source).toMatch(
      /quickOrderBrowserAudit\.scenarios,\s*nativeBrowserMode === 'not-run' \? 0 : QUICK_ORDER_BROWSER_SCENARIOS\.length/
    )
  })
  it('wires the real account settings helper once with explicit browser mode and owner preparation, counting only its executed scenarios', () => {
    const calls: ts.CallExpression[] = []
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'auditNativeAccountSettingsBrowser')
        calls.push(node)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(calls).toHaveLength(1)
    const argument = calls[0]!.arguments[0]
    expect(argument && ts.isObjectLiteralExpression(argument)).toBe(true)
    if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error('missing_account_settings_arguments')
    const properties = new Map(
      argument.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property)) return [[property.name.getText(ast), property.initializer.getText(ast)]]
        if (ts.isShorthandPropertyAssignment(property)) return [[property.name.text, property.name.text]]
        if (ts.isMethodDeclaration(property)) return [[property.name.getText(ast), property.getText(ast)]]
        return []
      })
    )
    expect(properties.get('dispatch')).toBe('nativeDispatch')
    expect(properties.get('database')).toBe('database')
    expect(properties.get('origin')).toBe('origin')
    expect(properties.get('browserMode')).toBe('nativeBrowserMode')
    expect(properties.has('prepareOwner')).toBe(true)
    expect(properties.has('scenario')).toBe(true)
    expect(source).toContain('completed += accountSettingsBrowserAudit.scenarios')
    expect(source).toContain('accountSettingsBrowser: accountSettingsBrowserAudit')
    expect(source).toMatch(
      /accountSettingsBrowserAudit\.scenarios,\s*nativeBrowserMode === 'not-run' \? 0 : ACCOUNT_SETTINGS_BROWSER_SCENARIOS\.length/
    )
  })
  it('prints only the typed safe browser diagnostic, never raw error messages or lookalike properties', () => {
    const auditTry = ast.statements.find(ts.isTryStatement)
    expect(auditTry?.catchClause).toBeDefined()
    const compiledCatch = ts.transpileModule(auditTry!.catchClause!.block.getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText
    const record = (error: Error) => {
      const logger = { error: vi.fn() },
        exit = { exitCode: 0 }
      new Function(
        'error',
        'assert',
        'OrderOperationsBrowserDiagnosticError',
        'OrderReturnsBrowserDiagnosticError',
        'InventoryCountImportBrowserError',
        'console',
        'process',
        'scenario',
        'completed',
        'nativeBrowserMode',
        compiledCatch
      )(
        error,
        assert,
        OrderOperationsBrowserDiagnosticError,
        OrderReturnsBrowserDiagnosticError,
        InventoryCountImportBrowserError,
        logger,
        exit,
        'native_order_operations_browser_acceptance',
        350,
        'required'
      )
      expect(exit.exitCode).toBe(1)
      expect(logger.error).toHaveBeenCalledOnce()
      const output = String(logger.error.mock.calls[0]![0])
      expect(output).not.toContain('PRIVATE_SENTINEL')
      return JSON.parse(output) as Record<string, unknown>
    }
    const error = new OrderOperationsBrowserDiagnosticError({
      stage: 'admin_detail_history_heading',
      viewport: 'desktop',
      pathname: '/admin/pedidos',
      errorClass: 'TimeoutError',
      responses: [{ path: '/api/admin/capabilities', status: 200 }],
      counts: { historyHeading: 0, timelineItems: 0, annotationInputs: 0, loginInputs: 0, detailHeading: 1 },
      screenshotPath: null,
      captureFailed: false
    })
    error.message = 'PRIVATE_SENTINEL raw SQL, token or customer details'
    expect(record(error).browserDiagnostic).toEqual(error.safeDiagnostic)
    const returns = new OrderReturnsBrowserDiagnosticError(
      { stage: 'command_dispatch', action: 'received', status: null },
      new Error('PRIVATE_SENTINEL provider payload')
    )
    expect(record(returns).browserDiagnostic).toEqual(returns.safeDiagnostic)
    const countImport = new InventoryCountImportBrowserError('compiled_page', 'desktop')
    Object.assign(countImport, { message: 'PRIVATE_SENTINEL raw fixture error', token: 'PRIVATE_SENTINEL' })
    expect(record(countImport).browserDiagnostic).toEqual(countImport.safeDiagnostic)
    expect(
      record(Object.assign(new Error('PRIVATE_SENTINEL'), { safeDiagnostic: { token: 'PRIVATE_SENTINEL' } }))
        .browserDiagnostic
    ).toBeUndefined()
  })
  it('requires browser checks by default', () => {
    expect(parse([])).toEqual({ browserMode: 'required' })
  })
  it('accepts only the explicit --without-browser omission flag', () => {
    expect(parse(['--without-browser'])).toEqual({ browserMode: 'not-run' })
  })
  it.each([
    ['--without-browser', '--without-browser'],
    ['--unknown'],
    ['--no-browser'],
    ['--without-browser=true'],
    ['--without-browser', '--unknown'],
    ['catalog'],
    ['--'],
    ['--endpoint=PRIVATE_SENTINEL']
  ])('fails closed for unknown, repeated or positional arguments: %j', (...args) => {
    expect(() => parse(args)).toThrow('Only --without-browser is supported')
    try {
      parse(args)
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE_SENTINEL')
    }
  })
  it('validates CLI before build artifact access or workerd startup', () => {
    const parseCall = source.indexOf('parseNativeShopAuditOptions(process.argv.slice(2))')
    expect(parseCall).toBeGreaterThan(0)
    expect(parseCall).toBeLessThan(source.indexOf('await Promise.all([access(scriptPath), access(assetsDirectory)])'))
    expect(parseCall).toBeLessThan(source.indexOf('new Miniflare('))
  })
  it('requires the actual complete migration inventory and preserves helper-dependent scenario counts', async () => {
    expect(source).toContain("assert(migrations.includes('0055_catalog_import_jobs.sql'))")
    expect(source).toContain("assert(migrations.includes('0056_catalog_color_pattern.sql'))")
    expect(source).toContain("assert(migrations.includes('0057_catalog_import_job_commands.sql'))")
    const migrations = (await readdir(new URL('../../db/d1/migrations', import.meta.url)))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()
    const declaredCounts: number[] = []
    const requiredNames = new Set<string>()
    function inspect(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'assert.equal' &&
        node.arguments[0]?.getText(ast) === 'migrations.length' &&
        node.arguments[1] &&
        ts.isNumericLiteral(node.arguments[1])
      )
        declaredCounts.push(Number(node.arguments[1].text))
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'migrations.includes' &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        requiredNames.add(node.arguments[0].text)
      ts.forEachChild(node, inspect)
    }
    inspect(ast)
    expect(migrations.length).toBeGreaterThan(57)
    expect(declaredCounts).toEqual([migrations.length])
    expect(declaredCounts).toEqual([156])
    expect(requiredNames.has('0077_inventory_count_imports.sql')).toBe(true)
    expect(requiredNames.has('0078_shipping_calendars.sql')).toBe(true)
    expect(requiredNames.has('0079_support_escalations.sql')).toBe(true)
    expect(requiredNames.has('0080_communication_history_commands.sql')).toBe(true)
    expect(requiredNames.has('0081_promotional_analytics.sql')).toBe(true)
    expect(requiredNames.has('0086_admin_order_bulk.sql')).toBe(true)
    expect(requiredNames.has('0087_product_watch.sql')).toBe(true)
    expect(requiredNames.has('0088_product_contributions.sql')).toBe(true)
    expect(requiredNames.has('0089_sales_quotes.sql')).toBe(true)
    expect(requiredNames.has('0090_cart_recovery.sql')).toBe(true)
    expect(migrations.filter((name) => Number(name.slice(0, 4)) >= 55 && !requiredNames.has(name))).toEqual([])
    expect(source).toContain("analyticsBrowserAudit.scenarios, nativeBrowserMode === 'not-run' ? 0 : 2")
    expect(source).toContain("catalogExportAudit.scenarios, nativeBrowserMode === 'not-run' ? 6 : 10")
    expect(source.match(/browserMode: nativeBrowserMode/g)?.length).toBeGreaterThanOrEqual(2)
    expect(source).not.toMatch(/scenarios:\s*280\b/)
  })
  it('reports unrun browser acceptance as pending without inventing browser metrics', () => {
    expect(source).toContain("status: nativeBrowserMode === 'not-run' ? 'passed_browser_pending' : 'passed'")
    expect(source).toContain("status: nativeBrowserMode === 'not-run' ? 'pending' : 'passed'")
    expect(source).toContain("execution: nativeBrowserMode === 'not-run' ? 'not_run' : 'passed'")
    expect(source).toContain('scenarios: completed')
    expect(source).toContain('browser: analyticsBrowserAudit')
    expect(source).toContain('catalogExport: catalogExportAudit')
  })
  it('adds only a disposable actor warehouse assignment and imports after the existing export audit', () => {
    const exportCall = source.indexOf('const catalogExportAudit = await auditNativeCatalogExport(')
    const importerCall = source.indexOf('const nativeCatalogImportAudit = await auditNativeCatalogImport(')
    expect(importerCall).toBeGreaterThan(exportCall)
    expect(importerCall).toBeLessThan(
      source.indexOf("scenario = 'last_current_main_withdrawal_blocks_new_cart_and_quote_without_effects'")
    )
    expect(source.slice(exportCall, importerCall)).toContain(
      "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'warehouse',?)"
    )
    expect(source.slice(exportCall, importerCall)).toContain('.bind(administrator.identityId, now)')
    expect(source).toContain('completed += nativeCatalogImportAudit.scenarios')
    expect(source).not.toContain('chromium.launch(')
    expect(source).not.toContain('/usr/bin/google-chrome')
  })
})
