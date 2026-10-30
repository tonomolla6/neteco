import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openAccountSecurityDatabase } from './d1-sqlite'

/** Full migrated schema plus a deterministic catalogue. Every instant is relative to the real clock. */
export const MER_ADMIN = '10000000-0000-4000-8000-0000000c0001'
export const MER_SESSION = '20000000-0000-4000-8000-0000000c0001'
export const MER_CLAIMS = { identityId: MER_ADMIN, sessionId: MER_SESSION, sessionVersion: 1 }
export const MER_ROOT = '30000000-0000-4000-8000-0000000c0001'
export const MER_CHILD = '30000000-0000-4000-8000-0000000c0002'
export const MER_DRAFT_CATEGORY = '30000000-0000-4000-8000-0000000c0003'
export const merProduct = (n: number) => `40000000-0000-4000-8000-0000000c00${String(n).padStart(2, '0')}`
export const merUtc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const DAY = 86_400_000

export interface MerProductSpec {
  n: number
  category?: string
  status?: 'published' | 'draft'
  stock?: number
  backorder?: boolean
  cost?: number | null
  featured?: number
}
export async function merchandisingWorld() {
  const sqlite: DatabaseSync = await openAccountSecurityDatabase()
  sqlite.limits.exprDepth = 100
  sqlite.limits.variableNumber = 100
  sqlite.limits.functionArg = 32
  const past = merUtc(-DAY)
  sqlite.exec(
    `INSERT OR IGNORE INTO roles(code,name,description) VALUES ('mer_admin','Merch admin','Synthetic');
     INSERT OR IGNORE INTO permissions(code,resource,action,description) VALUES ('catalog.write','catalog','write','Write'),('administration.manage','administration','manage','Manage');
     INSERT OR IGNORE INTO role_permissions(role_code,permission_code) VALUES ('mer_admin','catalog.write'),('mer_admin','administration.manage');`
  )
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'mer-admin@example.invalid','synthetic',?,'active',?,?)"
    )
    .run(MER_ADMIN, past, past, past)
  sqlite
    .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'mer_admin',?)")
    .run(MER_ADMIN, past)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
    )
    .run(MER_SESSION, MER_ADMIN, past, merUtc(3_600_000))
  sqlite
    .prepare(
      "INSERT INTO categories(id,legacy_id,name,slug,status,sort_order) VALUES (?,9101,'Limpieza','limpieza','published',1)"
    )
    .run(MER_ROOT)
  sqlite
    .prepare(
      "INSERT INTO categories(id,legacy_id,parent_id,name,slug,status,sort_order) VALUES (?,9102,?,'Lejías','lejias','published',2)"
    )
    .run(MER_CHILD, MER_ROOT)
  sqlite
    .prepare(
      "INSERT INTO categories(id,legacy_id,name,slug,status,sort_order) VALUES (?,9103,'Borrador','borrador','draft',3)"
    )
    .run(MER_DRAFT_CATEGORY)
  sqlite.exec(`INSERT INTO brands(id,name,slug,status) VALUES ('mer-brand','NETECO','mer-brand','published');
    INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES ('mer-tax','MER21','IVA',2100,'2020-01-01T00:00:00Z');
    INSERT INTO shipping_profiles(id,code,name,kind) VALUES ('mer-shipping','MER','Paquete','parcel');
    INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES ('mer-loc','MER-LOC','Almacén','warehouse',1,'${past}');`)
  function addProduct(spec: MerProductSpec) {
    const { n } = spec
    const id = merProduct(n)
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status,featured) VALUES (?,?,?,?,?,'mer-brand',?,?)"
      )
      .run(
        id,
        9200 + n,
        `Producto ${String.fromCharCode(64 + n)}`,
        `producto-${n}`,
        spec.category ?? MER_ROOT,
        spec.status ?? 'published',
        spec.featured ?? 0
      )
    sqlite
      .prepare(
        `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents,cost_net_cents,backorder_allowed)
         VALUES (?,?,?,'mer-tax','mer-shipping',?,'1 L','published',1210,?,?)`
      )
      .run(`mv-${n}`, 9200 + n, id, `MER-${n}`, spec.cost === undefined ? null : spec.cost, spec.backorder ? 1 : 0)
    sqlite
      .prepare(
        'INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at) VALUES (?,?,?,0,1,?,?)'
      )
      .run(`mv-${n}`, 'mer-loc', spec.stock ?? 10, past, past)
    return id
  }
  /** Synthetic paid order line (FKs off for the minimal row). */
  function paidPurchase(n: number, at: string, quantity = 1, paid = true) {
    const id = crypto.randomUUID()
    sqlite.exec('PRAGMA foreign_keys=OFF')
    sqlite
      .prepare(
        `INSERT INTO orders(id,cart_id,quote_id,shipping_quote_id,attempt_id,token_hash,status,reservation_id,reservation_expires_at,total_net_cents,total_tax_cents,total_gross_cents,shipping_net_cents,shipping_tax_cents,shipping_gross_cents,shipping_method_code,shipping_rate_version,shipping_eta_min_days,shipping_eta_max_days,contact_email,contact_email_hash,consent_tos,consent_privacy,correlation_id,created_at,updated_at)
         VALUES(?1,?1,?1,?1,?1,?2,'awaiting_payment','r',?3,500,0,500,0,0,0,'std',1,1,2,'b@example.invalid',?2,1,1,'c',?3,?3)`
      )
      .run(id, id.replaceAll('-', '').padEnd(64, 'a'), at)
    sqlite
      .prepare(
        `INSERT INTO order_lines(order_id,line_index,variant_id,sku,name,quantity,unit_gross_cents,net_cents,tax_cents,gross_cents,tax_rate_basis_points,price_version_id,location_id,created_at)
         VALUES(?1,0,?2,'SKU','Producto',?3,500,?5,0,?5,0,'pv','mer-loc',?4)`
      )
      .run(id, `mv-${n}`, quantity, at, 500 * quantity)
    sqlite
      .prepare('INSERT INTO order_payment_states(order_id,status,paid_gross_cents,updated_at) VALUES(?1,?2,500,?3)')
      .run(id, paid ? 'paid' : 'awaiting_payment', at)
    sqlite.exec('PRAGMA foreign_keys=ON')
  }
  return { sqlite, database: d1OverSqlite(sqlite), addProduct, paidPurchase }
}
