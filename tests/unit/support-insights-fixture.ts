import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { cmsFixture } from './d1-cms-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { testUuid } from '../support/deterministic'

export const NOW = '2026-10-29T12:00:00Z'
export const COOKIE_CONFIG = { password: 'synthetic-support-insights-session-password-0123456789', maxAgeSeconds: 3600 }
export const ORIGIN = 'https://tienda.neteco.test'
export const ADMIN = { id: '10000000-0000-4000-8000-0000000000a1', session: '20000000-0000-4000-8000-0000000000a1' }
export const ADMIN2 = { id: '10000000-0000-4000-8000-0000000000a2', session: '20000000-0000-4000-8000-0000000000a2' }
export const NOPERM = { id: '10000000-0000-4000-8000-0000000000a3', session: '20000000-0000-4000-8000-0000000000a3' }
export const NOMFA = { id: '10000000-0000-4000-8000-0000000000a4', session: '20000000-0000-4000-8000-0000000000a4' }
export const CUSTOMER_A = {
  id: '10000000-0000-4000-8000-0000000000c1',
  session: '20000000-0000-4000-8000-0000000000c1',
  customer: '30000000-0000-4000-8000-0000000000c1',
  company: '40000000-0000-4000-8000-0000000000c1'
}
export const CUSTOMER_B = {
  id: '10000000-0000-4000-8000-0000000000c2',
  session: '20000000-0000-4000-8000-0000000000c2',
  customer: '30000000-0000-4000-8000-0000000000c2',
  company: '40000000-0000-4000-8000-0000000000c2'
}
export const CUSTOMER_PENDING = {
  id: '10000000-0000-4000-8000-0000000000c3',
  session: '20000000-0000-4000-8000-0000000000c3',
  customer: '30000000-0000-4000-8000-0000000000c3',
  company: '40000000-0000-4000-8000-0000000000c3'
}
export const claimsOf = (a: { id: string; session: string }) => ({
  identityId: a.id,
  sessionId: a.session,
  sessionVersion: 1
})

const MIGRATIONS = [
  '0045_cms_publication.sql',
  '0097_carrier_resilience.sql',
  '0110_rca_copilot_audiences.sql',
  '0151_support_assistant_insights_b2b_portal.sql'
]

