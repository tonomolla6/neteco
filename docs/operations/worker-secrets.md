# Inventario y gobernanza de secretos del Cloudflare Worker

Este documento define el inventario completo, formato criptográfico, dependencias de ejecución y procedimiento de aprovisionamiento de secretos para el Cloudflare Worker de Neteco (`workers/canary.ts` y subcomponentes).

## 1. Principios de seguridad y aislamiento

1. **Sin secretos en claro en `vars`**: Conforme a la regla de gobernanza `NO_PLAINTEXT_SECRETS_IN_VARS` (`workers/release/cloudflare-policy.ts`), ninguna clave, pepper, token o credencial se almacena en variables de entorno públicas (`vars`). Todos los valores sensibles se inyectan como Worker Secrets mediante `wrangler secret put`.
2. **Aislamiento de entornos y prohibición sobre Beply**: Está estrictamente prohibido apuntar scripts de aprovisionamiento, pruebas automáticas o valores aleatorios contra `neteco.beply.es` (producción de Beply). Cualquier ejecución que contenga `beply` en el nombre del Worker es rechazada automáticamente.
3. **Paso por STDIN sin persistencia**: Los secretos nunca se imprimen en consola, nunca se escriben en disco ni se almacenan en repositorios Git. Con `--apply`, los valores generados criptográficamente se transmiten a Wrangler exclusivamente por STDIN.
4. **Respuesta Fail-Closed**: Cuando falta un secreto obligatorio, los módulos correspondientes responden con `503 Service Unavailable` (`security_configuration_missing`, `service_unavailable`, etc.) o `500 Internal Error`, impidiendo cualquier bypass de seguridad o uso de valores por defecto inseguros.

---

## 2. Inventario completo de secretos del Worker

