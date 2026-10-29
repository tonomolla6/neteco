import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  inventoryFunctionalDeliveryTestSelectors,
  resolveFunctionalDeliverySelection
} from '../../scripts/lib/functional-delivery-runner'
import {
  buildFunctionalDeliveryPlan,
  FUNCTIONAL_DELIVERY_PLAN,
  FUNCTIONAL_REQUIREMENT_STATUSES,
  validateFunctionalDeliveryPlan,
  type FunctionalDeliveryPlanSnapshot,
  type FunctionalRequirementRow
} from '../../shared/functional-delivery-plan'

function parseCsv(source: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        cell += character
      }
      continue
    }

    if (character === '"') quoted = true
    else if (character === ',') {
      row.push(cell)
      cell = ''
    } else if (character === '\n') {
      row.push(cell.replace(/\r$/, ''))
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ''))
    rows.push(row)
  }

  return rows
}

function loadRequirements(): FunctionalRequirementRow[] {
  const source = readFileSync(resolve(process.cwd(), 'docs/production/requirements-traceability.csv'), 'utf8')
  const [header, ...records] = parseCsv(source)
  if (!header) throw new Error('Requirement traceability CSV has no header')

  const indexes = new Map(header.map((name, index) => [name, index]))
  const field = (record: string[], name: string) => {
    const index = indexes.get(name)
    if (index === undefined) throw new Error(`Requirement traceability CSV is missing ${name}`)
    return record[index] ?? ''
  }

  return records
    .filter((record) => record.some((value) => value.length > 0))
    .map((record) => ({
      id: field(record, 'id'),
      phase_min: field(record, 'phase_min'),
      domain: field(record, 'domain'),
      priority: field(record, 'priority'),
      status: field(record, 'status'),
      requirement: field(record, 'requirement'),
      acceptance: field(record, 'acceptance')
    }))
}

function copyPlan(
  plan: FunctionalDeliveryPlanSnapshot,
  mutate: (copy: FunctionalDeliveryPlanSnapshot) => FunctionalDeliveryPlanSnapshot
): FunctionalDeliveryPlanSnapshot {
  return mutate({
    ...plan,
    modules: plan.modules.map((module) => ({
      ...module,
      ownership: [...module.ownership],
      dependsOn: [...module.dependsOn],
      dependsOnContracts: [...module.dependsOnContracts],
      testSelectors: [...module.testSelectors],
      riskCategories: [...module.riskCategories],
      requirementIds: [...module.requirementIds],
      requirements: [...module.requirements],
      counts: {
        ...module.counts,
        byStatus: { ...module.counts.byStatus },
        byPriority: { ...module.counts.byPriority },
        byPhase: { ...module.counts.byPhase }
      }
    }))
  })
}

