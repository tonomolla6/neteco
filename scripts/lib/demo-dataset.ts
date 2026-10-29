import sharp from 'sharp'
import { z } from 'zod'
import { DEMO_IDENTITIES } from '../../shared/demo-access'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { renderD1CategorySeed, stableUuid } from './d1-category-seed'
import { renderD1ProductSeed } from './d1-product-seed'
import { renderD1InventorySeed } from './d1-inventory-seed'
import { renderD1ShippingSeed } from './d1-shipping-seed'
import { provisionPublicationValidityFixture } from '../../tests/support/publication-validity-fixture'
import { createMediaPublication, decideMediaRights, ingestMediaScanReceipt } from '../../workers/media/governance'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { createSupportTicket, supportActor, supportClock } from '../../workers/support/operations'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'

/** Offline, one-shot provisioning of an EMPTY, separately selected demo D1.
 * Never mount this module in a Worker/HTTP route. It grants only explicitly
 * synthetic identities; ordinary authentication and MFA are not changed.
 * No bank, fiscal, email, scanner or other external provider is contacted.
 * Scanner evidence below is clearly SYNTHETIC, not production antivirus.
 */
export interface DemoDatasetSummary {
  schemaVersion: 1
  validationOnly: true
  products: number
  variants: number
  categories: number
  stockLocations: number
  customers: number
  demoIdentities: number
  pendingOrders: number
  cmsPublishedPages: number
  cmsDraftPages: number
  supportTickets: number
  mediaObjects: number
  mediaExpiresAt: string
  externalProviderCalls: 0
}

