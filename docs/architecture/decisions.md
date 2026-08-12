# Decisiones fundacionales de NETECO

Estado: aceptadas como baseline técnico para MVP. Las decisiones comerciales o legales indicadas deben ser ratificadas por la persona responsable antes de habilitar producción.

## Fuentes de verdad

| Dato                                  | Maestro                       | Réplicas permitidas                         | Regla                                                                |
| ------------------------------------- | ----------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| Producto, variante, atributos y media | NETECO PIM                    | Feed, búsqueda, Beply                       | Los cambios de proveedor entran en cuarentena; nunca publican solos. |
| Precio comercial, IVA y promoción     | NETECO                        | Pedido, Redsys, Beply, analítica            | El pedido conserva snapshot de la versión aplicada.                  |
| Carrito y pedido                      | NETECO                        | Cliente, Beply, carrier                     | UUID interno inmutable y referencia pública separada.                |
| Pago                                  | NETECO con evidencia Redsys   | Beply                                       | Solo una notificación válida puede confirmar el pago.                |
| Documento fiscal                      | Beply                         | NETECO guarda ID, estado, código y checksum | Una factura emitida no se edita en NETECO.                           |
| Stock ecommerce                       | NETECO                        | Panel, storefront, carrier                  | Todo cambio nace en el ledger; frecuencia de reconciliación diaria.  |
| Tracking                              | Carrier normalizado en NETECO | Cliente y soporte                           | Inbox deduplica eventos del proveedor.                               |
| Consentimiento                        | NETECO/CMP                    | Proveedor de marketing                      | Historial append-only por finalidad, canal, texto y versión.         |

## Momento fiscal

Baseline técnico: crear el evento de facturación tras `payment=captured` y `order=confirmed`; las transferencias se facturan al conciliar el cobro. Los pedidos cuyo tratamiento fiscal dependa de entrega, anticipo, rectificación u otra casuística se mantienen en `fiscal_pending`. Esta decisión debe ser ratificada por asesoría y configurada por tipo de operación, sin cambiar código.

## Arquitectura

- Monolito modular Nuxt/Nitro en contenedor inmutable.
- PostgreSQL es la única persistencia productiva; Redis se limita a caché, rate limiting, locks y colas derivadas.
- Los cambios críticos se confirman en PostgreSQL junto a un evento outbox.
- Toda integración implementa un contrato de proveedor, idempotencia, timeout, reintento selectivo, inbox/outbox y DLQ.
- Los IDs internos son UUID; SKU, slug, número de pedido y referencias externas son identificadores separados.
- Las migraciones son forward-only, ordenadas, con checksum y lock asesor de PostgreSQL.

## Entornos

`local`, `test`, `preview`, `demo`, `staging` y `production` usan bases, claves y endpoints distintos. Los cuatro primeros solo permiten proveedores mock/sandbox y datos sintéticos. Producción falla al arrancar si Redsys, Beply o carrier no están configurados con un modo permitido.