| Secreto                            | Módulo consumidor                                                                                             | Efecto si falta                                                                                                                                            | Cómo generarlo                                                                                                                                                                                  | Estado                                                  |
| :--------------------------------- | :------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------ |
| `NETECO_API_KEY_PEPPER`            | `workers/security/b2b-api-keys.ts` vía `workers/canary.ts`                                                    | **503** (`security_configuration_missing`) en auth, creación y rotación de claves B2B API (`/api/admin/security-controls/api-keys/*`, `/api/b2b/v1/ping`). | 32 bytes aleatorios en base64url (`crypto.randomBytes(32).toString('base64url')`). Longitud ≥ 32 caracteres.                                                                                    | **NUEVO** en esta tanda                                 |
| `NETECO_DEVICE_OFFLINE_MASTER_KEY` | `workers/security/offline-bundle.ts` vía `workers/canary.ts`                                                  | **503** (`security_configuration_missing`) al empaquetar paquetes offline de almacén (`/api/devices/v1/offline-bundle`).                                   | 32 bytes aleatorios en base64url (`crypto.randomBytes(32).toString('base64url')`). Longitud ≥ 32 caracteres. Clave base HKDF.                                                                   | **NUEVO** en esta tanda                                 |
| `NETECO_ABUSE_SUBJECT_PEPPER`      | `workers/security/abuse-detection.ts` vía `workers/canary.ts`                                                 | **503** (`security_configuration_missing`) al evaluar anomalías o fraudes (`/api/admin/security-controls/abuse/assess`).                                   | 32 bytes aleatorios en base64url (`crypto.randomBytes(32).toString('base64url')`). Longitud ≥ 32 caracteres. HMAC SHA-256.                                                                      | **NUEVO** en esta tanda                                 |
| `REDSYS_SECRET_KEY`                | `workers/payments/`, `workers/runtime/customer-operations-config.ts`                                          | Pasarela Redsys y reembolsos deshabilitados (proveedor nulo / 503).                                                                                        | Clave comercial proporcionada por el banco/Redsys (producción/sandbox). Para pruebas sintéticas aisladas: 32 bytes aleatorios en base64 (`crypto.randomBytes(32).toString('base64')`).          | **Preexistente** (declarado en `wrangler.canary.jsonc`) |
| `NUXT_SESSION_PASSWORD`            | `workers/auth/session-cookie.ts`, `workers/canary.ts`, `workers/shop.ts`                                      | **503** (`service_unavailable`). Bloquea autenticación de sesiones, cookies administrativas y de clientes.                                                 | 48 bytes aleatorios en hex (`crypto.randomBytes(48).toString('hex')`) o 32 bytes base64url. Longitud ≥ 32.                                                                                      | **Preexistente** (declarado en `wrangler.canary.jsonc`) |
| `AUTH_RATE_LIMIT_PEPPER`           | `workers/auth/edge-limit.ts`, `workers/canary.ts`, `workers/shop.ts`                                          | **503** (`service_unavailable`). Falla el cómputo de huella IP/identidad para rate limiting en el borde.                                                   | 48 bytes aleatorios en hex (`crypto.randomBytes(48).toString('hex')`).                                                                                                                          | **Preexistente** (declarado en `wrangler.canary.jsonc`) |
| `AUTH_TOKEN_PEPPER`                | `workers/auth/`, `workers/runtime/product-watch.ts`, `workers/canary.ts`                                      | **503** (`service_unavailable`). Verificación de tokens temporales de acceso, magic links y watches de producto fallan.                                    | 48 bytes aleatorios en hex (`crypto.randomBytes(48).toString('hex')`).                                                                                                                          | **Preexistente** (declarado en `wrangler.canary.jsonc`) |
| `AUTH_ENCRYPTION_KEY`              | `server/utils/secrets.ts`, `workers/canary.ts`                                                                | **500** (`AUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key`). Falla cifrado de credenciales MFA y tokens de identidad.                             | 32 bytes aleatorios en base64 (`crypto.randomBytes(32).toString('base64')`). Exactamente 32 bytes binarios decodificados.                                                                       | **Preexistente** (declarado en `wrangler.canary.jsonc`) |
| `NEWSLETTER_HMAC_KEY`              | `workers/runtime/customer-operations-config.ts`, `workers/marketing/`                                         | **503** / feature off. Firmas HMAC para alta y baja de suscripciones al boletín quedan deshabilitadas.                                                     | 32 bytes aleatorios en base64url (`crypto.randomBytes(32).toString('base64url')`). Exactamente 43 caracteres ASCII, no homogéneos (`!/^A{43}$/`).                                               | **Preexistente** (declarado en `wrangler.canary.jsonc`) |
| `MEDIA_SCAN_SECRET`                | `workers/media/governance-http.ts`, `workers/media/governance.ts`                                             | **503** (`scan_unavailable`) al recibir recibos de escaneo de antivirus/malware de medios (`/api/admin/media/scan-receipt`).                               | 48 bytes aleatorios en hex (`crypto.randomBytes(48).toString('hex')`). Longitud ≥ 32 bytes, diferente de password/pepper.                                                                       | **Preexistente** (declarado en `wrangler.canary.jsonc`) |
| `CMS_PREVIEW_SECRET`               | `workers/runtime/operations-config.ts`                                                                        | Feature off: visualización de borradores CMS en previsualización desactivada; solo contenido publicado es visible.                                         | 48 bytes aleatorios en hex (`crypto.randomBytes(48).toString('hex')`).                                                                                                                          | **Preexistente** (operacional / preview)                |
| `ANALYTICS_SESSION_PEPPER`         | `workers/runtime/analytics-config.ts`                                                                         | Seudonimización de sesiones de analítica desactivada (`sessionPepper` devuelve `undefined`); no se cruzan sesiones anónimas.                               | 32 bytes aleatorios en base64url (`crypto.randomBytes(32).toString('base64url')`). Exactamente 43 caracteres, distinto de los demás peppers.                                                    | **Preexistente** (operacional / analítica)              |
| `BEPLY_API_TOKEN`                  | `workers/runtime/operations-config.ts`, `server/integrations/invoice-factory.ts`                              | Llamadas a API Beply fallan; emisión de facturas y notas de crédito en Beply bloqueadas.                                                                   | Token de API emitido por Beply. Para entornos sintéticos: 32 bytes en base64url.                                                                                                                | **Preexistente** (integración Beply)                    |
| `NEWSLETTER_FEEDBACK_SECRET`       | `workers/runtime/customer-operations-config.ts`                                                               | Error de configuración en inicialización si el flag de feedback está activo; feedback deshabilitado.                                                       | 32 a 128 bytes aleatorios en base64url.                                                                                                                                                         | **Preexistente** (operacional / feedback)               |
| `SUPPORT_SCAN_SECRET`              | `workers/runtime/customer-operations-config.ts`, `workers/runtime/support-adapters.ts`                        | Verificador de recibos de escaneo de adjuntos de soporte desactivado (`scanReceiptVerifier` devuelve `undefined`).                                         | 32 a 4096 bytes en base64url (secreto HMAC SHA-256).                                                                                                                                            | **Preexistente** (operacional / soporte)                |
| `SUPPORT_TURNSTILE_SECRET`         | `workers/runtime/customer-operations-config.ts`, `workers/runtime/support-adapters.ts`                        | Verificador de retos Turnstile para soporte desactivado (`challengeVerifier` devuelve `undefined`).                                                        | Clave secreta obtenida del panel Cloudflare Turnstile (`^[A-Za-z0-9_-]{20,1000}$`).                                                                                                             | **Preexistente** (operacional / soporte)                |
| `PAYMENT_CONTINGENCY_SECRET_KEY`   | `workers/payments/alternative-contingency-provider.ts` (`alternativeProviderFromEnv`) vía `workers/canary.ts` | **503** (`service_unavailable`) en `/api/payments/alternative/webhook`: sin proveedor configurado el webhook falla cerrado y no concilia ningún pago.      | Clave HMAC entregada por el proveedor de pagos de contingencia (≥ 32 caracteres ASCII imprimibles, sin prefijo `local-only-`). Un valor aleatorio solo sirve para entornos sintéticos aislados. | **NUEVO** (SECFIX-3)                                    |

