-- Nunca se dice «sin stock» (feedback de Tono, 2026-11-12): lo que no está en el almacén se
-- vende con su plazo de reposición (variants.lead_time_days o el plazo por defecto de la
-- tienda). Las variantes existentes y las nuevas admiten pedido sin existencias.

ALTER TABLE variants ALTER COLUMN backorder_allowed SET DEFAULT true;
UPDATE variants SET backorder_allowed = true WHERE backorder_allowed = false;
