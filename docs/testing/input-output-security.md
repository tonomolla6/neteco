# Matriz automática de seguridad de entrada y salida

TST-021 combina E2E sobre Nuxt/PostgreSQL/Redis real y pruebas unitarias de las fronteras puras. Todos los payloads son
sintéticos, el navegador bloquea redes externas y los providers no realizan llamadas reales.

| Riesgo         | Frontera y evidencia automática                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XSS            | La búsqueda renderiza etiquetas, atributos y `script` como texto sin crear nodos ni ejecutar el marcador; las plantillas de factura escapan HTML hostil.                                                                            |
| SQL injection  | Búsqueda y orden reciben comillas, booleanos, `DROP`, `UNION` y `pg_sleep`; responden normalmente y el catálogo conserva su recuento. Las consultas usan parámetros y el orden usa allowlist.                                       |
| CSRF/CORS      | Mutaciones de cuenta, newsletter y soporte rechazan Origin ausente/ajeno; Origin y Referer propios pasan; Referer inválido falla cerrado. Solo los dos webhooks firmados omiten esta barrera y continúan a su verificación propia.  |
| SSRF           | Producción exige HTTPS sin credenciales/query/fragmento, restringe Beply a `beply.es`, resuelve DNS justo antes del `fetch` y rechaza cualquier respuesta privada/link-local IPv4/IPv6. El transporte impide redirects automáticos. |
| Path traversal | El E2E autenticado envía `../../escape.png` al endpoint real; la clave persistida queda confinada bajo `quarantine/` con UUID y extensión derivada de magic bytes, y el archivo se comprueba dentro del storage configurado.        |
| CSV injection  | El generador real de trazabilidad neutraliza celdas que comienzan con `=`, `+`, `-` o `@`, incluso tras espacios/control, antes de aplicar quoting RFC 4180.                                                                        |
| Upload         | Unit cubre magic bytes, MIME, tamaño, raster truncado, dimensiones y metadatos. E2E cubre permiso+MFA, rechazos 413/415 sin fila, escritura normalizada, derechos pendientes y cuarentena no aprobable.                             |
| Headers        | Respuestas normales y 404 llevan CSP, anti-framing, `nosniff`, Referrer/Permissions Policy, COOP y correlación; HSTS solo se emite en producción.                                                                                   |
| Cookies        | Cart, acceso a pedido y analytics comparten `HttpOnly`, `SameSite=Lax`, `Path=/`, TTL y `Secure` obligatorio en producción; E2E inspecciona las tres cookies reales.                                                                |
| Rate limits    | Un catálogo cubre middleware y otro los 13 endpoints sensibles con scope, presupuesto y ventana. E2E agota búsqueda y login contra Redis real y exige `429` más `Retry-After`.                                                      |

El job normal de Vitest ejecuta `security-boundaries`, media, email y providers. El job E2E Chromium descubre
`security.spec.ts`, `privacy.spec.ts` y `authorization-idor.spec.ts`; este último usa un directorio absoluto y aislado
de media para poder verificar y retirar el archivo creado. Una nueva frontera de URL, descarga, exportación, upload o
mutación debe incorporarse a esta matriz y a su gate antes de considerarse lista para producción.