export async function insightsFixture() {
  const fixture = await cmsFixture()
  const { sqlite, database } = fixture
  for (const name of MIGRATIONS) {
    if (
      name === '0045_cms_publication.sql' &&
      sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='content_publication_states'").get()
    )
      continue
    sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${name}`, import.meta.url), 'utf8'))
  }
  const past = '2026-01-01T00:00:00Z'
  sqlite.exec(`INSERT OR IGNORE INTO roles(code,name,description) VALUES('support_admin','Support','fixture');
    INSERT OR IGNORE INTO permissions(code,resource,action,description) VALUES('support.manage','support','manage','fixture');
    INSERT OR IGNORE INTO role_permissions(role_code,permission_code) VALUES('support_admin','support.manage');`)
  const person = (id: string, session: string, email: string, mfa: number, customer: string | null) => {
    if (customer)
      sqlite
        .prepare("INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(?,?, 'active',?,?)")
        .run(customer, 'Cliente ' + email, past, past)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,'hash',?,'active',?,?,?)"
      )
      .run(id, email, past, customer, past, past)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,?,?,?)'
      )
      .run(session, id, mfa, past, '2027-12-31T00:00:00Z')
  }
  person(ADMIN.id, ADMIN.session, 'admin@example.invalid', 1, null)
  person(ADMIN2.id, ADMIN2.session, 'admin2@example.invalid', 1, null)
  person(NOPERM.id, NOPERM.session, 'noperm@example.invalid', 1, null)
  person(NOMFA.id, NOMFA.session, 'nomfa@example.invalid', 0, null)
  for (const a of [ADMIN, ADMIN2, NOMFA])
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?, 'support_admin', ?)")
      .run(a.id, past)
  for (const [c, status] of [
    [CUSTOMER_A, 'approved'],
    [CUSTOMER_B, 'approved'],
    [CUSTOMER_PENDING, 'pending']
  ] as const) {
    person(c.id, c.session, `${c.customer.slice(-2)}@cliente.invalid`, 1, c.customer)
    sqlite
      .prepare('INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(c.company, c.customer, 'Empresa ' + c.customer.slice(-2), status, past, past)
  }
  const cookies = new Map<string, string>()
  for (const a of [ADMIN, ADMIN2, NOPERM, NOMFA, CUSTOMER_A, CUSTOMER_B, CUSTOMER_PENDING]) {
    const header = await issueD1SessionCookie(database, claimsOf(a), COOKIE_CONFIG)
    cookies.set(a.id, header!.split(';')[0]!)
  }
  return { sqlite, database, cookie: (a: { id: string }) => cookies.get(a.id)! }
}

export function seedKnowledgePage(
  sqlite: DatabaseSync,
  options: {
    slug: string
    title: string
    description: string
    category: string
    text: string[]
    reviewDueAt?: string
    publishedAt?: string
    publish?: boolean
  }
) {
  const pageId = testUuid(),
    versionId = testUuid(),
    publicationId = testUuid()
  const created = '2026-09-01T00:00:00Z',
    published = options.publishedAt ?? '2026-10-01T00:00:00Z'
  const document = {
    title: options.title,
    slug: options.slug,
    blocks: options.text.map((text) => ({ id: testUuid(), type: 'paragraph', text })),
    seo: { title: options.title, description: options.description, noindex: false },
    supportKnowledge: { category: options.category, reviewDueAt: options.reviewDueAt ?? '2099-01-01T00:00:00Z' },
    changeSummary: 'Fixture'
  }
  const editor = '10000000-0000-4000-8000-000000000044'
  sqlite
    .prepare(
      `INSERT INTO content_pages(id,slug,title,status,page_version,draft_version,created_by,created_at,updated_at) VALUES (?,?,?,'draft',1,0,?,?,?)`
    )
    .run(pageId, options.slug, options.title, editor, created, created)
  sqlite
    .prepare('INSERT INTO content_versions(id,page_id,version,document,created_by,created_at) VALUES (?,?,1,?,?,?)')
    .run(versionId, pageId, JSON.stringify(document), editor, created)
  sqlite.prepare('UPDATE content_pages SET draft_version=1,draft_version_id=? WHERE id=?').run(versionId, pageId)
  if (options.publish !== false) {
    sqlite
      .prepare(
        `INSERT INTO content_publications(id,page_id,version_id,slug,actor_id,reason,published_at) VALUES (?,?,?,?,?,'Fixture editorial review',?)`
      )
      .run(publicationId, pageId, versionId, options.slug, editor, published)
    sqlite
      .prepare('INSERT INTO content_publication_states(page_id,revision,publication_id,updated_at) VALUES (?,1,?,?)')
      .run(pageId, publicationId, created)
  }
  return { pageId, versionId, publicationId }
}

let ticketSeq = 0
/** Genuine immutable creation proof + projection, with the FK-checked links the analysis reads. */
export function seedTicket(
  sqlite: DatabaseSync,
  o: {
    category?: string
    createdAt: string
    orderId?: string | null
    customerId?: string | null
    productSlug?: string | null
    adminTouches?: number
  }
) {
  const n = ++ticketSeq,
    id = `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    command = `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    ref = 'SOP-' + String(n).padStart(24, '0')
  const snapshot = JSON.stringify({ priority: 'normal', customerId: o.customerId ?? null, orderId: o.orderId ?? null })
  const response = JSON.stringify({
    commandId: command,
    publicRef: ref,
    version: 1,
    state: 'open',
    inventoryEffect: 'none',
    economicEffect: 'none'
  })
  sqlite
    .prepare(
      `INSERT INTO support_commands(id,nonce,actor_key,actor_type,ticket_id,public_ref,action,idempotency_key,payload_hash,input,snapshot,expected_version,result_version,to_state,response,created_at)
       VALUES (?,?,'anonymous:synthetic','anonymous',?,?,'created',?,?,'{}',?,0,1,'open',?,?)`
    )
    .run(command, command, id, ref, `seed-${n}`, 'a'.repeat(64), snapshot, response, o.createdAt)
  sqlite
    .prepare(
      `INSERT INTO support_tickets(id,public_ref,customer_id,order_id,category,subject,requester,product_slug,state,priority,version,last_command_id,created_at,updated_at)
       VALUES (?,?,?,?,?,'Synthetic subject','{}',?,'open','normal',1,?,?,?)`
    )
    .run(
      id,
      ref,
      o.customerId ?? null,
      o.orderId ?? null,
      o.category ?? 'other',
      o.productSlug ?? null,
      command,
      o.createdAt,
      o.createdAt
    )
  if (o.adminTouches) {
    const note = `81000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    sqlite
      .prepare(
        `INSERT INTO support_commands(id,nonce,actor_key,actor_id,actor_type,ticket_id,public_ref,action,idempotency_key,payload_hash,input,snapshot,expected_version,result_version,from_state,to_state,response,created_at)
         VALUES (?,?,?,?, 'admin',?,?,'note',?,?,'{}',?,1,2,'open','open',?,?)`
      )
      .run(
        note,
        note,
        'identity:' + ADMIN.id,
        ADMIN.id,
        id,
        ref,
        `seed-note-${n}`,
        'b'.repeat(64),
        snapshot,
        JSON.stringify({
          commandId: note,
          publicRef: ref,
          version: 2,
          state: 'open',
          inventoryEffect: 'none',
          economicEffect: 'none'
        }),
        o.createdAt
      )
  }
  return id
}