const DEMO_PERMISSIONS = [
  'administration.manage',
  'catalog.write',
  'catalog.publish',
  'inventory.read',
  'inventory.write',
  'orders.read',
  'payments.read',
  'invoices.read',
  'support.manage',
  'security.read',
  'security.manage'
] as const
const UNUSABLE_PASSWORD = 'DEMO-OFFLINE-IDENTITY-NOT-A-PASSWORD-HASH'
const REASON = 'Bootstrap offline de datos sintéticos DEMO; sin venta real, aprobación legal ni proveedor externo'
const countRow = z.object({ n: z.number().int().nonnegative() })
function assertBatch(value: unknown, length: number) {
  z.array(z.object({ success: z.literal(true) }).passthrough())
    .length(length)
    .parse(value)
}
const rows = async <T>(database: D1Database, sql: string, schema: z.ZodType<T>) => {
  const result = await database.prepare(sql).all()
  if (!result.success) throw new Error('demo_read_unconfirmed')
  return z.array(schema).parse(result.results)
}
const count = async (database: D1Database, table: string) => {
  // Only constant internal table names are passed; no request/input selector.
  if (!/^[a-z_]+$/.test(table)) throw new Error('demo_table_invalid')
  return countRow.parse(await database.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n
}
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')

async function assertEmpty(database: D1Database) {
  const occupied = countRow.parse(
    await database
      .prepare(
        `SELECT (SELECT count(*) FROM products)+(SELECT count(*) FROM variants)
      +(SELECT count(*) FROM categories)+(SELECT count(*) FROM catalog_sources)
      +(SELECT count(*) FROM tax_classes)+(SELECT count(*) FROM customers)
      +(SELECT count(*) FROM identities)+(SELECT count(*) FROM auth_sessions)
      +(SELECT count(*) FROM orders)+(SELECT count(*) FROM carts)
      +(SELECT count(*) FROM media_uploads)+(SELECT count(*) FROM content_pages)
      +(SELECT count(*) FROM support_tickets)+(SELECT count(*) FROM newsletter_subscriptions)
      +(SELECT count(*) FROM inventory_locations)+(SELECT count(*) FROM brands)
      +(SELECT count(*) FROM shipping_profiles)+(SELECT count(*) FROM shipping_zones)
      +(SELECT count(*) FROM shipping_rates)+(SELECT count(*) FROM roles)
      +(SELECT count(*) FROM permissions) AS n`
      )
      .first()
  ).n
  if (occupied !== 0) throw new Error('demo_database_not_empty')
}

async function seedCatalog(database: D1Database) {
  for (const render of [renderD1CategorySeed, renderD1ProductSeed, renderD1InventorySeed, renderD1ShippingSeed]) {
    // Cloudflare D1 owns transaction boundaries. These existing renderers also
    // serve standalone SQLite; remove only their two explicit wrapper lines.
    const sql = render().replace(/^\s*(?:BEGIN TRANSACTION;|COMMIT;)\s*$/gm, '')
    const result = await database.exec(sql)
    if (!Number.isFinite(result.count) || !Number.isFinite(result.duration)) throw new Error('demo_seed_unconfirmed')
  }
  const labelled = await database.batch([
    database.prepare(
      `UPDATE catalog_sources SET name='Catálogo DEMO sintético NETECO, sin venta real' WHERE code='neteco-demo'`
    ),
    database.prepare(`UPDATE products SET name='DEMO · '||name,
      short_description='DEMO: datos de demostración, no oferta comercial. '||short_description,
      description='DEMO: catálogo ilustrativo, sin venta real ni certificación de aptitud. '||description,
      attributes=json_remove(json_set(attributes,'$.badges',json('["DEMO"]')),'$.image')`)
  ])
  assertBatch(labelled, 2)
}

async function seedIdentities(database: D1Database, now: string) {
  const statements: D1PreparedStatement[] = [
    database.prepare(`INSERT INTO roles(code,name,description) VALUES
      ('customer','Cliente DEMO','Identidad sintética de demostración'),
      ('admin','Administrador DEMO','Sólo D1 dedicada de demostración'),
      ('demo_bootstrap','Bootstrap offline DEMO','Actor interno sintético, acceso temporal revocado al terminar')`)
  ]
  for (const [role, identity] of Object.entries(DEMO_IDENTITIES)) {
    statements.push(
      database
        .prepare(`INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(?,?,'active',?,?)`)
        .bind(
          identity.customerId,
          role === 'admin' ? 'Administrador de demostración NETECO' : 'Cliente de demostración NETECO',
          now,
          now
        ),
      database
        .prepare(
          `INSERT INTO identities(id,customer_id,email,password_hash,email_verified_at,status,created_at,updated_at)
          VALUES(?,?,?,?,?,'active',?,?)`
        )
        .bind(identity.identityId, identity.customerId, identity.email, UNUSABLE_PASSWORD, now, now, now),
      database
        .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,?,?)')
        .bind(identity.identityId, role, now)
    )
  }
  for (const permission of DEMO_PERMISSIONS) {
    const [resource, action] = permission.split('.')
    statements.push(
      database
        .prepare(
          'INSERT INTO permissions(code,resource,action,description) VALUES(?,?,?,?) ON CONFLICT(code) DO NOTHING'
        )
        .bind(permission, resource!, action!, 'Permiso existente aplicado explícitamente a identidad sintética DEMO'),
      database.prepare("INSERT INTO role_permissions(role_code,permission_code) VALUES('admin',?)").bind(permission)
    )
  }
  const result = await database.batch(statements)
  assertBatch(result, statements.length)
}

async function bootstrapSessions(database: D1Database, actorId: string, now: string) {
  const expiry = new Date(Date.parse(now) + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const bootstrap: VerifiedSessionClaims = { identityId: actorId, sessionId: crypto.randomUUID(), sessionVersion: 1 }
  const customer: VerifiedSessionClaims = {
    identityId: DEMO_IDENTITIES.customer.identityId,
    sessionId: crypto.randomUUID(),
    sessionVersion: 1
  }
  const result = await database.batch([
    database
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at,expires_at) VALUES(?,'demo_bootstrap',?,?)")
      .bind(actorId, now, expiry),
    ...['catalog.write', 'catalog.publish', 'administration.manage'].map((permission) =>
      database
        .prepare("INSERT INTO role_permissions(role_code,permission_code) VALUES('demo_bootstrap',?)")
        .bind(permission)
    ),
    ...[bootstrap, customer].map((claims) =>
      database
        .prepare(
          'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,?,?,?)'
        )
        .bind(claims.sessionId, claims.identityId, claims === bootstrap ? 1 : 0, now, expiry)
    )
  ])
  assertBatch(result, 6)
  return { bootstrap, customer }
}

