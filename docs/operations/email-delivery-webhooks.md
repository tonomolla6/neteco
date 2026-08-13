# Webhooks de entrega de correo

El proveedor debe enviar `POST /api/webhooks/email` con el cuerpo JSON exacto firmado en
`x-neteco-email-signature: sha256=<HMAC-SHA256 hexadecimal>`. La clave es `EMAIL_WEBHOOK_SECRET` y debe tener al menos
24 caracteres.

El cuerpo contractual contiene `provider`, `eventId`, `providerMessageId`, `type` (`delivered`, `hard_bounce` o
`complaint`) y `occurredAt` ISO-8601. No debe contener la dirección de correo ni contenido del mensaje.

Los eventos se deduplican por proveedor e ID, actualizan la evidencia de entrega y crean una supresión inmediata para
rebotes duros y quejas. El worker consulta esa lista antes de cada envío y deja evidencia `suppressed` sin contactar al
proveedor. La rotación de la clave exige solape coordinado con el proveedor; se valida primero en staging.

Un evento que llega antes de que se persista la aceptación se responde como no encontrado y queda `failed`; el proveedor
debe reintentarlo con el mismo ID. Ese reintento puede recuperar la fila fallida, pero un evento ya procesado sigue siendo
idempotente. `complaint` y `hard_bounce` no se degradan por una entrega tardía; una supresión manual o legal nunca se
sobrescribe desde un webhook.
