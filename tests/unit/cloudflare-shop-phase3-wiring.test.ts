import { readFileSync, readdirSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import * as ts from 'typescript'

// Static integration guard only: importing the runner would execute workerd.
// Native acceptance remains the separate root-owned audit:shop:local gate.
const runner = readFileSync(new URL('../../scripts/audit-cloudflare-shop.ts', import.meta.url), 'utf8')
const source = ts.createSourceFile('audit-cloudflare-shop.ts', runner, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}
function unwrap(node: ts.Node): ts.Node {
  return ts.isAwaitExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node
}
function variable(name: string) {
  let found: ts.Node | undefined
  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
      found = node.initializer
  })
  if (!found) throw new Error('Missing runner declaration: ' + name)
  return unwrap(found)
}
function object(node: ts.Node): ts.ObjectLiteralExpression {
  if (!ts.isObjectLiteralExpression(node)) throw new Error('Runner authority is not an explicit object')
  return node
}
function property(node: ts.Node, name: string): ts.Node {
  const found = object(node).properties.find(
    (member) =>
      (ts.isPropertyAssignment(member) || ts.isShorthandPropertyAssignment(member)) &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
      member.name.text === name
  )
  if (!found) throw new Error('Missing runner authority: ' + name)
  if (ts.isPropertyAssignment(found)) return unwrap(found.initializer)
  if (ts.isShorthandPropertyAssignment(found)) return found.name
  throw new Error('Unsupported authority declaration')
}
function literal(node: ts.Node) {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  throw new Error('Runner opt-in is not a literal')
}
function calls(name: string) {
  const found: ts.CallExpression[] = []
  walk(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found.push(node)
  })
  return found
}
function input(name: string) {
  const declaration = variable(name)
  if (!ts.isCallExpression(declaration) || !declaration.arguments[0])
    throw new Error('Runner helper must be directly awaited')
  return object(declaration.arguments[0])
}
function text(node: ts.Node) {
  return node.getText(source)
}

