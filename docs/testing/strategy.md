# Estrategia de calidad

## Pirámide y gates

1. Unit/property: dinero, IVA, cantidades, disponibilidad, estados, permisos y contratos puros. Cobertura global y por archivo 100 % en `server/domain` e `server/integrations`.
2. Integración: PostgreSQL y Redis reales; migraciones vacío→latest, constraints, transacciones, locks, outbox/inbox y concurrencia.
3. Contrato: fixtures oficiales/versionados para Redsys, Beply, carrier y email; nunca red externa en unit tests.
4. Nuxt/component: formularios, errores, teclado, estados, permisos y schema/data layer.
5. E2E: journeys felices y fallos en Chromium, Firefox, WebKit y dos perfiles móviles; trace, vídeo y screenshot solo al fallar.
6. Seguridad/accesibilidad/SEO/rendimiento: IDOR, CSRF/XSS/SSRF/upload, axe, schema/canonical/sitemap, budgets y carga.
7. UAT/manual: almacén, administración, soporte, lector de pantalla, zoom/reflow, móvil real, sandbox y restore.

No se admiten tests skipped, cuarentena silenciosa ni retries para convertir rojo en verde. Un test inestable bloquea hasta repararse o necesita issue, owner y fecha. Coverage complementa mutation testing (mínimo 90 % inicial), property tests y fault injection.

## Datos y determinismo

Factories usan UUID/reloj inyectables. Cada integración y E2E parte de base aislada y seed sintético. Preview/demo interceptan email y no resuelven endpoints productivos. Cualquier fixture con PII real está prohibida.