### 2.1. Proveedor de pagos de contingencia (SECFIX-3)

El webhook `/api/payments/alternative/webhook` solo verifica firmas con un proveedor construido desde la configuración del Worker; **no existe ninguna clave por defecto en el código**. Si falta cualquiera de estos valores o no es válido, `alternativeProviderFromEnv` devuelve `null` y el webhook responde `503 service_unavailable`.

| Nombre                             | Tipo          | Requisito                                                                                 |
| :--------------------------------- | :------------ | :---------------------------------------------------------------------------------------- |
| `PAYMENT_CONTINGENCY_ENABLED`      | var pública   | Exactamente `"true"` para activar el proveedor (por defecto ausente = apagado).           |
| `PAYMENT_CONTINGENCY_SECRET_KEY`   | Worker Secret | Clave HMAC-SHA256 del proveedor, 32–4096 caracteres ASCII imprimibles, sin `local-only-`. |
| `PAYMENT_CONTINGENCY_MERCHANT_ID`  | var pública   | `^[A-Za-z0-9_-]{1,64}$`.                                                                  |
| `PAYMENT_CONTINGENCY_ENDPOINT_URL` | var pública   | URL `https:` sin credenciales y cuyo host no termine en `.invalid`.                       |

Además, una notificación solo se considera cobrada (`captured`) si trae `status: "captured"` **y** `response_code: "0000"`; la ausencia de código nunca equivale a éxito, la moneda debe ser `EUR` y `provider_event_id`/`provider_reference` son obligatorios.

---

## 3. Detalle de nuevos secretos introducidos en esta tanda

### 3.1. `NETECO_API_KEY_PEPPER`

- **Propósito**: Pepper criptográfico utilizado como clave HMAC SHA-256 para computar el hash persistido de las claves B2B API (`b2b_api_keys.key_hash`). Al presentarse una clave en cabecera `Authorization: Bearer ntk_<prefijo>_<secreto>`, se computa `hmacSha256Hex(NETECO_API_KEY_PEPPER, secreto)` y se compara en tiempo constante (`timingSafeEqualHex`) contra la base de datos.
- **Validación de runtime**: `assertSecret(pepper, 32)` en `workers/security/controls-common.ts` exige que sea un string con longitud mínima de 32 caracteres. Si no está configurado, lanza `SecurityControlError('security_configuration_missing', 503)`.
- **Formato recomendado**: 32 bytes aleatorios codificados en base64url (43 caracteres alfanuméricos ASCII sin padding).

### 3.2. `NETECO_DEVICE_OFFLINE_MASTER_KEY`

