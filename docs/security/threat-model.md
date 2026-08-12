# Modelo de amenazas y baseline ASVS

Objetivo: OWASP ASVS 5 nivel 2 para toda la aplicación, reforzado en autenticación, administración, pagos, facturación, stock y archivos. Nivel 3 se aplica a controles financieros de alto impacto cuando sea razonable.

## Activos y clasificación

- Crítico: credenciales, sesión, claves Redsys/Beply/carrier, eventos de pago, permisos y auditoría.
- Restringido: PII, direcciones, NIF, facturas, tickets, POD y exports.
- Interno: costes, margen, inventario, notas, configuración y métricas operativas.
- Público: catálogo publicado, políticas, stock agregado y contenido editorial.
- Prohibido: PAN, CVC, caducidad, credenciales en claro y secretos en telemetría.

## Límites de confianza y abuso

| Límite                       | Riesgos principales                       | Controles obligatorios                                                |
| ---------------------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| Navegador → Nitro            | XSS, CSRF, IDOR, inyección, abuso         | Zod estricto, SameSite, Origin/CSRF, RBAC/ownership, rate limit, CSP  |
| Nitro → PostgreSQL/Redis     | inyección, escalada, pérdida              | SQL parametrizado, rol mínimo, TLS, backups, locks y constraints      |
| Nitro/worker → Redsys        | firma falsa, replay, importe alterado     | HMAC, comercio/terminal/moneda/importe, inbox e idempotencia          |
| Worker → Beply/carrier/email | SSRF, duplicado, caída                    | egress allowlist, timeout, circuit breaker, outbox/DLQ                |
| Panel → acciones sensibles   | takeover, abuso interno                   | MFA, permisos separados, step-up/doble control, auditoría append-only |
| Upload → storage/CDN         | malware, XSS, path traversal              | magic bytes, AV, nombre generado, cuarentena, storage no ejecutable   |
| CI → producción              | supply chain, secreto, artefacto distinto | OIDC, lock, SBOM, provenance, firma, environments protegidos          |

## Verificación

Los controles se trazan a pruebas unitarias, integración PostgreSQL, contrato, E2E/IDOR, axe, DAST y revisión manual. Toda excepción necesita riesgo, owner, mitigación, fecha de caducidad y aprobación. Ver `docs/testing/strategy.md` y el workflow de CI.