describe('functional delivery plan', () => {
  const rows = loadRequirements()

  it('groups every active requirement exactly once and keeps discarded history explicitly excluded', () => {
    const plan = buildFunctionalDeliveryPlan(rows)
    const activeIds = rows.filter((row) => row.status !== 'DISCARDED').map((row) => row.id)
    const plannedIds = plan.modules.flatMap((module) => module.requirementIds)
    const discardedRows = rows.filter((row) => row.status === 'DISCARDED')

    expect(plan.modules).toHaveLength(15)
    expect(rows).toHaveLength(702)
    expect(activeIds).toHaveLength(695)
    expect(discardedRows).toHaveLength(7)
    expect(plannedIds).toHaveLength(activeIds.length)
    expect(new Set(plannedIds).size).toBe(plannedIds.length)
    expect([...plannedIds].sort()).toEqual([...activeIds].sort())
    expect([...plan.excludedRequirements].sort((left, right) => left.id.localeCompare(right.id))).toEqual(
      [...discardedRows].sort((left, right) => left.id.localeCompare(right.id))
    )
    expect([...FUNCTIONAL_DELIVERY_PLAN.excludedRequirementIds].sort()).toEqual(
      discardedRows.map((row) => row.id).sort()
    )
    expect(validateFunctionalDeliveryPlan(plan, rows)).toEqual([])
  })

  it('derives each module and plan status/priority/phase counts from the supplied CSV rows', () => {
    const plan = buildFunctionalDeliveryPlan(rows)
    const sourceById = new Map(rows.map((row) => [row.id, row]))
    const count = (items: readonly FunctionalRequirementRow[], key: keyof FunctionalRequirementRow) =>
      items.reduce<Record<string, number>>((result, item) => {
        const value = item[key]
        result[value] = (result[value] ?? 0) + 1
        return result
      }, {})

    expect(plan.totals.historicalRequirementCount).toBe(rows.length)
    expect(plan.totals.activeRequirementCount).toBe(rows.filter((row) => row.status !== 'DISCARDED').length)
    expect(plan.totals.discardedRequirementCount).toBe(rows.filter((row) => row.status === 'DISCARDED').length)
    expect(plan.totals.byStatus).toEqual(count(rows, 'status'))
    expect(plan.totals.byPriority).toEqual(count(rows, 'priority'))
    expect(plan.totals.byPhase).toEqual(count(rows, 'phase_min'))
    expect(plan.totals.byStatus).toEqual(count(rows, 'status'))

    for (const module of plan.modules) {
      expect(module.counts.total).toBe(module.requirements.length)
      expect(module.counts.byStatus).toEqual(count(module.requirements, 'status'))
      expect(module.counts.byPriority).toEqual(count(module.requirements, 'priority'))
      expect(module.counts.byPhase).toEqual(count(module.requirements, 'phase_min'))
      for (const requirement of module.requirements) {
        expect(requirement).toEqual(sourceById.get(requirement.id))
      }
    }

    for (const row of rows.filter((item) => item.status !== 'DISCARDED')) {
      expect(row.requirement.trim()).not.toBe('')
      expect(row.acceptance.trim()).not.toBe('')
      expect(row.priority.trim()).not.toBe('')
      expect(row.phase_min.trim()).not.toBe('')
      expect(FUNCTIONAL_REQUIREMENT_STATUSES).toContain(row.status)
    }
  })

  it('defines three parallel implementation fronts, test-first execution, and root-owned integration', () => {
    expect(FUNCTIONAL_DELIVERY_PLAN.fronts).toHaveLength(3)
    expect(new Set(FUNCTIONAL_DELIVERY_PLAN.modules.map((module) => module.frontId))).toEqual(
      new Set(FUNCTIONAL_DELIVERY_PLAN.fronts.map((front) => front.id))
    )
    expect(FUNCTIONAL_DELIVERY_PLAN.execution).toEqual([
      'prepare-tests',
      'implement-fronts',
      'root-integration',
      'joint-tests'
    ])
    expect(FUNCTIONAL_DELIVERY_PLAN.rootIntegration.owner).toBe('root')
    expect(FUNCTIONAL_DELIVERY_PLAN.validationBoundary).toBe('local-only')
    expect(FUNCTIONAL_DELIVERY_PLAN.dependencySemantics).toBe('entry-contracts-only')
    const catalog = FUNCTIONAL_DELIVERY_PLAN.modules.find((module) => module.id === 'catalog-content')
    expect(catalog?.dependsOnContracts).toEqual(expect.arrayContaining(['base-d1', 'identity-authorization']))
    expect(FUNCTIONAL_DELIVERY_PLAN.modules.map((module) => module.id)).toContain('marketing-communications')
    expect(FUNCTIONAL_DELIVERY_PLAN.modules.map((module) => module.id)).toContain('support-crm')
  })

  it('references focused tests that exist and can be checked without filesystem access in shared code', () => {
    const plan = buildFunctionalDeliveryPlan(rows)
    const selectors = plan.modules.flatMap((module) => module.testSelectors)

    expect(selectors.length).toBeGreaterThan(0)
    expect(
      selectors.every((selector) => selector.startsWith('tests/unit/') || selector.startsWith('tests/components/'))
    ).toBe(true)
    expect(
      validateFunctionalDeliveryPlan(plan, rows, {
        selectorExists: (selector) => existsSync(resolve(process.cwd(), selector))
      })
    ).toEqual([])
    expect(validateFunctionalDeliveryPlan(plan, rows, { selectorExists: () => false })).toEqual(
      expect.arrayContaining([expect.stringContaining('test selector')])
    )
  })

  it.each([
    [
      'discovery-experience',
      /\/d1-search-synonyms(?:-http)?\.test\.ts$|\/search-synonyms\.test\.ts$|\/d1-products-search-native\.test\.ts$/
    ],
    [
      'admin-publishing',
      /\/d1-search-synonyms(?:-http)?\.test\.ts$|\/search-synonyms\.test\.ts$|\/d1-admin-capabilities\.test\.ts$|\/admin-(?:navigation|command-palette)\.test\.ts$/
    ],
    ['security-compliance', /\/d1-admin-capabilities\.test\.ts$/],
    [
      'quality-delivery',
      /\/(?:vitest-node-config|requirements-inventory-consistency|d1-admin-entrypoints|d1-fixture-loading|flake-monitor)\.test\.ts$/
    ],
    ['support-crm', /\/(?:d1-support-knowledge(?:-http|-schema|-native)?|support-knowledge)\.test\.ts$/]
  ] as const)('selects the current complete browser/admin regression inventory for %s', async (moduleId, pattern) => {
    const inventory = await inventoryFunctionalDeliveryTestSelectors(process.cwd())
    const required = [...inventory].filter((selector) => pattern.test(selector))
    expect(required.length).toBeGreaterThan(0)
    const selection = resolveFunctionalDeliverySelection(buildFunctionalDeliveryPlan(rows), [moduleId], (selector) =>
      inventory.has(selector)
    )
    expect(required.filter((selector) => !selection.testSelectors.includes(selector))).toEqual([])
  })

  it('selects the real typed catalogue and discovery test inventory without dropping suites or duplicating them', async () => {
    const inventory = await inventoryFunctionalDeliveryTestSelectors(process.cwd())
    const typed = [...inventory].filter((selector) =>
      /(?:typed|category-attribute-definitions-editor).*\.test\.ts$/.test(selector)
    )
    const tabular = [...inventory].filter((selector) => /\/catalog-tabular(?:-[a-z-]+)?\.test\.ts$/.test(selector))
    const publicTyped = typed.filter((selector) => /(?:filters|facets|detail|public-catalog-pages)/.test(selector))
    // Nonempty inventory assertions keep a renamed/missing test directory from
    // turning the coverage checks into vacuous success.
    expect(typed.length).toBeGreaterThan(10)
    expect(tabular.length).toBeGreaterThanOrEqual(3)
    expect(publicTyped.length).toBeGreaterThanOrEqual(6)
    const plan = buildFunctionalDeliveryPlan(rows)
    const select = (modules: string[]) =>
      resolveFunctionalDeliverySelection(plan, modules, (selector) => inventory.has(selector))
    const catalog = select(['catalog-content']),
      discovery = select(['discovery-experience'])
    expect([...typed, ...tabular].filter((selector) => !catalog.testSelectors.includes(selector))).toEqual([])
    expect(publicTyped.filter((selector) => !discovery.testSelectors.includes(selector))).toEqual([])
    const joint = select(['catalog-content', 'discovery-experience'])
    for (const selector of [...typed, ...tabular])
      expect(joint.testSelectors.filter((selected) => selected === selector)).toHaveLength(1)
    for (const module of [...catalog.modules, ...discovery.modules])
      expect(new Set(module.testSelectors).size).toBe(module.testSelectors.length)
  })

  it.each([
    'neteco-oracle-job-hook',
    'neteco-oracle-isolation-probe',
    'neteco-oracle-network-probe',
    'neteco-oracle-network-bootstrap',
    'neteco-oracle-egress-seccomp',
    'neteco-oracle-capability-probe',
    'neteco-oracle-image-stage',
    'neteco-oracle-build-storage',
    'neteco-oracle-docker'
  ])('includes the real %s regression in the quality module and global gate exactly once', async (name) => {
    const inventory = await inventoryFunctionalDeliveryTestSelectors(process.cwd())
    const network = [...inventory].filter((item) =>
      /^tests\/unit\/neteco-oracle-network-(?:probe|bootstrap)\.test\.ts$/.test(item)
    )
    expect(network.length).toBeGreaterThan(1)
    expect(network.sort()).toEqual([
      'tests/unit/neteco-oracle-network-bootstrap.test.ts',
      'tests/unit/neteco-oracle-network-probe.test.ts'
    ])
    const selector = `tests/unit/${name}.test.ts`
    expect(inventory.has(selector)).toBe(true)
    const plan = buildFunctionalDeliveryPlan(rows)
    const quality = resolveFunctionalDeliverySelection(plan, ['quality-delivery'], (item) => inventory.has(item))
    const global = resolveFunctionalDeliverySelection(plan, [], (item) => inventory.has(item))
    expect(quality.testSelectors.filter((item) => item === selector)).toEqual([selector])
    expect(global.testSelectors.filter((item) => item === selector)).toEqual([selector])
  })

  it.each([
    ['checkout-command-recovery', ['commerce-transactions']],
    ['order-payment-recovery', ['commerce-transactions', 'payments-fiscal']]
  ] as const)('includes real %s page recovery tests in their modules and the global gate', async (name, modules) => {
    const inventory = await inventoryFunctionalDeliveryTestSelectors(process.cwd())
    const selector = `tests/components/${name}.test.ts`
    expect(inventory.has(selector)).toBe(true)
    const plan = buildFunctionalDeliveryPlan(rows)
    for (const module of modules) {
      const selected = resolveFunctionalDeliverySelection(plan, [module], (item) => inventory.has(item))
      expect(selected.testSelectors.filter((item) => item === selector)).toEqual([selector])
    }
    const global = resolveFunctionalDeliverySelection(plan, [], (item) => inventory.has(item))
    expect(global.testSelectors.filter((item) => item === selector)).toEqual([selector])
  })

  it.each([
    ['tests/unit/d1-admin-order-bulk.test.ts', ['admin-publishing', 'fulfillment-logistics']],
    ['tests/unit/d1-admin-order-bulk-http.test.ts', ['admin-publishing', 'fulfillment-logistics']],
    ['tests/unit/d1-admin-order-bulk-runtime.test.ts', ['admin-publishing', 'fulfillment-logistics']],
    ['tests/unit/d1-admin-order-bulk-native.test.ts', ['admin-publishing', 'fulfillment-logistics']],
    ['tests/unit/d1-admin-order-bulk-ingress.test.ts', ['admin-publishing', 'fulfillment-logistics']],
    ['tests/unit/d1-admin-order-cursor.test.ts', ['admin-publishing', 'fulfillment-logistics']],
    ['tests/components/admin-order-batch-preparation.test.ts', ['admin-publishing', 'fulfillment-logistics']],
    ['tests/unit/d1-catalog-relations.test.ts', ['catalog-content', 'security-compliance']],
    ['tests/unit/d1-catalog-relations-http.test.ts', ['catalog-content', 'security-compliance']],
    ['tests/unit/d1-catalog-relations-native.test.ts', ['catalog-content', 'security-compliance']],
    ['tests/components/product-relations-editor.test.ts', ['catalog-content', 'admin-publishing']],
    [
      'tests/components/published-product-relations.test.ts',
      ['catalog-content', 'commerce-transactions', 'support-crm']
    ],
    [
      'tests/unit/cart-snapshots-browser.test.ts',
      ['commerce-transactions', 'customer-accounts', 'security-compliance']
    ],
    ['tests/unit/d1-cart-snapshots.test.ts', ['commerce-transactions', 'customer-accounts', 'security-compliance']],
    [
      'tests/unit/d1-cart-snapshots-http.test.ts',
      ['commerce-transactions', 'customer-accounts', 'security-compliance']
    ],
    [
      'tests/unit/d1-cart-snapshots-native.test.ts',
      ['commerce-transactions', 'customer-accounts', 'security-compliance']
    ],
    [
      'tests/components/cart-snapshots-panel.test.ts',
      ['commerce-transactions', 'customer-accounts', 'security-compliance']
    ],
    ['tests/components/cart-shared.test.ts', ['commerce-transactions', 'customer-accounts', 'security-compliance']],
    ['tests/unit/d1-promotion-basket-preview.test.ts', ['pricing-rules', 'admin-publishing', 'security-compliance']],
    [
      'tests/unit/d1-promotion-basket-preview-http.test.ts',
      ['pricing-rules', 'admin-publishing', 'security-compliance']
    ],
    ['tests/components/promotion-basket-simulator.test.ts', ['pricing-rules', 'admin-publishing']],
    ['tests/unit/d1-order-purchase-reference.test.ts', ['commerce-transactions', 'security-compliance']],
    [
      'tests/unit/d1-order-purchase-reference-readers.test.ts',
      ['commerce-transactions', 'fulfillment-logistics', 'admin-publishing', 'security-compliance']
    ],
    ['tests/components/checkout-purchase-reference.test.ts', ['commerce-transactions']],
    [
      'tests/components/order-purchase-reference.test.ts',
      ['commerce-transactions', 'customer-accounts', 'admin-publishing']
    ],
    ['tests/unit/promotions.test.ts', ['pricing-rules']],
    ['tests/unit/native-promotions-browser.test.ts', ['pricing-rules', 'commerce-transactions', 'admin-publishing']],
    ['tests/unit/d1-promotions.test.ts', ['pricing-rules']],
    ['tests/unit/d1-promotion-schema.test.ts', ['pricing-rules']],
    ['tests/unit/d1-admin-promotions.test.ts', ['pricing-rules', 'admin-publishing']],
    ['tests/unit/d1-admin-promotions-http.test.ts', ['pricing-rules', 'admin-publishing']],
    ['tests/unit/d1-promotions-native.test.ts', ['pricing-rules', 'commerce-transactions']],
    ['tests/unit/d1-coupon-checkout.test.ts', ['pricing-rules', 'commerce-transactions']],
    ['tests/unit/d1-coupon-http.test.ts', ['commerce-transactions']],
    ['tests/unit/d1-checkout-replay-authority.test.ts', ['commerce-transactions', 'security-compliance']],
    ['tests/unit/fiscal-coupon-contract.test.ts', ['payments-fiscal']],
    ['tests/unit/d1-coupon-refunds.test.ts', ['payments-fiscal']],
    ['tests/unit/d1-order-coupon-breakdown.test.ts', ['commerce-transactions', 'customer-accounts']],
    ['tests/components/checkout-coupons.test.ts', ['commerce-transactions']],
    ['tests/components/admin-promotions.test.ts', ['pricing-rules', 'admin-publishing']],
    ['tests/components/order-coupon-breakdown.test.ts', ['commerce-transactions', 'customer-accounts']],
    [
      'tests/unit/d1-guest-order-email.test.ts',
      ['commerce-transactions', 'marketing-communications', 'security-compliance']
    ],
    ['tests/unit/d1-guest-order-email-scheduled.test.ts', ['integrations-apis', 'marketing-communications']],
    ['tests/components/catalog-support-context.test.ts', ['discovery-experience', 'support-crm']],
    [
      'tests/unit/native-guest-order-browser.test.ts',
      ['commerce-transactions', 'customer-accounts', 'security-compliance']
    ],
    ['tests/unit/d1-guest-order-access.test.ts', ['commerce-transactions', 'customer-accounts', 'security-compliance']],
    [
      'tests/unit/d1-guest-order-access-entrypoints.test.ts',
      ['commerce-transactions', 'customer-accounts', 'security-compliance']
    ],
    ['tests/unit/order-detail-headline.test.ts', ['commerce-transactions', 'customer-accounts']],
    [
      'tests/unit/native-quick-order-browser.test.ts',
      ['discovery-experience', 'customer-accounts', 'commerce-transactions']
    ],
    ['tests/unit/cloudflare-shop-phase3-wiring.test.ts', ['integrations-apis', 'quality-delivery']],
    ['tests/unit/d1-migrations-upgrade.test.ts', ['quality-delivery']],
    ['tests/unit/quick-order.test.ts', ['discovery-experience', 'customer-accounts', 'commerce-transactions']],
    ['tests/unit/quick-order-native.test.ts', ['discovery-experience', 'customer-accounts', 'commerce-transactions']],
    ['tests/components/quick-order.test.ts', ['discovery-experience', 'customer-accounts', 'commerce-transactions']],
    ['tests/components/admin-navigation.test.ts', ['discovery-experience']],
    [
      'tests/unit/native-account-settings-browser.test.ts',
      ['customer-accounts', 'marketing-communications', 'fulfillment-logistics']
    ],
    [
      'tests/unit/d1-scheduled-outbox-isolation.test.ts',
      ['integrations-apis', 'performance-observability', 'quality-delivery']
    ],
    ['tests/components/cart-add-recovery.test.ts', ['commerce-transactions']],
    ['tests/unit/d1-order-timeline.test.ts', ['commerce-transactions', 'fulfillment-logistics']],
    ['tests/unit/d1-order-timeline-adversarial.test.ts', ['commerce-transactions', 'customer-accounts']],
    ['tests/unit/d1-order-timeline-http.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/unit/d1-order-timeline-native.test.ts', ['commerce-transactions', 'fulfillment-logistics']],
    ['tests/unit/d1-order-timeline-entrypoints.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/unit/audit-native-order-timeline.test.ts', ['commerce-transactions', 'fulfillment-logistics']],
    ['tests/components/order-timeline-panel.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/components/order-timeline-mounting.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/unit/d1-order-cancellation.test.ts', ['commerce-transactions', 'fulfillment-logistics']],
    ['tests/unit/d1-order-cancellation-native.test.ts', ['commerce-transactions', 'fulfillment-logistics']],
    ['tests/unit/d1-order-cancellation-http.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/unit/d1-order-cancellation-entrypoints.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/unit/audit-native-order-cancellation.test.ts', ['commerce-transactions']],
    ['tests/components/order-cancellation-panel.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/components/order-cancellation-mounting.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/components/admin-order-workbench.test.ts', ['admin-publishing', 'fulfillment-logistics']],
    ['tests/unit/d1-order-export.test.ts', ['commerce-transactions', 'admin-publishing']],
    ['tests/unit/d1-order-export-http.test.ts', ['admin-publishing']],
    ['tests/unit/d1-order-export-native.test.ts', ['commerce-transactions', 'admin-publishing']],
    ['tests/unit/d1-order-export-entrypoints.test.ts', ['admin-publishing']],
    ['tests/unit/audit-native-order-export.test.ts', ['commerce-transactions', 'admin-publishing']],
    ['tests/components/admin-order-export.test.ts', ['admin-publishing']],
    ['tests/unit/audit-native-order-operations-browser.test.ts', ['commerce-transactions', 'admin-publishing']],
    ['tests/unit/d1-order-annotations.test.ts', ['commerce-transactions', 'admin-publishing']],
    ['tests/unit/d1-order-operations-email.test.ts', ['commerce-transactions', 'marketing-communications']],
    ['tests/unit/d1-order-return-email.test.ts', ['commerce-transactions', 'marketing-communications']],
    ['tests/components/account-address-book.test.ts', ['customer-accounts']],
    ['tests/components/account-profile.test.ts', ['customer-accounts']],
    ['tests/unit/customer-tax-validation.test.ts', ['customer-accounts']],
    ['tests/components/account-overview.test.ts', ['customer-accounts']],
    ['tests/components/account-favorites-mutations.test.ts', ['customer-accounts']],
    ['tests/unit/native-company-review-browser.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/unit/d1-account-privacy.test.ts', ['customer-accounts']],
    ['tests/unit/d1-account-privacy-http.test.ts', ['customer-accounts']],
    ['tests/unit/d1-account-privacy-native.test.ts', ['customer-accounts']],
    ['tests/unit/d1-account-preferences.test.ts', ['customer-accounts', 'marketing-communications']],
    ['tests/unit/d1-account-preferences-http.test.ts', ['customer-accounts', 'marketing-communications']],
    ['tests/unit/d1-account-preferences-native.test.ts', ['customer-accounts', 'marketing-communications']],
    ['tests/unit/d1-delivery-preferences.test.ts', ['customer-accounts', 'fulfillment-logistics']],
    ['tests/unit/d1-delivery-preferences-http.test.ts', ['customer-accounts', 'fulfillment-logistics']],
    ['tests/unit/d1-delivery-preferences-native.test.ts', ['customer-accounts', 'fulfillment-logistics']],
    ['tests/unit/d1-delivery-notice-preferences.test.ts', ['fulfillment-logistics', 'marketing-communications']],
    [
      'tests/unit/d1-identity-security-notice.test.ts',
      ['customer-accounts', 'marketing-communications', 'security-compliance']
    ],
    [
      'tests/unit/d1-account-security-schema.test.ts',
      ['customer-accounts', 'marketing-communications', 'security-compliance']
    ],
    [
      'tests/unit/d1-account-security-native.test.ts',
      ['customer-accounts', 'marketing-communications', 'security-compliance']
    ],
    [
      'tests/unit/d1-account-security-notices.test.ts',
      ['customer-accounts', 'marketing-communications', 'security-compliance']
    ],
    [
      'tests/unit/d1-email-change-security-notices.test.ts',
      ['customer-accounts', 'marketing-communications', 'security-compliance']
    ],
    [
      'tests/unit/d1-company-security-notices.test.ts',
      ['customer-accounts', 'marketing-communications', 'security-compliance']
    ],
    [
      'tests/unit/d1-identity-security-native.test.ts',
      ['customer-accounts', 'marketing-communications', 'security-compliance']
    ],
    ['tests/components/delivery-preferences-panel.test.ts', ['customer-accounts', 'fulfillment-logistics']],
    ['tests/components/delivery-preferences-mounting.test.ts', ['customer-accounts', 'fulfillment-logistics']],
    ['tests/unit/d1-account-settings-entrypoints.test.ts', ['customer-accounts']],
    ['tests/components/account-privacy-panel.test.ts', ['customer-accounts']],
    ['tests/components/account-preferences.test.ts', ['customer-accounts', 'marketing-communications']],
    [
      'tests/components/account-settings-mounting.test.ts',
      ['customer-accounts', 'marketing-communications', 'fulfillment-logistics']
    ],
    ['tests/unit/d1-admin-companies.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/unit/d1-admin-companies-http.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/unit/d1-admin-companies-native.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/unit/d1-admin-companies-entrypoints.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/components/admin-companies.test.ts', ['customer-accounts', 'admin-publishing']],
    ['tests/components/order-return-authority-boundaries.test.ts', ['commerce-transactions']],
    ['tests/unit/native-order-returns-browser.test.ts', ['commerce-transactions']],
    ['tests/components/account-communications-newsletter.test.ts', ['marketing-communications']],
    ['tests/components/account-security.test.ts', ['customer-accounts', 'security-compliance']],
    ['tests/components/admin-inventory-boundaries.test.ts', ['fulfillment-logistics', 'admin-publishing']],
    ['tests/components/inventory-receipt-integrity.test.ts', ['fulfillment-logistics']],
    ['tests/unit/d1-order-payment-email.test.ts', ['commerce-transactions', 'marketing-communications']],
    ['tests/unit/audit-native-order-emails.test.ts', ['commerce-transactions', 'marketing-communications']],
    ['tests/unit/d1-order-annotations-http.test.ts', ['admin-publishing']],
    ['tests/unit/d1-order-annotations-native.test.ts', ['commerce-transactions', 'admin-publishing']],
    ['tests/unit/d1-order-annotations-entrypoints.test.ts', ['admin-publishing']],
    ['tests/unit/audit-native-order-annotations.test.ts', ['commerce-transactions', 'admin-publishing']],
    ['tests/components/order-annotations-panel.test.ts', ['admin-publishing']],
    ['tests/unit/d1-cart-operations-native.test.ts', ['commerce-transactions']],
    ['tests/unit/d1-cart-entrypoints.test.ts', ['commerce-transactions']],
    ['tests/unit/audit-native-cart-add-recovery-browser.test.ts', ['commerce-transactions']],
    ['tests/unit/audit-native-checkout-recovery-browser.test.ts', ['commerce-transactions', 'payments-fiscal']],
    ['tests/unit/d1-support-macros.test.ts', ['support-crm']],
    ['tests/unit/d1-order-packing.test.ts', ['fulfillment-logistics']],
    ['tests/unit/d1-order-packing-http.test.ts', ['fulfillment-logistics']],
    ['tests/unit/d1-order-packing-native.test.ts', ['fulfillment-logistics']],
    ['tests/unit/audit-native-order-packing-browser.test.ts', ['fulfillment-logistics']],
    ['tests/components/order-packing-panel.test.ts', ['fulfillment-logistics']],
    ['tests/unit/d1-order-tracking.test.ts', ['fulfillment-logistics']],
    ['tests/unit/d1-order-tracking-http.test.ts', ['fulfillment-logistics']],
    ['tests/unit/d1-order-tracking-native.test.ts', ['fulfillment-logistics']],
    ['tests/unit/audit-native-order-tracking-browser.test.ts', ['fulfillment-logistics']],
    ['tests/components/order-tracking-panel.test.ts', ['fulfillment-logistics']],
    ['tests/components/order-tracking-mounting.test.ts', ['fulfillment-logistics']],
    ['tests/unit/d1-support-macros-schema.test.ts', ['support-crm']],
    ['tests/unit/audit-native-support-macros.test.ts', ['support-crm']],
    ['tests/unit/d1-support-macros-http.test.ts', ['support-crm']],
    ['tests/components/support-macros.test.ts', ['support-crm']],
    ['tests/unit/d1-support-satisfaction.test.ts', ['support-crm']],
    ['tests/unit/d1-support-satisfaction-schema.test.ts', ['support-crm']],
    ['tests/unit/d1-support-satisfaction-http.test.ts', ['support-crm']],
    ['tests/unit/d1-support-satisfaction-native.test.ts', ['support-crm']],
    ['tests/unit/d1-support-satisfaction-adversarial.test.ts', ['support-crm']],
    ['tests/unit/audit-native-satisfaction-browser.test.ts', ['support-crm']],
    ['tests/components/satisfaction-panels.test.ts', ['support-crm']],
    ['tests/components/support-satisfaction-mounting.test.ts', ['support-crm']],
    ['tests/components/delivery-satisfaction-mounting.test.ts', ['support-crm']],
    ['tests/components/reorder-read-state.test.ts', ['commerce-transactions', 'customer-accounts']],
    ['tests/unit/order-reorder-offer.test.ts', ['commerce-transactions', 'customer-accounts']],
    ['tests/components/account-order-row-read-state.test.ts', ['commerce-transactions', 'customer-accounts']],
    ['tests/components/admin-navigation-context.test.ts', ['admin-publishing']],
    ['tests/components/admin-recent-activity.test.ts', ['admin-publishing']],
    ['tests/components/admin-global-search.test.ts', ['admin-publishing']],
    ['tests/unit/d1-admin-global-search.test.ts', ['admin-publishing']],
    ['tests/unit/d1-admin-global-search-http.test.ts', ['admin-publishing']],
    ['tests/unit/d1-admin-global-search-native.test.ts', ['admin-publishing']],
    ['tests/unit/audit-native-admin-global-search.test.ts', ['admin-publishing']],
    ['tests/unit/d1-admin-activity.test.ts', ['admin-publishing']],
    ['tests/unit/d1-admin-activity-http.test.ts', ['admin-publishing']],
    ['tests/unit/d1-admin-activity-native.test.ts', ['admin-publishing']],
    [
      'tests/unit/d1-customer-orders-native.test.ts',
      ['fulfillment-logistics', 'commerce-transactions', 'customer-accounts']
    ]
  ] as const)('keeps the real %s acceptance selectable by module and the joint gate', async (selector, modules) => {
    const inventory = await inventoryFunctionalDeliveryTestSelectors(process.cwd())
    expect(inventory.has(selector)).toBe(true)
    const plan = buildFunctionalDeliveryPlan(rows)
    for (const module of modules) {
      const selected = resolveFunctionalDeliverySelection(plan, [module], (item) => inventory.has(item))
      expect(selected.testSelectors.filter((item) => item === selector)).toEqual([selector])
    }
    const joint = resolveFunctionalDeliverySelection(plan, [], (item) => inventory.has(item))
    expect(joint.testSelectors.filter((item) => item === selector)).toEqual([selector])
  })

  it('discovers both real fixed-facet suites in catalogue and discovery and deduplicates the joint/global gates', async () => {
    const inventory = await inventoryFunctionalDeliveryTestSelectors(process.cwd())
    const facets = [...inventory]
      .filter((selector) => /^tests\/unit\/d1-product-facets(?:-scale)?\.test\.ts$/.test(selector))
      .sort()
    expect(facets.length).toBeGreaterThan(1)
    expect(facets).toEqual(['tests/unit/d1-product-facets-scale.test.ts', 'tests/unit/d1-product-facets.test.ts'])
    const plan = buildFunctionalDeliveryPlan(rows)
    const select = (modules: string[]) =>
      resolveFunctionalDeliverySelection(plan, modules, (selector) => inventory.has(selector))
    for (const modules of [
      ['catalog-content'],
      ['discovery-experience'],
      ['catalog-content', 'discovery-experience'],
      []
    ]) {
      const selection = select(modules)
      for (const facet of facets)
        expect(selection.testSelectors.filter((selector) => selector === facet)).toEqual([facet])
      expect(new Set(selection.testSelectors).size).toBe(selection.testSelectors.length)
    }
    const global = select([])
    expect([...new Set(plan.modules.flatMap((module) => module.testSelectors))].sort()).toEqual(
      [...global.testSelectors].sort()
    )
  })

  it('reports unknown, duplicate, and missing active IDs', () => {
    const plan = buildFunctionalDeliveryPlan(rows)
    const duplicatedId = plan.modules[0]!.requirementIds[0]!
    const duplicatePlan = copyPlan(plan, (copy) => {
      copy.modules[1]!.requirementIds.push(duplicatedId)
      return copy
    })
    const unknownPlan = copyPlan(plan, (copy) => {
      copy.modules[0]!.requirementIds.push('ZZZ-999')
      return copy
    })
    const missingPlan = copyPlan(plan, (copy) => {
      copy.modules[0]!.requirementIds.shift()
      return copy
    })

    expect(validateFunctionalDeliveryPlan(duplicatePlan, rows).join('\n')).toMatch(/duplicat/i)
    expect(validateFunctionalDeliveryPlan(unknownPlan, rows).join('\n')).toMatch(/unknown/i)
    expect(validateFunctionalDeliveryPlan(missingPlan, rows).join('\n')).toMatch(/missing/i)
  })

  it('reports missing, self, and cyclic module dependencies', () => {
    const plan = buildFunctionalDeliveryPlan(rows)
    const missingDependencyPlan = copyPlan(plan, (copy) => {
      const module = copy.modules[0] as unknown as { dependsOn: string[] }
      module.dependsOn.push('not-a-module')
      return copy
    })
    const selfDependencyPlan = copyPlan(plan, (copy) => {
      const module = copy.modules[0] as unknown as { id: string; dependsOn: string[] }
      module.dependsOn.push(module.id)
      return copy
    })
    const cyclePlan = copyPlan(plan, (copy) => {
      const first = copy.modules[0] as unknown as { id: string; dependsOn: string[] }
      const second = copy.modules[1] as unknown as { id: string; dependsOn: string[] }
      first.dependsOn.push(second.id)
      second.dependsOn.push(first.id)
      return copy
    })

    expect(validateFunctionalDeliveryPlan(missingDependencyPlan, rows).join('\n')).toMatch(/missing dependency/i)
    expect(validateFunctionalDeliveryPlan(selfDependencyPlan, rows).join('\n')).toMatch(/self-dependency/i)
    expect(validateFunctionalDeliveryPlan(cyclePlan, rows).join('\n')).toMatch(/cycle/i)
  })

  it('checks shared-contract references and prevents phase/priority/criteria rewrites in batch rows', () => {
    const plan = buildFunctionalDeliveryPlan(rows)
    const missingContractPlan = copyPlan(plan, (copy) => {
      const module = copy.modules[0] as unknown as { dependsOnContracts: string[] }
      module.dependsOnContracts.push('unregistered-contract')
      return copy
    })
    const alteredRequirementPlan = copyPlan(plan, (copy) => {
      const requirement = copy.modules[0]!.requirements[0]!
      copy.modules[0]!.requirements[0] = { ...requirement, priority: 'P3' }
      return copy
    })

    expect(validateFunctionalDeliveryPlan(missingContractPlan, rows).join('\n')).toMatch(/missing contract dependency/i)
    expect(validateFunctionalDeliveryPlan(alteredRequirementPlan, rows).join('\n')).toMatch(/priority.*changed/i)
  })

  it('rejects duplicate source rows and requires every discarded row to be in the explicit exclusion list', () => {
    const plan = buildFunctionalDeliveryPlan(rows)
    const duplicateRows = [...rows, rows[0]!]
    const incompleteExclusions = copyPlan(plan, (copy) => {
      copy.excludedRequirements.shift()
      return copy
    })

    expect(validateFunctionalDeliveryPlan(plan, duplicateRows).join('\n')).toMatch(
      /duplicate.*source|source.*duplicate/i
    )
    expect(validateFunctionalDeliveryPlan(incompleteExclusions, rows).join('\n')).toMatch(/discarded|exclusion/i)
  })

  it('rejects unknown source statuses and active rows without phase, priority, or acceptance criteria', () => {
    const unknownStatusRows = rows.map((row, index) => (index === 0 ? { ...row, status: 'UNRECOGNIZED' } : row))
    const incompleteCriteriaRows = rows.map((row, index) => (index === 1 ? { ...row, acceptance: '' } : row))

    expect(
      validateFunctionalDeliveryPlan(buildFunctionalDeliveryPlan(unknownStatusRows), unknownStatusRows).join('\n')
    ).toMatch(/unknown status/i)
    expect(
      validateFunctionalDeliveryPlan(buildFunctionalDeliveryPlan(incompleteCriteriaRows), incompleteCriteriaRows).join(
        '\n'
      )
    ).toMatch(/acceptance|criteria/i)
  })
})