- **Propósito**: Clave maestra raíz utilizada en HKDF (RFC 5869) con hash SHA-256, salt igual al UUID del dispositivo y etiqueta de contexto `neteco-offline-v<version>` para derivar una clave AES-GCM de 256 bits (`workers/security/offline-bundle.ts`). Dicha clave cifra y sella los manifiestos de sincronización offline para terminales de almacén.
- **Validación de runtime**: `assertSecret(masterKey, 32)` exige string con longitud mínima de 32 caracteres. Si falta, lanza `SecurityControlError('security_configuration_missing', 503)`.
- **Formato recomendado**: 32 bytes aleatorios codificados en base64url (43 caracteres).

### 3.3. `NETECO_ABUSE_SUBJECT_PEPPER`

- **Propósito**: Pepper criptográfico para la seudonimización con clave de sujetos evaluados en el motor de detección de abuso (`pseudonymizeSubject(kind, id, pepper)` en `shared/security-abuse-detection.ts`). Garantiza que identificadores de clientes, carritos o IPs se agreguen numéricamente sin persistir PII en bruto.
- **Validación de runtime**: `assertSecret(pepper, 32)` en `workers/security/abuse-detection.ts`. Lanza `SecurityControlError('security_configuration_missing', 503)` si falta.
- **Formato recomendado**: 32 bytes aleatorios codificados en base64url (43 caracteres).

---

## 4. Cruce con configuración de `wrangler.canary.jsonc` y variables públicas

En `wrangler.canary.jsonc`, la sección `secrets.required` contiene actualmente:

```jsonc
  "secrets": {
    "required": [
      "REDSYS_SECRET_KEY",
      "NUXT_SESSION_PASSWORD",
      "AUTH_RATE_LIMIT_PEPPER",
      "AUTH_TOKEN_PEPPER",
      "AUTH_ENCRYPTION_KEY",
      "NEWSLETTER_HMAC_KEY",
      "MEDIA_SCAN_SECRET"
    ]
  }
```

### Cambio recomendado para el orquestador

Para reflejar los nuevos requisitos de seguridad de la tanda, se recomienda incorporar los tres nuevos secretos a `wrangler.canary.jsonc`:

```jsonc
      "NETECO_API_KEY_PEPPER",
      "NETECO_DEVICE_OFFLINE_MASTER_KEY",
      "NETECO_ABUSE_SUBJECT_PEPPER"
```

_(Nota: Conforme a `BRIEF-COMUN.md`, este fichero compartido no ha sido modificado directamente por el agente; se detalla el diff exacto en el informe final)._

---

## 5. Flags de funcionalidad (`*_ENABLED`) en `wrangler.canary.jsonc`

Las variables públicas en `wrangler.canary.jsonc` configuran qué módulos funcionales están encendidos o apagados. Por defecto en canary y preproducción, todos los flags sensibles permanecen apagados (`"false"`):

