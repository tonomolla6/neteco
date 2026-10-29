import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCatalogCsvCells } from '../../shared/catalog-tabular-core'

const inventoryPath = resolve('docs/production/requirements-traceability.csv')
const source = readFileSync(inventoryPath, 'utf8')
const [header, ...records] = parseCatalogCsvCells(source, {
  maxRows: 1000,
  maxColumns: 32,
  maxCellCharacters: 20000
})
const rows = records.map((record) => Object.fromEntries(header!.map((key, index) => [key, record[index] ?? ''])))
const byId = new Map(rows.map((row) => [row.id, row]))

describe('requirements inventory evidence consistency', () => {
  it('matches the real read-only generator without modifying the inventory', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/audit-master-requirements.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10000
    })
    expect(output).toContain('active=695 repository_evidence_percent=19.57 (not production completion)')
    expect(readFileSync(inventoryPath, 'utf8')).toBe(source)
  })

  it('preserves historical scope and does not promote partial work to repository acceptance', () => {
    expect(rows).toHaveLength(702)
    expect(new Set(rows.map((row) => row.id)).size).toBe(702)
    const counts = rows.reduce<Record<string, number>>(
      (result, row) => {
        result[row.status!] = (result[row.status!] ?? 0) + 1
        return result
      },
      { MISSING: 0 }
    )
    expect(counts).toEqual({
      REPO_EVIDENCE: 136,
      PARTIAL_EXTERNAL: 121,
      NOT_VERIFIED: 242,
      ROADMAP_NOT_STARTED: 196,
      MISSING: 0,
      DISCARDED: 7
    })
  })

  it.each(['SEA-008', 'SEO-011'])(
    'records %s repository acceptance for crawlable initial SSR pagination, not deployed acceptance',
    (id) => {
      const row = byId.get(id)!
      expect(row.status).toBe('REPO_EVIDENCE')
      expect(row.last_verified).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      const refs = row.implementation_refs!.split('; ')
      // These are the real consumers and executable API-to-SSR comparisons,
      // not merely a composable capable of accepting a page parameter.
      for (const path of [
        'app/pages/catalogo.vue',
        'app/pages/categoria/[slug].vue',
        'app/pages/buscar.vue',
        'app/components/ResourceHubPanel.vue',
        'app/pages/recursos/index.vue',
        'tests/components/search-read-state.test.ts',
        'tests/components/resource-hub.test.ts',
        'tests/compiled/search-pagination.test.ts',
        'tests/compiled/resource-hub.test.ts'
      ]) {
        expect(refs, `${id}: ${path}`).toContain(path)
        expect(existsSync(resolve(path)), path).toBe(true)
      }
      expect(new Set(refs).size).toBe(refs.length)
      expect(row.notes).toMatch(/SSR|server.render/i)
      expect(row.notes).toMatch(/anchors|links|href/i)
      expect(row.notes).toMatch(
        /without.*(?:JavaScript|scroll)|(?:no|disabled).*JavaScript|scripts.*(?:disabled|removed)/i
      )
      expect(row.notes).toMatch(/not.*(?:production|deploy)|(?:production|deploy).*pending|deployed.*unverified/i)
    }
  )

  it.each(['MKT-012', 'MKT-013', 'CHK-020', 'MKT-027', 'SEO-027', 'SEA-016'])(
    'records implemented %s as partial rather than certified or unstarted',
    (id) => {
      const row = byId.get(id)!
      expect(row.status).toBe('NOT_VERIFIED')
      expect(row.last_verified).toBe('')
      expect(row.notes).toMatch(/partial implementation/i)
      expect(row.notes).toMatch(/pending|unverified|outstanding/i)
      expect(row.implementation_refs).toContain(
        id === 'MKT-012' || id === 'MKT-013' || id === 'CHK-020' ? 'shared/cart-recovery.ts' : 'shared/resource-hub.ts'
      )
      for (const path of row.implementation_refs!.split('; ')) expect(existsSync(resolve(path)), path).toBe(true)
    }
  )

  it.each([
    {
      id: 'SEC-003',
      refs: [
        '.gitleaks.toml',
        '.github/workflows/ci.yml',
        'scripts/lib/gitleaks-policy-probe.mjs',
        'tests/unit/gitleaks-policy-probe.test.ts',
        'scripts/lib/cloudflare-config-safety.ts',
        'tests/unit/cloudflare-config-boundaries.test.ts',
        'tests/unit/cloudflare-demo-secrets.test.ts'
      ],
      limits: [/rotation/i, /least.privilege/i, /secret bindings/i, /access audit/i, /pending/i]
    },
    {
      id: 'TST-009',
      refs: [
        'tests/unit/d1-durable-object-persistence-native.test.ts',
        'tests/unit/d1-migrations-upgrade.test.ts',
        'tests/unit/d1-account-security-native.test.ts',
        'scripts/audit-cloudflare-shop.ts'
      ],
      limits: [/D1/i, /Durable Objects/i, /controlled remote/i, /integral native suite/i, /pending/i]
    },
    {
      id: 'CIC-006',
      refs: [
        'scripts/emit-cloudflare-artifacts.ts',
        'scripts/lib/cloudflare-artifact-manifest.ts',
        'tests/unit/cloudflare-artifact-manifest.test.ts',
        'tests/unit/cloudflare-artifacts-cli.test.ts',
        'tests/unit/cloudflare-artifacts-ci.test.ts',
        'scripts/lib/worker-bundle-policy.ts'
      ],
      limits: [/SBOM/i, /startup/i, /reproducib/i, /vulnerabilit/i, /Oracle CI/i, /pending/i]
    },
    {
      id: 'CIC-007',
      refs: [
        'infra/cloudflare/README.md',
        'infra/cloudflare/versions.tf',
        'infra/cloudflare/resources.tf',
        'infra/cloudflare/edge.tf',
        'scripts/generate-shop-config.ts',
        'scripts/lib/cloudflare-environment-config.ts'
      ],
      limits: [/remote/i, /recreat/i, /Oracle CI/i, /pending/i]
    }
  ])('$id records existing partial implementation without declaring operational acceptance', ({ id, refs, limits }) => {
    const row = byId.get(id)!
    expect(row.status).toBe('NOT_VERIFIED')
    expect(row.notes).toMatch(/partial implementation/i)
    const actualRefs = row
      .implementation_refs!.split(';')
      .map((path) => path.trim())
      .filter(Boolean)
    expect(new Set(actualRefs).size).toBe(actualRefs.length)
    for (const path of refs) {
      expect(existsSync(resolve(path)), `Missing evidence file: ${path}`).toBe(true)
      expect(actualRefs).toContain(path)
    }
    for (const limit of limits) expect(row.notes).toMatch(limit)
    expect(row.notes).not.toMatch(/Known repository gap\./i)
    expect(row.last_verified).toBe('')
  })

  it.each([
    'ORD-016',
    'ORD-018',
    'MKT-028',
    'COM-017',
    'SUP-013',
    'SHP-024',
    'SEA-017',
    'CUS-026',
    'PRI-013',
    'PRI-016',
    'PRI-012',
    'CHK-016',
    'CHK-018',
    'CHK-019',
    'UI-013',
    'MKT-017',
    'MKT-024',
    'MKT-025',
    'CUS-017',
    'ORD-019',
    'CUS-027'
  ])('%s acknowledges partial implementation without claiming acceptance', (id) => {
    const row = byId.get(id)!
    expect(row.implementation_refs).not.toBe('')
    expect(row.status).toBe('NOT_VERIFIED')
    expect(row.notes).toMatch(/partial implementation/i)
    expect(row.notes).not.toMatch(/roadmap status unchanged/i)
  })

  it('leaves unsupported verification dates unknown while retaining specifically documented dates', () => {
    expect(byId.get('CAT-003')!.last_verified).toBe('')
    expect(rows.filter((row) => row.last_verified === '')).toHaveLength(555)
    expect(
      rows
        .filter((row) => row.last_verified === '2026-10-10')
        .map((row) => row.id)
        .sort()
    ).toEqual(['SEA-008', 'SEO-011'])
    expect(byId.get('CAT-002')!.last_verified).toBe('2026-08-20')
    expect(byId.get('CAT-007')!.last_verified).toBe('2026-10-08')
    expect(byId.get('ORD-016')!.last_verified).toBe('2026-10-03')
  })

  it('records search recovery and canonical source work without claiming complete acceptance', () => {
    for (const id of ['SEA-002', 'SEA-010', 'SEO-005']) {
      const row = byId.get(id)!
      expect(row.status).toBe('NOT_VERIFIED')
      expect(row.last_verified).toBe('2026-10-09')
      expect(row.notes).toMatch(/partial implementation/i)
      expect(row.notes).toMatch(/pending/i)
      expect(row.implementation_refs).toContain('tests/components/search-')
    }
  })

  it('records sensitive-action audit evidence without claiming all-family operational acceptance', () => {
    const row = byId.get('ADM-005')!
    expect(row.status).toBe('NOT_VERIFIED')
    expect(row.last_verified).toBe('2026-10-09')
    expect(row.implementation_refs).toContain('0084_admin_audit.sql')
    expect(row.implementation_refs).toContain('d1-admin-audit-boundaries.test.ts')
    expect(row.notes).toMatch(/partial implementation/i)
    expect(row.notes).toMatch(/retention/i)
    expect(row.notes).toMatch(/pending/i)
  })

  it('records saved operational views and product image interaction without claiming whole-list or browser acceptance', () => {
    for (const id of ['UI-005', 'PDP-004', 'MED-010']) {
      const row = byId.get(id)!
      expect(row.status).toBe('NOT_VERIFIED')
      expect(row.last_verified).toBe('2026-10-09')
      expect(row.notes).toMatch(/partial implementation/i)
      expect(row.notes).toMatch(/pending/i)
    }
    expect(byId.get('UI-005')!.implementation_refs).toContain('0085_admin_order_views.sql')
    expect(byId.get('UI-005')!.notes).toMatch(/(?:not|never) search text/i)
    expect(byId.get('UI-005')!.notes).toMatch(/bulk preview/i)
    expect(byId.get('UI-005')!.notes).toMatch(/immutable D1 group/i)
    expect(byId.get('UI-005')!.notes).toMatch(/Queue processing/i)
    expect(byId.get('PDP-004')!.implementation_refs).toContain('ProductImageLightbox.vue')
    expect(byId.get('MED-010')!.notes).toContain('does not invent photographs')
  })

  it('records calendar, escalation and UI-harness source work without certifying production or visual acceptance', () => {
    for (const id of ['SHP-009', 'SHP-019', 'SUP-006', 'UI-013']) {
      const row = byId.get(id)!
      expect(row.last_verified).toBe('2026-10-09')
      expect(row.status).not.toBe('REPO_EVIDENCE')
      expect(row.notes).toMatch(/pending|unaccepted|does not certify|remain/i)
      expect(row.implementation_refs).not.toBe('')
    }
    expect(byId.get('UI-013')!.status).toBe('NOT_VERIFIED')
    expect(byId.get('UI-013')!.notes).toContain('No PNG baselines have been generated or reviewed')
    expect(byId.get('SUP-006')!.implementation_refs).toContain('0079_support_escalations.sql')
    expect(byId.get('SHP-019')!.implementation_refs).toContain('0078_shipping_calendars.sql')
  })

  it('records the CMS promotions and safe communication recovery without promoting source checks to production acceptance', () => {
    for (const id of ['MKT-004', 'MKT-006', 'COM-011']) {
      const row = byId.get(id)!
      expect(row.status).toBe('NOT_VERIFIED')
      expect(row.last_verified).toBe('2026-10-09')
      expect(row.notes).toMatch(/partial implementation/i)
      expect(row.notes).toMatch(/pending/i)
    }
    expect(byId.get('MKT-004')!.implementation_refs).toContain('workers/cms/promotional-content.ts')
    expect(byId.get('MKT-004')!.implementation_refs).toContain('0081_promotional_analytics.sql')
    expect(byId.get('COM-011')!.implementation_refs).toContain('0080_communication_history_commands.sql')
    expect(byId.get('COM-011')!.notes).toContain('does not invoke a sender')
    expect(byId.get('CUS-006')!.notes).toContain('NFC')
  })

  it('records atomic saved carts and explicit revocable sharing without promoting compiled-browser acceptance', () => {
    const row = byId.get('CHK-018')!
    expect(row.status).toBe('NOT_VERIFIED')
    expect(row.last_verified).toBe('2026-10-09')
    expect(row.implementation_refs).toContain('db/d1/migrations/0075_cart_snapshots.sql')
    expect(row.implementation_refs).toContain('workers/catalog/cart-snapshots-http.ts')
    expect(row.implementation_refs).toContain('app/pages/carrito-compartido.vue')
    expect(row.notes).toContain('existing favorite lists')
    expect(row.notes).toContain('24-hour')
    expect(row.notes).toContain('Compiled browser and deployed acceptance remain pending')
  })

  it('records explicitly reviewed directed product relations without claiming chemical compatibility or browser acceptance', () => {
    const row = byId.get('CAT-010')!
    expect(row.status).toBe('NOT_VERIFIED')
    expect(row.last_verified).toBe('2026-10-09')
    expect(row.implementation_refs).toContain('db/d1/migrations/0076_catalog_relations.sql')
    expect(row.implementation_refs).toContain('workers/catalog/catalog-relations-http.ts')
    expect(row.implementation_refs).toContain('app/components/PublishedProductRelations.vue')
    expect(row.notes).toContain('directed')
    expect(row.notes).toContain('no automatic substitution')
    expect(row.notes).toContain('Compiled browser and deployed acceptance remain pending')
  })

  it('records real basket-margin simulation without treating shipping charges as operational cost or release acceptance', () => {
    const row = byId.get('PRI-012')!
    expect(row.status).toBe('NOT_VERIFIED')
    expect(row.last_verified).toBe('2026-10-09')
    expect(row.implementation_refs).toContain('workers/catalog/promotion-basket-preview.ts')
    expect(row.implementation_refs).toContain('app/components/PromotionBasketSimulator.vue')
    expect(row.notes).toContain('cost_net_cents')
    expect(row.notes).toContain('not shipping operational cost')
    expect(row.notes).toContain('Compiled browser and deployed acceptance remain pending')
  })

  it.each([
    ['ORD-008', 'workers/catalog/guest-order-access-http.ts'],
    ['ORD-008', 'tests/unit/d1-guest-order-access-entrypoints.test.ts'],
    ['SEA-017', 'tests/unit/quick-order-native.test.ts'],
    ['CUS-026', 'app/components/QuickOrderPanel.vue'],
    ['INT-002', 'tests/unit/d1-scheduled-outbox-isolation.test.ts'],
    ['TST-010', 'tests/unit/d1-migrations-upgrade.test.ts'],
    ['ORD-003', 'workers/catalog/order-timeline.ts'],
    ['ORD-004', 'workers/catalog/order-cancellation.ts'],
    ['ORD-005', 'workers/catalog/order-cancellation.ts'],
    ['ORD-010', 'workers/catalog/order-annotations.ts'],
    ['ORD-012', 'workers/communications/order-operations-email.ts'],
    ['CUS-006', 'tests/components/account-address-book.test.ts'],
    ['CUS-007', 'shared/customer-tax-validation.ts'],
    ['CUS-009', 'tests/components/account-overview.test.ts'],
    ['CUS-008', 'db/d1/migrations/0066_account_preferences.sql'],
    ['CUS-010', 'tests/components/account-preferences.test.ts'],
    ['CUS-012', 'tests/components/account-privacy-panel.test.ts'],
    ['CUS-012', 'tests/unit/d1-account-security-native.test.ts'],
    ['ORD-015', 'app/components/AdminOrderWorkbench.vue'],
    ['ORD-015', 'workers/catalog/order-export.ts'],
    ['SEA-005', 'workers/catalog/search-synonyms.ts'],
    ['SUP-007', 'workers/support/knowledge.ts'],
    ['UI-003', 'app/components/AdminCommandPalette.vue']
  ])('%s records the implemented journey without claiming complete acceptance', (id, reference) => {
    const row = byId.get(id)!
    expect(row.status).toBe('NOT_VERIFIED')
    expect(row.implementation_refs).toContain(reference)
    expect(row.last_verified).toBe(['CUS-006', 'CUS-007', 'CUS-012'].includes(id) ? '2026-10-09' : '2026-10-08')
    expect(row.notes).toMatch(/pending/i)
  })

  it('records administrative company review without treating credit or fiscal approval as implemented', () => {
    const row = byId.get('CUS-002')!
    expect(row.status).toBe('REPO_EVIDENCE')
    expect(row.implementation_refs).toContain('db/d1/migrations/0064_company_admin_review.sql')
    expect(row.implementation_refs).toContain('tests/unit/d1-admin-companies-entrypoints.test.ts')
    expect(row.last_verified).toBe('2026-10-08')
    expect(row.notes).toContain('does not grant roles, credit, commercial terms or external fiscal approval')
    expect(row.notes).toContain('pending')
  })

  it('documents a contractual buyer PO without claiming compiled or deployed acceptance', () => {
    const row = byId.get('CHK-016')!
    expect(row.status).toBe('NOT_VERIFIED')
    expect(row.last_verified).toBe('2026-10-09')
    expect(row.implementation_refs).toContain('db/d1/migrations/0074_order_purchase_reference.sql')
    expect(row.implementation_refs).toContain('workers/catalog/order-customer-reference.ts')
    expect(row.implementation_refs).toContain('tests/unit/d1-promotions-native.test.ts')
    expect(row.notes).toContain('purchaseOrderReference')
    expect(row.notes).toContain('separate from fiscal identity and delivery instructions')
    expect(row.notes).toContain('Compiled browser and deployed acceptance remain pending')
  })

  it('documents optional satisfaction without claiming compiled, guest or privacy-policy acceptance', () => {
    const row = byId.get('SUP-010')!
    expect(row.status).toBe('NOT_VERIFIED')
    expect(row.last_verified).toBe('2026-10-09')
    expect(row.implementation_refs).toContain('db/d1/migrations/0068_support_satisfaction.sql')
    expect(row.implementation_refs).toContain('tests/unit/d1-support-satisfaction-native.test.ts')
    expect(row.notes).toContain('guest survey invitations are not implemented')
    expect(row.notes).toContain('Physical comment erasure is not automated')
    expect(row.notes).toContain('compiled Chromium journeys and deployed operation remain unaccepted')
  })
  it('keeps tracking partial after operational preferences without claiming carrier or compiled acceptance', () => {
    const row = byId.get('SHP-015')!
    expect(row.status).toBe('PARTIAL_EXTERNAL')
    expect(row.last_verified).toBe('2026-10-09')
    expect(row.implementation_refs).toContain('tests/unit/d1-order-tracking-native.test.ts')
    expect(row.implementation_refs).toContain('app/components/OrderTrackingPanel.vue')
    expect(row.implementation_refs).toContain('db/d1/migrations/0070_delivery_preferences.sql')
    expect(row.implementation_refs).toContain('tests/unit/d1-delivery-notice-preferences.test.ts')
    expect(row.notes).toContain('immutable terminal suppression')
    expect(row.notes).toContain('compiled Chromium and deployed acceptance remain pending')
    expect(row.notes).toContain('does not extend or renew')
  })
  it.each(['SHP-013', 'SHP-018', 'SHP-020'])(
    '%s keeps external acceptance pending after local manual packing implementation',
    (id) => {
      const row = byId.get(id)!
      expect(row.status).toBe('PARTIAL_EXTERNAL')
      expect(row.last_verified).toBe('2026-10-09')
      expect(row.implementation_refs).toContain('db/d1/migrations/0069_order_packing.sql')
      expect(row.implementation_refs).toContain('tests/unit/d1-order-packing-native.test.ts')
      expect(row.notes).toMatch(/pending/i)
    }
  )
})
