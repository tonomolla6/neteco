-- Migration: 0145_orders_procurement_split_contingency.sql
-- ORD-020 (P2): Pedidos con PO/centro de coste/aprobación. Exportables y visibles en factura.
-- ORD-021 (P2): Split/backorder por disponibilidad. Cliente acepta envíos parciales/costes; stock y facturación coherentes.
-- PAY-023 (P3): Proveedor alternativo por mercado/contingencia. Adaptador aislado; no se duplican reglas de pedido ni se fragmenta conciliación.

-- ---------------------------------------------------------------------------
-- ORD-020: Pedidos con PO, centro de coste y flujo de aprobación
-- ---------------------------------------------------------------------------

CREATE TABLE order_procurement_approvals (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  purchase_order_reference TEXT CHECK(
    purchase_order_reference IS NULL OR (
      length(purchase_order_reference) BETWEEN 1 AND 120
      AND purchase_order_reference = trim(purchase_order_reference)
      AND instr(purchase_order_reference, char(0)) = 0
      AND purchase_order_reference NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
    )
  ),
  cost_center TEXT CHECK(
    cost_center IS NULL OR (
      length(cost_center) BETWEEN 1 AND 80
      AND cost_center = trim(cost_center)
      AND instr(cost_center, char(0)) = 0
      AND cost_center NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || char(8232) || char(8233) || ']*')
    )
  ),
  approval_status TEXT NOT NULL DEFAULT 'not_required' CHECK(
    approval_status IN ('not_required', 'pending_approval', 'approved', 'rejected')
  ),
  requires_approval INTEGER NOT NULL DEFAULT 0 CHECK(requires_approval IN (0, 1)),
  approval_threshold_cents INTEGER CHECK(approval_threshold_cents IS NULL OR approval_threshold_cents >= 0),
  approved_by TEXT,
  approved_at TEXT CHECK(approved_at IS NULL OR approved_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', approved_at), '')),
  rejected_by TEXT,
  rejected_at TEXT CHECK(rejected_at IS NULL OR rejected_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', rejected_at), '')),
  rejection_reason TEXT CHECK(rejection_reason IS NULL OR length(trim(rejection_reason)) BETWEEN 1 AND 500),
  approval_notes TEXT CHECK(approval_notes IS NULL OR length(approval_notes) <= 1000),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE INDEX idx_order_procurement_status ON order_procurement_approvals(approval_status, created_at DESC);
CREATE INDEX idx_order_procurement_cc ON order_procurement_approvals(cost_center);

CREATE TABLE order_procurement_events (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('submitted', 'approval_requested', 'approved', 'rejected', 'cost_center_assigned', 'po_reference_assigned')),
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('customer', 'admin', 'system')),
  notes TEXT,
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_procurement_events_order ON order_procurement_events(order_id, created_at ASC);

CREATE TRIGGER order_procurement_events_no_update BEFORE UPDATE ON order_procurement_events
BEGIN
  SELECT RAISE(ABORT, 'order_procurement_events_immutable');
END;

CREATE TRIGGER order_procurement_events_no_delete BEFORE DELETE ON order_procurement_events
BEGIN
  SELECT RAISE(ABORT, 'order_procurement_events_immutable');
END;

CREATE TABLE order_invoice_procurement_metadata (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  invoice_id TEXT,
  purchase_order_reference TEXT,
  cost_center TEXT,
  visible_on_invoice INTEGER NOT NULL DEFAULT 1 CHECK(visible_on_invoice IN (0, 1)),
  exported_at TEXT CHECK(exported_at IS NULL OR exported_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', exported_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

-- ---------------------------------------------------------------------------
-- ORD-021: Split / backorder por disponibilidad y facturación coherente
-- ---------------------------------------------------------------------------

CREATE TABLE order_split_shipment_preferences (
  order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  customer_accepts_split INTEGER NOT NULL DEFAULT 0 CHECK(customer_accepts_split IN (0, 1)),
  accepted_extra_shipping_cents INTEGER NOT NULL DEFAULT 0 CHECK(accepted_extra_shipping_cents >= 0),
  shipping_cost_payer TEXT NOT NULL DEFAULT 'merchant' CHECK(shipping_cost_payer IN ('merchant', 'customer')),
  customer_consent_at TEXT NOT NULL CHECK(customer_consent_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', customer_consent_at), '')),
  customer_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

CREATE TABLE order_split_shipments (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shipment_number INTEGER NOT NULL CHECK(shipment_number >= 1),
  shipment_type TEXT NOT NULL CHECK(shipment_type IN ('immediate', 'backorder')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'picking', 'shipped', 'delivered', 'cancelled')),
  tracking_number TEXT,
  carrier TEXT,
  estimated_delivery_at TEXT CHECK(estimated_delivery_at IS NULL OR estimated_delivery_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', estimated_delivery_at), '')),
  estimated_restock_at TEXT CHECK(estimated_restock_at IS NULL OR estimated_restock_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', estimated_restock_at), '')),
  shipping_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK(shipping_cost_cents >= 0),
  shipped_at TEXT CHECK(shipped_at IS NULL OR shipped_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', shipped_at), '')),
  delivered_at TEXT CHECK(delivered_at IS NULL OR delivered_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', delivered_at), '')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), '')),
  UNIQUE(order_id, shipment_number)
) STRICT;

CREATE INDEX idx_split_shipments_order ON order_split_shipments(order_id, shipment_number ASC);

CREATE TABLE order_split_shipment_items (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  shipment_id TEXT NOT NULL REFERENCES order_split_shipments(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL CHECK(line_index >= 0),
  variant_id TEXT NOT NULL,
  quantity_requested INTEGER NOT NULL CHECK(quantity_requested > 0),
  quantity_allocated INTEGER NOT NULL CHECK(quantity_allocated >= 0),
  quantity_backordered INTEGER NOT NULL CHECK(quantity_backordered >= 0),
  unit_gross_cents INTEGER NOT NULL CHECK(unit_gross_cents >= 0),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_split_shipment_items ON order_split_shipment_items(shipment_id, line_index);

CREATE TABLE order_split_billing_reconciliation (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shipment_id TEXT REFERENCES order_split_shipments(id),
  invoice_number TEXT NOT NULL,
  amount_net_cents INTEGER NOT NULL CHECK(amount_net_cents >= 0),
  tax_cents INTEGER NOT NULL CHECK(tax_cents >= 0),
  shipping_cents INTEGER NOT NULL CHECK(shipping_cents >= 0),
  total_gross_cents INTEGER NOT NULL CHECK(total_gross_cents >= 0),
  status TEXT NOT NULL CHECK(status IN ('draft', 'issued', 'reconciled', 'credited')),
  reconciled_with_capture INTEGER NOT NULL DEFAULT 1 CHECK(reconciled_with_capture IN (0, 1)),
  notes TEXT,
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), ''))
) STRICT;

CREATE INDEX idx_split_billing_order ON order_split_billing_reconciliation(order_id, invoice_number);

-- ---------------------------------------------------------------------------
-- PAY-023: Proveedor alternativo por mercado y contingencia
-- ---------------------------------------------------------------------------

CREATE TABLE payment_contingency_routing (
  id TEXT PRIMARY KEY CHECK(length(id) <= 64),
  market_code TEXT NOT NULL UNIQUE CHECK(length(market_code) BETWEEN 2 AND 10),
  primary_provider TEXT NOT NULL CHECK(primary_provider IN ('redsys', 'euro_contingency')),
  alternative_provider TEXT NOT NULL CHECK(alternative_provider IN ('redsys', 'euro_contingency')),
  active_provider TEXT NOT NULL CHECK(active_provider IN ('redsys', 'euro_contingency')),
  contingency_active INTEGER NOT NULL DEFAULT 0 CHECK(contingency_active IN (0, 1)),
  contingency_reason TEXT,
  contingency_activated_at TEXT CHECK(contingency_activated_at IS NULL OR contingency_activated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', contingency_activated_at), '')),
  contingency_activated_by TEXT,
  failure_count_window INTEGER NOT NULL DEFAULT 0 CHECK(failure_count_window >= 0),
  circuit_state TEXT NOT NULL DEFAULT 'closed' CHECK(circuit_state IN ('closed', 'open', 'half_open')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  updated_at TEXT NOT NULL CHECK(updated_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', updated_at), ''))
) STRICT;

-- Default routing for ES
INSERT OR IGNORE INTO payment_contingency_routing (
  id, market_code, primary_provider, alternative_provider, active_provider,
  contingency_active, contingency_reason, failure_count_window, circuit_state,
  version, created_at, updated_at
) VALUES (
  'route-es', 'ES', 'redsys', 'euro_contingency', 'redsys',
  0, NULL, 0, 'closed',
  1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z'
);

CREATE TABLE payment_unified_settlement_reconciliation (
  id TEXT PRIMARY KEY CHECK(length(id) = 36 AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'),
  intent_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('redsys', 'euro_contingency')),
  provider_reference TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL CHECK(currency = 'EUR'),
  status TEXT NOT NULL CHECK(status IN ('authorized', 'captured', 'refunded', 'settled', 'discrepancy')),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  settled_at TEXT CHECK(settled_at IS NULL OR settled_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', settled_at), '')),
  reconciled_at TEXT NOT NULL CHECK(reconciled_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', reconciled_at), '')),
  created_at TEXT NOT NULL CHECK(created_at = COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', created_at), '')),
  UNIQUE(provider, provider_reference)
) STRICT;

CREATE INDEX idx_unified_settlement_order ON payment_unified_settlement_reconciliation(order_id, reconciled_at DESC);
CREATE INDEX idx_unified_settlement_provider ON payment_unified_settlement_reconciliation(provider, status);