| Variable / Flag                                   | Valor por defecto | Módulo afectado                           | Secreto asociado si se enciende                                        |
| :------------------------------------------------ | :---------------- | :---------------------------------------- | :--------------------------------------------------------------------- |
| `AUTH_ENABLED`                                    | `"false"`         | Sesiones y autenticación de usuarios      | `NUXT_SESSION_PASSWORD`, `AUTH_RATE_LIMIT_PEPPER`, `AUTH_TOKEN_PEPPER` |
| `AUTH_EMAIL_ENABLED`                              | `"false"`         | Envío de correos de verificación y acceso | `AUTH_ENCRYPTION_KEY`, `AUTH_TOKEN_PEPPER`                             |
| `B2B_PUBLIC_API_ENABLED`                          | `"false"`         | API pública B2B `/api/b2b/v1/*`           | `NETECO_API_KEY_PEPPER`                                                |
| `INVENTORY_ALERTS_ENABLED`                        | `"false"`         | Alertas de stock bajo                     | Ninguno                                                                |
| `CART_RECOVERY_ENABLED`                           | `"false"`         | Evaluación de carritos abandonados        | `AUTH_RATE_LIMIT_PEPPER`                                               |
| `CART_RECOVERY_DELIVERY_ENABLED`                  | `"false"`         | Envío de correos de recuperación          | `EMAIL` (binding)                                                      |
| `PRODUCT_WATCH_ENABLED`                           | `"false"`         | Seguimiento de productos                  | `AUTH_TOKEN_PEPPER`                                                    |
| `PRODUCT_WATCH_DELIVERY_ENABLED`                  | `"false"`         | Envío de alertas de producto              | `NEWSLETTER_EMAIL` (binding)                                           |
| `PRODUCT_CONTRIBUTIONS_ENABLED`                   | `"false"`         | Reseñas y valoraciones de clientes        | Ninguno                                                                |
| `SALES_QUOTES_ENABLED`                            | `"false"`         | Presupuestos comerciales                  | Ninguno                                                                |
| `CUSTOMER_360_ENABLED`                            | `"false"`         | Ficha unificada de cliente                | `NUXT_SESSION_PASSWORD`                                                |
| `ANALYTICS_ENABLED`                               | `"false"`         | Rastreo de eventos analíticos             | `ANALYTICS_SESSION_PEPPER`                                             |
| `ANALYTICS_PROJECTION_ENABLED`                    | `"false"`         | Proyecciones de métricas                  | Ninguno                                                                |
| `ANALYTICS_RETENTION_ENABLED`                     | `"false"`         | Purga programada de analítica             | Ninguno                                                                |
| `MEDIA_ADMIN_ENABLED`                             | `"false"`         | Subida y administración de multimedia     | `MEDIA_SCAN_SECRET`                                                    |
| `MEDIA_PUBLIC_ENABLED`                            | `"false"`         | Entrega pública de imágenes R2            | Ninguno                                                                |
| `CMS_PUBLICATION_ENABLED`                         | `"false"`         | Publicación de contenido CMS              | Ninguno                                                                |
| `CMS_PREVIEW_ENABLED`                             | `"false"`         | Previsualización de borradores CMS        | `CMS_PREVIEW_SECRET`                                                   |
| `FISCAL_ISSUANCE_ENABLED`                         | `"false"`         | Emisión de facturas hacia Beply           | `BEPLY_API_TOKEN`                                                      |
| `FISCAL_LOCAL_VALIDATION_ENABLED`                 | `"false"`         | Emisión simulada local en SQLite/D1       | Ninguno                                                                |
| `REFUNDS_ENABLED`                                 | `"false"`         | Gestión de reembolsos                     | `REDSYS_SECRET_KEY`                                                    |
| `REFUND_DISPATCH_ENABLED`                         | `"false"`         | Disparo real de devoluciones              | `REDSYS_SECRET_KEY`                                                    |
| `REFUND_LOCAL_VALIDATION_ENABLED`                 | `"false"`         | Reembolsos simulados en local             | Ninguno                                                                |
| `CREDIT_DISPATCH_ENABLED`                         | `"false"`         | Emisión de abonos fiscales                | `BEPLY_API_TOKEN`                                                      |
| `CREDIT_LOCAL_VALIDATION_ENABLED`                 | `"false"`         | Abonos simulados en local                 | Ninguno                                                                |
| `STORE_CREDIT_REDEMPTION_ENABLED`                 | `"false"`         | Canje de saldo en tienda                  | Ninguno                                                                |
| `SUPPORT_ENABLED`                                 | `"false"`         | Soporte y tickets de clientes             | `SUPPORT_SCAN_SECRET`                                                  |
| `SUPPORT_ATTACHMENTS_ENABLED`                     | `"false"`         | Adjuntos en tickets de soporte            | `SUPPORT_SCAN_SECRET`                                                  |
| `SUPPORT_TURNSTILE_ENABLED`                       | `"false"`         | Verificación anti-bot Turnstile           | `SUPPORT_TURNSTILE_SECRET`                                             |
| `BEPLY_ENABLED`                                   | `"false"`         | Integración con ERP Beply                 | `BEPLY_API_TOKEN`                                                      |
| `REDSYS_ENABLED`                                  | `"false"`         | Pagos con tarjeta vía Redsys              | `REDSYS_SECRET_KEY`                                                    |
| `REDSYS_BIZUM_ENABLED`                            | `"false"`         | Pagos Bizum vía Redsys                    | `REDSYS_SECRET_KEY`                                                    |
| `NEWSLETTER_ENABLED`                              | `"false"`         | Suscripción a newsletter                  | `NEWSLETTER_HMAC_KEY`                                                  |
| `NEWSLETTER_EDITORIAL_ENABLED`                    | `"false"`         | Redacción de campañas                     | `NEWSLETTER_HMAC_KEY`                                                  |
| `NEWSLETTER_CAMPAIGN_DELIVERY_ENABLED`            | `"false"`         | Entrega de campañas de correo             | `NEWSLETTER_HMAC_KEY`                                                  |
| `NEWSLETTER_LOCAL_VALIDATION_ENABLED`             | `"false"`         | Entrega simulada en local                 | Ninguno                                                                |
| `NEWSLETTER_FEEDBACK_ENABLED`                     | `"false"`         | Encuestas de satisfacción en email        | `NEWSLETTER_FEEDBACK_SECRET`                                           |
| `TRANSACTIONAL_EMAIL_ENABLED`                     | `"false"`         | Notificaciones transaccionales            | `EMAIL` (binding)                                                      |
| `INVOICE_EMAIL_ENABLED`                           | `"false"`         | Envío de facturas por email               | `EMAIL` (binding)                                                      |
| `INVOICE_VALIDATION_EMAIL_ENABLED`                | `"false"`         | Validación de emails de factura           | Ninguno                                                                |
| `TRANSACTIONAL_EMAIL_RENDERER_VALIDATION_ENABLED` | `"false"`         | Validación de plantillas de correo        | Ninguno                                                                |

