# Medición, comunicación y marketing responsable

## Taxonomía mínima versionada `v1`

| Evento                     | Trigger autoritativo     | IDs/propiedades                                  | PII prohibida           |
| -------------------------- | ------------------------ | ------------------------------------------------ | ----------------------- |
| `catalog_viewed`           | listado SSR mostrado     | session, category, page, result_count            | query libre sin sanear  |
| `search_completed`         | API responde             | session, normalized_query, result_count, latency | email, teléfono, NIF    |
| `product_viewed`           | PDP                      | session, product, variant opcional               | cualquier dato cliente  |
| `cart_item_added/removed`  | mutación cart confirmada | event, cart, variant, qty, quote_version         | tokens de acceso        |
| `checkout_started`         | estado server-side       | session, cart, total, delivery methods           | dirección/contacto      |
| `payment_initiated`        | intento persistido       | order, payment, amount, method                   | payload/firma/PAN       |
| `payment_confirmed/failed` | callback verificado      | order, payment, response class                   | códigos sensibles       |
| `order_confirmed`          | transición de pedido     | order, total, tax, shipping                      | PII/factura PDF         |
| `refund_confirmed`         | proveedor + ledger       | order, refund, amount                            | motivo libre sin sanear |
| `shipment_status_changed`  | inbox carrier            | order, shipment, normalized status               | dirección/POD           |
| `web_vital`                | navegador con opt-in     | LCP/CLS/INP, rating, path sin query, navegación  | URL completa, user ID   |

`event_id` es UUID único; cliente y servidor deduplican por ese ID. La compra solo nace del servidor tras pago/pedido válido. Versiones incompatibles crean una nueva versión de taxonomía.

RUM usa `PerformanceObserver`, nunca carga un tercero y solo envía LCP/CLS/INP tras consentimiento analítico. La ruta excluye query strings; crawlers, Lighthouse y PageSpeed se descartan antes de crear el identificador anónimo.

## Política responsable

- Prohibidos urgencia, escasez, testimonios, contadores o stock falsos.
- Precio, IVA, unidad, MOQ, portes y condiciones se muestran antes de pagar.
- Ningún opt-in de marketing aparece premarcado o agrupado con términos necesarios.
- Todo descuento conserva precio anterior válido, vigencia, exclusiones, uso y margen.
- Banners/modales tienen owner, objetivo, segmentación, frecuencia, preview, métricas y fecha de retirada; nunca interrumpen checkout.
- Comunicación transaccional y marketing usan dominios, credenciales, listas y suppression separados.

## Newsletter y doble opt-in

La captación pública, el registro, el checkout y el centro de cuenta crean una solicitud `pending`. La preferencia no
se activa ni se registra un consentimiento concedido hasta que la persona usa el enlace de confirmación, válido durante
48 horas. Los tokens se guardan únicamente como HMAC; los sobres necesarios para generar enlaces se cifran con
`AUTH_ENCRYPTION_KEY`.

Cada confirmación registra versión, hash del texto mostrado, fuente, fecha y auditoría. Cada email comercial incluye una
baja pública sin login. La baja desactiva la preferencia, registra retirada y crea una supresión inmediata; no bloquea
confirmaciones de identidad, pedidos, seguridad o soporte. Rebotes duros, quejas y supresiones manuales o legales tienen
precedencia y no se eliminan al volver a solicitar la newsletter.

En producción el worker exige `MARKETING_EMAIL_PROVIDER=smtp` y sus propias variables `MARKETING_SMTP_*` y
`MARKETING_EMAIL_FROM`. No cae por defecto sobre las credenciales `SMTP_*` transaccionales.
