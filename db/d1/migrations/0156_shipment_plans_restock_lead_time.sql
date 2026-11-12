-- Plan de envíos por pedido y plazo de reposición (feedback de Tono, 2026-11-12).
--
-- 1. Nunca se dice «sin stock»: lo que no está en el almacén se vende con su plazo de
--    reposición. El plazo es el de la variante (variants.lead_time_days) y, si no tiene,
--    el plazo por defecto de la tienda (fulfillment_lead_time_policy.restock_default_days).
-- 2. El cliente elige en el checkout recibir todo junto o un envío por plazo. El plan
--    aceptado se guarda inmutable con el pedido.

CREATE TABLE fulfillment_lead_time_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Días naturales de reposición para variantes sin lead_time_days propio.
  restock_default_days INTEGER NOT NULL DEFAULT 7 CHECK (restock_default_days BETWEEN 1 AND 365),
  -- 1: las variantes nuevas y las existentes se venden sin existencias, con plazo.
  sell_without_stock INTEGER NOT NULL DEFAULT 1 CHECK (sell_without_stock IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO fulfillment_lead_time_policy (id, restock_default_days, sell_without_stock, updated_at)
VALUES (1, 7, 1, '2026-11-12T00:00:00Z');

-- Las variantes que hoy se quedarían «agotadas» pasan a servirse con plazo de reposición.
UPDATE variants SET backorder_allowed = 1 WHERE backorder_allowed = 0;

CREATE TABLE order_shipment_plans (
  order_id TEXT NOT NULL REFERENCES orders(id),
  shipment_index INTEGER NOT NULL CHECK (shipment_index >= 0),
  mode TEXT NOT NULL CHECK (mode IN ('together', 'split')),
  lead_days INTEGER NOT NULL CHECK (lead_days BETWEEN 0 AND 365),
  eta_from TEXT,
  eta_to TEXT,
  net_cents INTEGER NOT NULL CHECK (net_cents >= 0),
  tax_cents INTEGER NOT NULL CHECK (tax_cents >= 0),
  gross_cents INTEGER NOT NULL CHECK (gross_cents = net_cents + tax_cents),
  lines_json TEXT NOT NULL CHECK (json_valid(lines_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (order_id, shipment_index)
);