---

## 6. Variables exclusivas del servidor Node.js legado (no son secretos del Worker)

Los siguientes valores existen en `server/**` para despliegues Node tradicionales (PostgreSQL / Redis / SMTP tradicional) y **no deben aprovisionarse como secretos del Worker**:

- `DATABASE_URL`: Cadena de conexión PostgreSQL (`server/db/client.ts`). En el Worker se utiliza el binding D1 `DB`.
- `EMAIL_WEBHOOK_SECRET`: Secreto de firma para webhooks entrantes en `server/api/webhooks/email.post.ts`.
- `SMTP_PASSWORD`: Contraseña SMTP en `server/integrations/email-provider.ts`. En el Worker se utiliza el binding Cloudflare Email `EMAIL` / `NEWSLETTER_EMAIL`.
- `REDIS_KEY_PREFIX`: Prefijo de claves Redis (`server/db/redis.ts`). En el Worker se utiliza el binding KV `CACHE`.

---

## 7. Procedimiento de aprovisionamiento con `scripts/provision-worker-secrets.ts`

El script `scripts/provision-worker-secrets.ts` proporciona una interfaz segura para inspeccionar y cargar los secretos en el Worker sin exponerlos.

### 7.1. Inspección sin cambios (Dry-Run por defecto)

```bash
# Muestra los comandos wrangler que se ejecutarían para los secretos obligatorios y nuevos
npx tsx scripts/provision-worker-secrets.ts --worker neteco-cloudflare-canary

# Inspecciona contra Cloudflare qué secretos existen actualmente y muestra solo los que faltan
npx tsx scripts/provision-worker-secrets.ts --worker neteco-cloudflare-canary --check

# Incluye también los secretos operacionales opcionales
npx tsx scripts/provision-worker-secrets.ts --worker neteco-cloudflare-canary --all
```

### 7.2. Aprovisionamiento seguro (`--apply`)

```bash
# Genera entropía criptográfica y la pasa por STDIN a wrangler sin imprimirla ni guardarla en disco
npx tsx scripts/provision-worker-secrets.ts --worker neteco-cloudflare-canary --apply

# Aprovisiona solo los secretos ausentes tras consultar wrangler secret list
npx tsx scripts/provision-worker-secrets.ts --worker neteco-cloudflare-canary --apply --check
```

### 7.3. Protección contra entornos Beply

Cualquier intento de ejecutar el aprovisionamiento indicando un nombre de Worker que contenga `beply` fallará de inmediato:

```bash
npx tsx scripts/provision-worker-secrets.ts --worker neteco-beply-prod --apply
# Error: target_worker_forbidden: worker name cannot contain "beply"
```
