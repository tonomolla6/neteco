import { readFile } from 'node:fs/promises'
import { d1OverSqlite, openMigratedDatabase } from './d1-sqlite'
import { testNow } from './deterministic'

export const INVENTORY_FIXTURE_ACTOR = '10000000-0000-4000-8000-000000000041'
export const INVENTORY_FIXTURE_SESSION = '20000000-0000-4000-8000-000000000041'
export const INVENTORY_FIXTURE_PRODUCT = '30000000-0000-4000-8000-000000000041'
export const INVENTORY_FIXTURE_VARIANT = '40000000-0000-4000-8000-000000000041'
export const inventoryFixtureUtc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
/** Explicit ephemeral test data only. Never imported by runtime or real seed.
 * No publication policy, rights, scanner approval or approved price is created. */
export async function openAdminInventoryFixture() {
  const sqlite = await openMigratedDatabase()
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='inventory_admin_commands'").get())
    sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0041_admin_inventory_commands.sql', import.meta.url), 'utf8')
    )
  sqlite.limits.exprDepth = 100
  sqlite.limits.variableNumber = 100
  sqlite.limits.functionArg = 32
  sqlite.exec(`INSERT INTO categories(id,legacy_id,name,slug,status) VALUES('category',1,'Synthetic category','synthetic-category','draft');
    INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES('tax','SYNTHETIC','Synthetic',2100,'2020-01-01T00:00:00Z');
    INSERT INTO shipping_profiles(id,code,name,kind) VALUES('ship','SYNTHETIC','Synthetic','parcel');
    INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES('${INVENTORY_FIXTURE_PRODUCT}',1,'category','Synthetic draft','synthetic-draft','draft');
    INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock)
      VALUES('${INVENTORY_FIXTURE_VARIANT}',11,'${INVENTORY_FIXTURE_PRODUCT}','tax','ship','SYNTHETIC-SKU','Caja','draft','ud',0,2);
    INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES('main','MAIN','Synthetic only warehouse','warehouse',1,'2020-01-01T00:00:00Z');
    INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
      VALUES('${INVENTORY_FIXTURE_VARIANT}','main',20,1,1,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');
    INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,reference_id,idempotency_key,correlation_id,created_at)
      VALUES('initial','${INVENTORY_FIXTURE_VARIANT}','main','initial',20,0,'synthetic',NULL,'initial','synthetic','2020-01-01T00:00:00Z');
    INSERT INTO roles VALUES('warehouse','Warehouse operator','Synthetic local operator');
    INSERT INTO permissions VALUES('inventory.read','inventory','read','Synthetic');
    INSERT INTO permissions VALUES('inventory.write','inventory','write','Synthetic');
    INSERT INTO role_permissions VALUES('warehouse','inventory.read'),('warehouse','inventory.write');`)
  for (const suffix of ['41', '42']) {
    const id = `10000000-0000-4000-8000-0000000000${suffix}`,
      session = `20000000-0000-4000-8000-0000000000${suffix}`
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?)"
      )
      .run(
        id,
        `${id}@example.invalid`,
        inventoryFixtureUtc(-3600000),
        inventoryFixtureUtc(-3600000),
        inventoryFixtureUtc(-3600000)
      )
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
      )
      .run(session, id, inventoryFixtureUtc(-3600000), inventoryFixtureUtc(3600000))
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'warehouse',?)")
      .run(id, inventoryFixtureUtc(-3600000))
  }
  return { sqlite, database: d1OverSqlite(sqlite) }
}
