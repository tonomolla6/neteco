# Webhooks de entrega de correo

El proveedor debe enviar `POST /api/webhooks/email` con el cuerpo JSON exacto firmado en
`x-neteco-email-signature: sha256=<HMAC-SHA256 hexadecimal>`. La clave es `EMAIL_WEBHOOK_SECRET` y debe tener al menos
24 caracteres.

El cuerpo contractual contiene `provider`, `eventId`, `providerMessageId`, `type` (`delivered`, `hard_bounce` o
`complaint`) y `occurredAt` ISO-8601. No debe contener la dirección de correo ni contenido del mensaje.

Los eventos se deduplican por proveedor e ID, actualizan la evidencia de entrega y crean una supresión inmediata para
rebotes duros y quejas. La rotación de la clave exige solape coordinado con el proveedor; se valida primero en staging.