describe('native phase3 runner static wiring, not native execution evidence', () => {
  it('imports all three frozen helpers directly and never duplicates their engines', () => {
    const imports = new Map<string, string>()
    walk(source, (node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        for (const entry of bindings.elements) imports.set(entry.name.text, node.moduleSpecifier.text)
    })
    expect(imports.get('auditNativeRefundsCredit')).toBe('./lib/audit-native-refunds-credit')
    expect(imports.get('auditNativeSupport')).toBe('./lib/audit-native-support')
    expect(imports.get('auditNativeNewsletterEditorial')).toBe('./lib/audit-native-newsletter-editorial')
    expect(calls('auditNativeRefundsCredit')).toHaveLength(1)
    expect(calls('auditNativeSupport')).toHaveLength(1)
    expect(calls('auditNativeNewsletterEditorial')).toHaveLength(1)
  })
  it('requires and applies the complete current migration set without filtering previous migrations', () => {
    const migrationNames = readdirSync(new URL('../../db/d1/migrations/', import.meta.url))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort()
    expect(migrationNames.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: migrationNames.length }, (_, index) => index + 1)
    )
    for (const migration of [
      '0047_fiscal_runtime_email_manifest.sql',
      '0048_order_refunds_credit_notes.sql',
      '0049_support_operations.sql',
      '0050_newsletter_editorial.sql',
      '0051_newsletter_local_validation.sql',
      '0052_analytics_measurement.sql',
      '0053_catalog_editorial_import.sql',
      '0054_catalog_native_import.sql',
      '0055_catalog_import_jobs.sql',
      '0056_catalog_color_pattern.sql',
      '0057_catalog_import_job_commands.sql',
      '0058_catalog_typed_attributes.sql',
      '0059_catalog_typed_attribute_values.sql',
      '0060_support_macros.sql',
      '0061_search_synonyms.sql',
      '0062_support_knowledge_feedback.sql',
      '0063_order_annotations.sql',
      '0064_company_admin_review.sql',
      '0065_account_privacy.sql',
      '0066_account_preferences.sql',
      '0067_inventory_alerts.sql',
      '0068_support_satisfaction.sql',
      '0069_order_packing.sql',
      '0070_delivery_preferences.sql',
      '0071_account_security_notices.sql',
      '0072_promotions.sql',
      '0073_promotion_admin_commands.sql',
      '0074_order_purchase_reference.sql',
      '0075_cart_snapshots.sql',
      '0076_catalog_relations.sql',
      '0077_inventory_count_imports.sql',
      '0078_shipping_calendars.sql',
      '0079_support_escalations.sql',
      '0080_communication_history_commands.sql',
      '0081_promotional_analytics.sql',
      '0082_admin_invitations.sql',
      '0083_admin_bootstrap.sql',
      '0084_admin_audit.sql',
      '0085_admin_order_views.sql'
    ]) {
      expect(migrationNames).toContain(migration)
      expect(runner.includes("migrations.includes('" + migration + "')"), migration).toBe(true)
    }
    const declaredCounts: number[] = []
    walk(source, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'assert.equal' &&
        node.arguments[0]?.getText(source) === 'migrations.length' &&
        node.arguments[1] &&
        ts.isNumericLiteral(node.arguments[1])
      )
        declaredCounts.push(Number(node.arguments[1].text))
    })
    expect(declaredCounts).toEqual([migrationNames.length])
    expect(runner).toContain('for (const migration of migrations)')
  })
  it('preserves all previous native helper invocations and adds a separate paid checkout', () => {
    for (const [helper, count] of [
      ['auditNativeCmsDrafts', 1],
      ['auditNativeCmsPublication', 1],
      ['auditNativeFiscal', 1],
      ['auditNativeCheckoutPayment', 6],
      ['auditNativeFulfillment', 4],
      ['auditNativeReturns', 2],
      ['auditNativeFiscalRuntimeEmail', 2]
    ] as const)
      expect(calls(helper)).toHaveLength(count)
    expect(runner).toContain("scenario = 'live_d1_session_revocation'")
    expect(runner).toContain("scenario = 'last_current_main_withdrawal_blocks_new_cart_and_quote_without_effects'")
    expect(runner).toContain('const phase2Scenarios = completed - phase2Baseline')
    expect(runner).toContain('const phase3Scenarios = completed - phase3Baseline')
    expect(runner).toContain('capturedSyntheticMessages: phase2CapturedSyntheticMessages')
  })
  it('keeps feature namespaces OFF initially and enables local validation only in the disposable second phase', () => {
    const initial = property(variable('auditOptions'), 'bindings'),
      phase3 = property(variable('phase3Options'), 'bindings')
    for (const flag of [
      'SUPPORT_ENABLED',
      'SUPPORT_ATTACHMENTS_ENABLED',
      'REFUNDS_ENABLED',
      'REFUND_LOCAL_VALIDATION_ENABLED',
      'CREDIT_LOCAL_VALIDATION_ENABLED',
      'NEWSLETTER_EDITORIAL_ENABLED',
      'NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED',
      'NEWSLETTER_LOCAL_VALIDATION_ENABLED'
    ]) {
      expect(literal(property(initial, flag))).toBe('false')
      expect(literal(property(phase3, flag))).toBe('true')
    }
    for (const flag of [
      'REFUND_DISPATCH_ENABLED',
      'CREDIT_DISPATCH_ENABLED',
      'SUPPORT_TURNSTILE_ENABLED',
      'TRANSACTIONAL_EMAIL_ENABLED'
    ]) {
      expect(literal(property(initial, flag))).toBe('false')
      expect(literal(property(phase3, flag))).toBe('false')
    }
    for (const selection of ['REFUND_POLICY_IDS', 'CREDIT_POLICY_IDS', 'TRANSACTIONAL_EMAIL_RENDERER_KEYS'])
      expect(literal(property(phase3, selection))).toBe('[]')
    expect(literal(property(initial, 'BEPLY_ENABLED'))).toBe('false')
    expect(literal(property(initial, 'FISCAL_ISSUANCE_ENABLED'))).toBe('false')
    expect(literal(property(initial, 'NEWSLETTER_ENABLED'))).toBe('false')
  })
  it('reacquires native bindings and compares durable evidence after Miniflare reload', () => {
    const reload = runner.indexOf('await runtime.setOptions('),
      refresh = runner.indexOf('localBindings = await runtime.getBindings', reload)
    expect(reload).toBeGreaterThan(0)
    expect(refresh).toBeGreaterThan(reload)
    expect(runner.indexOf('database = localBindings.DB', refresh)).toBeGreaterThan(refresh)
    expect(runner.indexOf('assert.equal(await persistentEvidence(), beforeRuntimeReload)', refresh)).toBeGreaterThan(
      refresh
    )
    expect(text(property(variable('phase3Options'), 'bindings'))).toContain('...auditOptions.bindings')
    expect(runner).not.toMatch(/DELETE FROM (?:orders|payment_intents|inventory_movements|order_returns)/i)
  })
  it('ties the financial order to authenticated HTTP checkout and genuine fulfillment/return evidence', () => {
    const checkout = input('financialCheckoutAudit'),
      preparation = input('financialPreparationAudit'),
      returns = input('financialReturnsAudit'),
      financial = input('financialAudit')
    expect(text(property(checkout, 'ownerCookie'))).toBe('financialCustomer.cookie')
    expect(literal(property(checkout, 'quantity'))).toBe('2')
    expect(literal(property(checkout, 'shippingMethod'))).toBe('pickup')
    expect(text(property(returns, 'customerCookie'))).toBe('financialCustomer.cookie')
    expect(text(property(financial, 'customerCookie'))).toBe('financialCustomer.cookie')
    expect(text(property(preparation, 'orderId'))).toBe('financialCheckoutAudit.orderId')
    expect(text(property(returns, 'orderId'))).toBe('financialCheckoutAudit.orderId')
    expect(text(property(financial, 'orderId'))).toBe('financialCheckoutAudit.orderId')
    expect(text(property(financial, 'returnPublicRef'))).toBe('financialReturnsAudit.returnPublicRef')
    expect(text(property(financial, 'returnVersion'))).toBe('financialReturnsAudit.version')
    expect(runner).not.toMatch(
      /UPDATE\s+(?:orders|order_payment_states)\s+SET\s+(?:[^;\n]*\bstatus\s*=\s*['"]paid|customer_id\s*=)/i
    )
  })
  it('requires the completed ordinary invoice and derives financial mappings from real captured contracts', () => {
    expect(variable('financialSourceFiscalAudit').pos).toBeLessThan(variable('financialAudit').pos)
    expect(runner).toContain("assert.equal(originalFiscal.fiscal_status, 'issued')")
    expect(runner).toContain("assert.equal(originalFiscal.status, 'completed')")
    expect(runner).toContain('localBindings.MEDIA.head(originalFiscal.storage_key)')
    expect(runner).toContain('mappings: capture.capture.mappings')
    expect(runner).toContain('mappings: originalPolicy.mappings')
    expect(runner).toContain('configuredRefundProvider(phase3Environment, policy, denyExternalFetch)')
    expect(runner).toContain('configuredCreditProvider(phase3Environment, policy, denyExternalFetch)')
  })
  it('dispatches all three helper HTTP surfaces through the actual Worker, never host-faked responses', () => {
    for (const name of ['financialAudit', 'supportAudit', 'newsletterAudit'])
      expect(text(property(input(name), 'dispatch'))).toBe('nativeDispatch')
    expect(text(variable('nativeDispatch'))).toContain('runtime!.dispatchFetch(')
    expect(text(variable('nativeDispatch'))).toContain('await request.arrayBuffer()')
    expect(runner.indexOf('const newsletterAudit =')).toBeLessThan(
      runner.indexOf("scenario = 'live_d1_session_revocation'")
    )
  })
  it('uses a dedicated signed scanner audience and private R2 rather than catalog approval', () => {
    expect(text(variable('supportScanSecret'))).toContain('randomBytes(48)')
    expect(text(property(property(variable('phase3Options'), 'bindings'), 'SUPPORT_SCAN_SECRET'))).toBe(
      'supportScanSecret'
    )
    expect(runner).toContain("scope: 'support_attachment'")
    expect(runner).toContain('.update(SUPPORT_SCAN_AUDIENCE + rawBody)')
    expect(runner).toContain('await nativeDispatch(receiptRequest(mediaScanSecret))')
    expect(runner).toContain('return nativeDispatch(receiptRequest(supportScanSecret))')
    expect(runner).toContain('assert.equal(supportAudit.attachmentsExercised, true)')
  })
  it('feeds exact ephemeral marketing secrets to HTTP configuration and signed feedback', () => {
    const bindings = property(variable('phase3Options'), 'bindings'),
      newsletter = input('newsletterAudit')
    expect(text(variable('newsletterHmacKey'))).toBe('randomBytes(32)')
    expect(text(property(bindings, 'NEWSLETTER_HMAC_KEY'))).toBe("newsletterHmacKey.toString('base64url')")
    expect(text(property(newsletter, 'newsletterSecrets'))).toBe('{ hmacKey: new Uint8Array(newsletterHmacKey) }')
    expect(text(property(newsletter, 'feedbackSecret'))).toBe('new TextEncoder().encode(newsletterFeedbackSecret)')
    expect(runner).toContain('assert.equal(newsletterAudit.scenarios, 8)')
    expect(runner).toContain('FROM newsletter_editorial_fake_receipts r ')
    expect(runner).toContain('assert.equal(newsletterLocalReceipts.results.length, 1)')
    expect(runner).toContain("assert.equal(receipt.provider, 'local-fake')")
    expect(runner).toContain('assert.equal(receipt.delivery_message_id, receipt.provider_message_id)')
  })
  it('uses genuine publisher/consumer/registered rendering and confines senders to synthetic local recipients', () => {
    const transport = source.statements.flatMap((statement) => {
      const found: ts.FunctionDeclaration[] = []
      walk(statement, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'deliverEmailTransport') found.push(node)
      })
      return found
    })[0]
    expect(transport).toBeDefined()
    expect(text(transport!)).toContain('publishEmailOutbox(')
    expect(text(transport!)).toContain('receiveEmailDispatch(database, message, serverNow())')
    expect(text(variable('runPhase3Emails'))).toContain('renderers: customerEmailRenderers')
    expect(runner).toContain('Only disposable synthetic recipients are allowed')
    expect(runner).toContain('assert.equal(deliveredSupport.sent, 3)')
    expect(runner).not.toMatch(
      /INSERT INTO (?:email_dispatch_inbox|transactional_email_preparations|refund_receipts|fiscal_credit_receipts)/i
    )
  })
  it('retains the actual outbound denial and explicitly refuses cron, queue and external acceptance claims', () => {
    expect(runner).toContain('assert.equal(outgoingRequests, 0)')
    expect(text(variable('denyExternalFetch'))).toContain('outgoingRequests++')
    expect(text(variable('denyExternalFetch'))).toContain('throw new Error(')
    expect(runner.match(/scheduledEntrypointExercised: false/g)).toHaveLength(2)
    expect(runner.match(/queueEntrypointExercised: false/g)).toHaveLength(2)
    expect(runner).toContain('externalFinancialProviderAcceptance: false')
    expect(runner).toContain('externalEmailAcceptance: false')
    expect(runner).toContain('const actual = error instanceof assert.AssertionError')
    expect(runner).not.toContain('console.log(phase3SentMessages)')
  })
})