async function ownedDemoImage(
  database: D1Database,
  bucket: Pick<R2Bucket, 'put'>,
  actor: VerifiedSessionClaims,
  now: string,
  expiresAt: string,
  productIds: string[]
) {
  // Original geometric artwork from this script, not a copied brand/product
  // photo. The visible DEMO label survives PNG decoding and all derivatives.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
    <rect width="800" height="800" fill="#edf7fb"/><rect x="112" y="170" width="576" height="450" rx="38" fill="#007aa5"/>
    <path d="M280 458v-142c0-28 34-28 34 0v74-105c0-28 34-28 34 0v105-126c0-28 34-28 34 0v126-102c0-28 34-28 34 0v161l31-30c24-25 49-1 34 21l-67 96c-26 34-103 39-129 6z" fill="#fff"/>
    <text x="400" y="128" text-anchor="middle" font-family="sans-serif" font-size="66" font-weight="bold" fill="#123b50">DEMO NETECO</text>
    <text x="400" y="702" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#123b50">SIN VENTA REAL</text>
  </svg>`
  const bytes = new Uint8Array(await sharp(new TextEncoder().encode(svg)).png().toBuffer())
  const checksum = hex(await crypto.subtle.digest('SHA-256', bytes))
  const uploadId = stableUuid('demo:owned-illustration:v1')
  const objectKey = `quarantine/${uploadId}/${checksum}`
  const stored = await bucket.put(objectKey, bytes, {
    sha256: checksum,
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: {
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
      cacheControl: 'no-store'
    }
  })
  if (
    !stored ||
    stored.size !== bytes.byteLength ||
    !stored.etag ||
    !stored.checksums.sha256 ||
    hex(stored.checksums.sha256) !== checksum
  )
    throw new Error('demo_media_storage_unconfirmed')
  // The positive native fixture stores genuinely owned R2 bytes first. The
  // durable metadata below describes exactly that object, not a fake bucket.
  await database
    .prepare(
      `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,filename,
      content_type,byte_size,width,height,alt,rights_owner,rights_license,rights_source,storage_status,r2_etag,created_at,stored_at)
      VALUES(?,?,?,?,?,?,'demo-neteco-owned-illustration.png','image/png',?,800,800,'Ilustración propia DEMO NETECO, sin venta real',
      'NETECO, ilustración propia generada por script','Uso de esta ilustración original en la demostración sintética',?,'quarantined',?,?,?)`
    )
    .bind(
      uploadId,
      actor.identityId,
      'demo-owned-illustration-v1',
      checksum,
      checksum,
      objectKey,
      bytes.byteLength,
      JSON.stringify({
        kind: 'uploader_declaration',
        authorizedAt: now.slice(0, 10),
        reference: 'scripts/lib/demo-dataset.ts: original geometric DEMO illustration v1'
      }),
      stored.etag,
      now,
      now
    )
    .run()
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const receipt = new TextEncoder().encode(
    JSON.stringify({
      receiptId: crypto.randomUUID(),
      uploadId,
      checksum,
      objectKey,
      byteSize: bytes.byteLength,
      verdict: 'clean',
      scannerVersion: 'SYNTHETIC-DEMO-FIXTURE-NOT-PRODUCTION-ANTIVIRUS',
      scannedAt: now,
      expiresAt
    })
  )
  const signingKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  await ingestMediaScanReceipt(
    database,
    receipt,
    `sha256=${hex(await crypto.subtle.sign('HMAC', signingKey, receipt))}`,
    secret,
    now
  )
  await decideMediaRights(
    database,
    actor,
    uploadId,
    {
      decision: 'approve',
      reason: 'Ilustración original propia generada para DEMO sintética; no aval comercial ni antivirus real'
    },
    { idempotencyKey: 'demo-owned-art-rights-v1', now }
  )
  for (const productId of productIds) {
    await createMediaPublication(
      database,
      actor,
      uploadId,
      {
        productId,
        variantId: null,
        role: 'main',
        title: 'Ilustración original DEMO NETECO',
        altText: 'Ilustración propia DEMO NETECO, sin venta real',
        language: 'es',
        version: 'demo-v1',
        validFrom: now,
        validUntil: expiresAt
      },
      { idempotencyKey: `demo-main:${productId}`, now }
    )
  }
}

async function pendingOrders(database: D1Database, customer: VerifiedSessionClaims, now: string) {
  const variants = await rows(
    database,
    'SELECT id FROM variants ORDER BY legacy_id LIMIT 12',
    z.object({ id: z.string().uuid() })
  )
  if (variants.length !== 12) throw new Error('demo_variants_missing')
  const orderIds: string[] = []
  for (let index = 0; index < 6; index++) {
    const correlationId = `demo-pending-order-${index + 1}`
    const cart = await createCart(database, { correlationId, now })
    for (let line = 0; line < 2; line++) {
      await setCartLine(database, {
        cartId: cart.cartId,
        token: cart.token,
        variantId: variants[index * 2 + line]!.id,
        quantity: line + 1,
        expectedVersion: line + 1,
        idempotencyKey: `${correlationId}:line:${line}`,
        correlationId,
        now
      })
    }
    const shipping = await requestShippingOptions(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 3,
      idempotencyKey: `${correlationId}:shipping`,
      correlationId,
      now,
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    if (shipping.outcome !== 'options') throw new Error('demo_shipping_unavailable')
    const options = z
      .array(z.object({ optionIndex: z.number().int(), optionHash: z.string(), methodCode: z.string() }))
      .parse(shipping.body.options)
    const method = ['pickup', 'own_delivery', 'parcel'][index % 3]!
    const option = options.find((item) => item.methodCode === method)
    if (!option) throw new Error('demo_shipping_option_missing')
    const quote = await quoteCart(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 3,
      idempotencyKey: `${correlationId}:quote`,
      correlationId,
      now
    })
    if (quote.outcome !== 'quoted') throw new Error('demo_quote_unavailable')
    const address = {
      recipientName: 'Cliente de demostración NETECO',
      line1: 'Dirección ficticia DEMO, 1',
      city: 'Ontinyent',
      province: 'Valencia',
      postalCode: '46870',
      countryCode: 'ES',
      phone: '600000000'
    }
    const result = await placeOrder(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 3,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: z.string().uuid().parse(shipping.body.shippingQuoteId),
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      contactEmail: DEMO_IDENTITIES.customer.email,
      contactName: address.recipientName,
      contactPhone: address.phone,
      shippingAddress: address,
      billingAddress: address,
      consentTos: true,
      consentPrivacy: true,
      idempotencyKey: `${correlationId}:checkout`,
      correlationId,
      now,
      ownerSession: customer
    })
    if (result.outcome !== 'order_created') throw new Error('demo_order_unconfirmed')
    orderIds.push(z.string().uuid().parse(result.body.id))
  }
  return orderIds
}

async function cmsPages(database: D1Database, actor: VerifiedSessionClaims, now: string) {
  for (const [index, [slug, title, text]] of [
    [
      'bienvenida-demo',
      'Bienvenida a la DEMO NETECO',
      'Demostración técnica con productos y pedidos de ejemplo. No hay venta, cobro ni envío de emails reales.'
    ],
    [
      'guia-compra-demo',
      'Guía de compra de demostración',
      'Explora variantes, precios ilustrativos y carrito. Los pedidos DEMO permanecen pendientes: ningún banco ni proveedor fiscal está conectado.'
    ],
    [
      'borrador-editorial-demo',
      'Borrador editorial DEMO',
      'Contenido sintético privado para demostrar la edición versionada.'
    ]
  ].entries()) {
    const created = await executeD1CmsDraftCommand(
      database,
      actor,
      'create_draft',
      {},
      {
        expectedVersion: 0,
        slug,
        title,
        blocks: [{ id: crypto.randomUUID(), type: 'paragraph', text }],
        seo: {
          title,
          description: 'Contenido sintético de demostración NETECO. Sin venta ni proveedores reales.',
          noindex: true
        },
        changeSummary: REASON
      },
      { idempotencyKey: `demo-cms-draft-${index}`, now }
    )
    if (index < 2)
      await executeCmsPublicationCommand(
        { database, enabled: true, now: () => now },
        actor,
        created.pageId,
        {
          action: 'publish',
          expectedRevision: 0,
          expectedVersion: 1,
          versionId: created.versionId,
          reason: REASON
        },
        `demo-cms-publish-${index}`
      )
  }
}

async function revokeBootstrapSessions(
  database: D1Database,
  sessions: { bootstrap: VerifiedSessionClaims; customer: VerifiedSessionClaims },
  actorId: string,
  now: string
) {
  const revoked = await database.batch([
    ...[sessions.bootstrap, sessions.customer].map((claims) =>
      database.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(now, claims.sessionId)
    ),
    database.prepare("DELETE FROM identity_roles WHERE identity_id=? AND role_code='demo_bootstrap'").bind(actorId),
    database.prepare("DELETE FROM role_permissions WHERE role_code='demo_bootstrap'")
  ])
  assertBatch(revoked, 4)
  const live = countRow.parse(
    await database.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').first()
  )
  if (live.n !== 0) throw new Error('demo_bootstrap_revocation_unconfirmed')
}

/** Fixed synthetic data, never a provider, marketing list, paid order or
 * production approval. Re-running against a populated DB deliberately fails
 * before writes rather than overwriting live stock/prices/history.
 */
export async function provisionDemoDataset(
  database: D1Database,
  bucket: Pick<R2Bucket, 'put'>,
  nowInput: string
): Promise<DemoDatasetSummary> {
  const now = catalogPolicyInstantSchema.parse(nowInput)
  const expiresAt = new Date(Date.parse(now) + 7 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertEmpty(database)
  await seedCatalog(database)
  await seedIdentities(database, now)
  const products = await rows(
    database,
    "SELECT id FROM products WHERE status='published' ORDER BY legacy_id",
    z.object({ id: z.string().uuid() })
  )
  if (products.length !== 20) throw new Error('demo_product_count_unconfirmed')
  const evidence = await provisionPublicationValidityFixture(database, {
    productIds: products.map((product) => product.id),
    now,
    validUntil: expiresAt,
    media: false
  })
  const policy = z
    .object({ actor_id: z.string().uuid() })
    .parse(
      await database
        .prepare('SELECT actor_id FROM catalog_publication_policies WHERE id=?')
        .bind(evidence.policyId)
        .first()
    )
  const sessions = await bootstrapSessions(database, policy.actor_id, now)
  try {
    await ownedDemoImage(
      database,
      bucket,
      sessions.bootstrap,
      now,
      expiresAt,
      products.map((product) => product.id)
    )
    const orders = await pendingOrders(database, sessions.customer, now)
    await cmsPages(database, sessions.bootstrap, now)
    const actor = await supportActor(database, sessions.customer, 'customer', supportClock(now))
    for (const [index, subject] of [
      'Consulta sobre recogida del pedido DEMO',
      'Información sobre formatos de guantes DEMO'
    ].entries()) {
      await createSupportTicket(
        database,
        actor,
        {
          name: 'Cliente de demostración NETECO',
          email: DEMO_IDENTITIES.customer.email,
          category: 'order',
          subject,
          message: 'Consulta sintética de demostración. No corresponde a una compra ni solicita envíos reales.',
          privacyAcknowledged: true,
          website: '',
          orderId: orders[index]!
        },
        { idempotencyKey: `demo-support-${index}`, now, policy: null }
      )
    }
    const providerFacts = await Promise.all(
      [
        'payment_intents',
        'payment_events',
        'fiscal_provider_receipts',
        'refund_receipts',
        'fiscal_credit_receipts',
        'newsletter_editorial_deliveries',
        'newsletter_editorial_fake_receipts'
      ].map((table) => count(database, table))
    )
    if (providerFacts.some((value) => value !== 0)) throw new Error('demo_provider_facts_forbidden')
    return {
      schemaVersion: 1,
      validationOnly: true,
      products: products.length,
      variants: await count(database, 'variants'),
      categories: await count(database, 'categories'),
      stockLocations: await count(database, 'inventory_locations'),
      customers: await count(database, 'customers'),
      demoIdentities: 2,
      pendingOrders: orders.length,
      cmsPublishedPages: 2,
      cmsDraftPages: 1,
      supportTickets: await count(database, 'support_tickets'),
      mediaObjects: 1,
      mediaExpiresAt: expiresAt,
      externalProviderCalls: 0
    }
  } finally {
    // No bootstrap cookie is ever issued. Even partial failure revokes both
    // internal sessions and removes the temporary publisher's grants.
    await revokeBootstrapSessions(database, sessions, policy.actor_id, now)
  }
}
