# Emails y notificaciones

## Matriz Alpha

Alpha soporta exclusivamente `es-ES`. Cada payload puede declararlo con `locale`; si falta se usa `es-ES` y cualquier otro valor se rechaza, en vez de enviar una mezcla de idiomas. Todas las plantillas producen asunto, HTML escapado y una versión de texto plano.

| Eventos                                                                                                       | Trigger/owner                     | Datos obligatorios                                              |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `identity.verification.requested`, `identity.password_reset.requested`, `identity.email_change.requested`     | cuenta / Identidad                | destinatario, token cifrado, caducidad                          |
| `identity.security.password_changed`, `identity.security.email_changed`                                       | cambio sensible / Identidad       | destinatario                                                    |
| `order.created`, `order.confirmed`                                                                            | pedido/pago / Comercio            | destinatario, número, total; token de acceso si compra invitada |
| `order.status.updated`, `order.cancelled`, `order.cancellation.requested`, `order.shipped`, `order.delivered` | operación logística / Operaciones | destinatario, número, estado; tracking cuando exista            |
| `order.reservation.expired`                                                                                   | worker de reservas / Operaciones  | destinatario y número                                           |
| `refund.succeeded.email`                                                                                      | worker de reembolso / Finanzas    | destinatario, número e importe                                  |
| `return.requested`, `return.status.updated`                                                                   | devolución / Soporte              | destinatario, pedido, devolución y estado                       |
| `support.ticket.received`, `support.ticket.reply`                                                             | soporte / Soporte                 | destinatario, referencia y cuerpo de respuesta cuando aplique   |
| `invoice.issued`                                                                                              | worker fiscal / Finanzas          | destinatario, factura, pedido, código, token y caducidad        |
| `newsletter.confirmation.requested`, `newsletter.welcome`                                                     | double opt-in / Marketing         | destinatario y token/caducidad de confirmación o baja           |

La lista ejecutable `transactionalEmailEventTypes` es compartida por el `claim` del worker, el renderer y las pruebas. Esto evita que un trigger documentado quede pendiente por olvidar una lista SQL; la prueba integrada recorre los 21 eventos.

## Contrato de contenido

Las pruebas comprueban por cada evento destinatario, asunto, HTML y texto plano no vacíos, datos obligatorios y error ante payload incompleto. Las acciones verifican enlaces públicos en ambas versiones y que nunca aparece el envelope cifrado. Campos hostiles de nombre, pedido, estado, tracking, devolución, referencia y respuesta se escapan en HTML; SMTP rechaza CR/LF en From, To, Subject y cabeceras.

Factura y enlaces de identidad tienen caducidad; newsletter incluye baja pública y `List-Unsubscribe`. Los triggers se prueban en PostgreSQL real: primera ejecución crea una entrega por evento y el replay no vuelve a reclamar eventos completados.

## Seguridad fuera de producción

`log` sigue siendo el provider predeterminado. Si un entorno no productivo habilita SMTP, debe declarar simultáneamente:

- `SMTP_ALLOWED_HOSTS` y `EMAIL_ALLOWED_RECIPIENTS` para email transaccional.
- `MARKETING_SMTP_ALLOWED_HOSTS` y `MARKETING_EMAIL_ALLOWED_RECIPIENTS` para marketing.

Las listas son CSV; los destinatarios admiten dirección exacta o un dominio sintético como `*@integration.invalid`. La ausencia o el desacuerdo bloquean antes de `sendMail`. Producción no usa estas listas porque debe entregar a clientes reales, pero exige SMTP y credenciales/configuración separadas para marketing.

## Deduplicación y fallo ambiguo

El outbox tiene `idempotency_key` único, cada evento conserva un `Message-ID` estable y `communication_deliveries` impide más de una fila por evento y por ID del proveedor. Esto deduplica triggers y replays observables por la aplicación.

SMTP no ofrece exactamente-once: si el servidor acepta DATA y el proceso muere antes de persistir la entrega, un retry puede reenviar el mismo `Message-ID`. Por ello la semántica declarada es al menos una vez con identificador estable, suppression y reconciliación de webhooks; no se afirma una garantía que el protocolo no proporciona.

## Gates

- Unitarios: `tests/unit/transactional-email.test.ts`, `email-provider.test.ts`, `invoice-email.test.ts` y `newsletter-email.test.ts`.
- Integración: `tests/integration/email-notifications.test.ts`, recuperación SMTP y double opt-in.
- E2E: triggers de cuenta, compra, fulfillment, devoluciones, webhook y suppression.

Forman parte de `coverage`, `test:integration` y los journeys E2E normales de CI; no se repiten en un job redundante.
