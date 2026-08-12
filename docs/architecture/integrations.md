# Catálogo de integraciones

| Proveedor           | Contrato                 | Datos                                                         | Auth                        | Timeout/retry                                | Sandbox y owner                |
| ------------------- | ------------------------ | ------------------------------------------------------------- | --------------------------- | -------------------------------------------- | ------------------------------ |
| Redsys              | `PaymentProvider`        | referencia, importe, moneda, método, respuesta; nunca PAN/CVC | clave HMAC por terminal     | 5 s; reconciliación, no retry ciego de cobro | Redsys test; Finanzas          |
| Beply API v3        | `InvoiceProvider`        | cliente fiscal y snapshot de pedido                           | `Token` server-side         | 10 s; red/5xx con backoff, 4xx a corrección  | instancia test; Administración |
| Carrier externo     | `CarrierProvider`        | dirección, bultos, etiqueta y tracking                        | credencial scoped           | rate 4 s, label 10 s; circuit breaker        | sandbox contractual; Logística |
| Reparto propio      | `CarrierProvider`        | CP, ruta, ventana, POD minimizada                             | rol operativo               | local; no retry destructivo                  | datos demo; Logística          |
| Email transaccional | `EmailProvider`          | plantilla y destinatario                                      | token separado de marketing | 8 s, reintento + suppression                 | Mailpit/allowlist; Soporte     |
| Object storage      | `ObjectStorageProvider`  | media, PDFs y exports                                         | identidad de workload       | multipart, checksum y AV                     | bucket aislado; Producto       |
| Redis               | infraestructura derivada | locks, cuotas, caché, trabajos                                | TLS/ACL                     | fallback seguro por capacidad                | contenedor local; Plataforma   |

Cada operación externa lleva `correlation_id` e `idempotency_key`. El inbox conserva hash y datos saneados; el outbox usa lease, límite de intentos y estado `dead`. Ningún entorno no productivo puede resolver endpoints o credenciales productivas.
