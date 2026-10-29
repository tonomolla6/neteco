import { stableUuid, sqlText } from './d1-category-seed'

const SEED_TIMESTAMP = '2026-08-12T00:00:00Z'

interface ZoneSeed {
  code: string
  name: string
  kind: 'warehouse_pickup' | 'own_delivery' | 'parcel_peninsular'
  prefixes: string[]
}

const ZONES: ZoneSeed[] = [
  { code: 'pickup', kind: 'warehouse_pickup', name: 'Recogida almacén Ontinyent', prefixes: [] },
  { code: 'own-delivery', kind: 'own_delivery', name: 'Reparto propio Ontinyent', prefixes: ['468'] },
  { code: 'parcel-peninsular', kind: 'parcel_peninsular', name: 'Paquetería peninsular', prefixes: ['peninsular'] }
]

interface RateSeed {
  id: string
  zone: string
  method: 'pickup' | 'own_delivery' | 'parcel'
  profile: 'parcel' | 'pallet' | 'adr'
  netCents: number
  etaMin: number
  etaMax: number
}

const RATES: RateSeed[] = [
  { etaMax: 0, etaMin: 0, id: 'rate-pickup-parcel', method: 'pickup', netCents: 0, profile: 'parcel', zone: 'pickup' },
  {
    etaMax: 2,
    etaMin: 1,
    id: 'rate-own-parcel',
    method: 'own_delivery',
    netCents: 0,
    profile: 'parcel',
    zone: 'own-delivery'
  },
  {
    etaMax: 5,
    etaMin: 3,
    id: 'rate-parcel-peninsular',
    method: 'parcel',
    netCents: 495,
    profile: 'parcel',
    zone: 'parcel-peninsular'
  },
  {
    etaMax: 7,
    etaMin: 4,
    id: 'rate-parcel-pallet',
    method: 'parcel',
    netCents: 4900,
    profile: 'pallet',
    zone: 'parcel-peninsular'
  },
  {
    etaMax: 9,
    etaMin: 5,
    id: 'rate-parcel-adr',
    method: 'parcel',
    netCents: 9900,
    profile: 'adr',
    zone: 'parcel-peninsular'
  }
]

export function shippingZoneId(code: string) {
  return stableUuid(`shipping-zone:${code}`)
}

export function renderD1ShippingSeed() {
  const statements = ['BEGIN TRANSACTION;']
  for (const zone of ZONES) {
    statements.push(`INSERT INTO shipping_zones (id, code, name, kind, postal_prefixes, active, created_at)
VALUES (${sqlText(shippingZoneId(zone.code))}, '${zone.code}', ${sqlText(zone.name)}, '${zone.kind}',
        ${sqlText(JSON.stringify(zone.prefixes))}, 1, ${sqlText(SEED_TIMESTAMP)})
ON CONFLICT (id) DO UPDATE SET
  code = excluded.code,
  name = excluded.name,
  kind = excluded.kind,
  postal_prefixes = excluded.postal_prefixes,
  active = excluded.active;`)
  }
  for (const rate of RATES) {
    const id = stableUuid(`shipping-rate:${rate.id}`)
    statements.push(`INSERT INTO shipping_rates (
  id, zone_id, method_code, service_profile, net_cents, tax_rate_basis_points,
  eta_min_days, eta_max_days, rate_version, active, created_at
) VALUES (
  ${sqlText(id)}, ${sqlText(shippingZoneId(rate.zone))}, '${rate.method}', '${rate.profile}',
  ${rate.netCents}, 2100, ${rate.etaMin}, ${rate.etaMax}, 1, ${rate.profile === 'adr' ? 0 : 1}, ${sqlText(SEED_TIMESTAMP)}
)
ON CONFLICT (id) DO UPDATE SET
  zone_id = excluded.zone_id,
  method_code = excluded.method_code,
  service_profile = excluded.service_profile,
  net_cents = excluded.net_cents,
  tax_rate_basis_points = excluded.tax_rate_basis_points,
  eta_min_days = excluded.eta_min_days,
  eta_max_days = excluded.eta_max_days,
  rate_version = excluded.rate_version,
  active = excluded.active;`)
  }
  statements.push('COMMIT;')
  return `${statements.join('\n\n')}\n`
}