/** Orders/lines/labels are seeded with FK checks off: only the columns the analysis reads are meaningful. */
export function seedOrder(
  sqlite: DatabaseSync,
  o: { id: string; customerId: string | null; createdAt: string; carrier?: string; productSlugs?: string[] }
) {
  sqlite.exec('PRAGMA foreign_keys = OFF')
  try {
    const n = o.id.slice(-6)
    sqlite
      .prepare(
        `INSERT INTO orders(id,cart_id,quote_id,shipping_quote_id,attempt_id,token_hash,status,reservation_id,reservation_expires_at,currency,total_net_cents,total_tax_cents,total_gross_cents,shipping_net_cents,shipping_tax_cents,shipping_gross_cents,shipping_method_code,shipping_rate_version,shipping_eta_min_days,shipping_eta_max_days,contact_email,contact_email_hash,consent_tos,consent_privacy,correlation_id,customer_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?, 'awaiting_payment',?, '2027-01-01T00:00:00Z','EUR',100,21,121,0,0,0,'parcel',1,1,2,'c@example.invalid',?,1,1,?,?,?,?)`
      )
      .run(
        o.id,
        'cart' + n,
        'q' + n,
        's' + n,
        'a' + n,
        n.padStart(64, '0'),
        'r' + n,
        'f'.repeat(64),
        'corr' + n,
        o.customerId,
        o.createdAt,
        o.createdAt
      )
    ;(o.productSlugs ?? []).forEach((slug, index) => {
      sqlite
        .prepare("INSERT OR IGNORE INTO products(id,category_id,name,slug) VALUES (?, 'c1', ?, ?)")
        .run('prod-' + slug, slug, slug)
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO variants(id,product_id,tax_class_id,shipping_profile_id,sku,format,price_gross_cents) VALUES (?,?,'t21','sp1',?,'1 L',121)`
        )
        .run('var-' + slug, 'prod-' + slug, 'sku-' + slug)
      sqlite
        .prepare(
          `INSERT INTO order_lines(order_id,line_index,variant_id,sku,name,quantity,unit_gross_cents,net_cents,tax_cents,gross_cents,tax_rate_basis_points,price_version_id,location_id,created_at) VALUES (?,?,?,?,?,1,121,100,21,121,2100,'pv','loc',?)`
        )
        .run(o.id, index, 'var-' + slug, 'sku-' + slug, slug, o.createdAt)
    })
    if (o.carrier)
      sqlite
        .prepare(
          `INSERT INTO carrier_shipment_labels(id,order_id,parcel_index,idempotency_key,carrier,service_code,tracking_number,provider_shipment_id,label_format,label_data,status,quoted_gross_cents,actual_cost_cents,created_at,updated_at)
           VALUES (?,?,0,?,?,'std','trk','prov','pdf','x','confirmed',0,0,?,?)`
        )
        .run(testUuid(), o.id, testUuid(), o.carrier, o.createdAt, o.createdAt)
  } finally {
    sqlite.exec('PRAGMA foreign_keys = ON')
  }
}
