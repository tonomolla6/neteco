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

El alcance, los umbrales y cada exclusión de cobertura se gobiernan en
[`coverage-policy.json`](./coverage-policy.json). Vitest consume ese archivo directamente; CI valida responsable,
revisión, caducidad y umbrales antes de medir, y publica la política junto al informe de cobertura. Una exclusión
caducada, incompleta o duplicada bloquea el gate.

## Datos y determinismo

Cada test crea un contexto de [`fixtures/deterministic.ts`](../../tests/fixtures/deterministic.ts) con namespace
propio: IDs, tokens, emails y reloj se repiten sin depender del orden de ejecución. El setup de integración construye
una plantilla PostgreSQL vacía→migrada→seed sintético; cada caso clona su propia base y la elimina al terminar. El
runner E2E clona otra base efímera para la ejecución completa, cada caso usa un namespace propio y la base se elimina
incluso cuando Playwright falla. `NETECO_TEST_NOW` congela el reloj de aplicación exclusivamente bajo `APP_ENV=test`.
Las suites Vitest bloquean `fetch` externo y el fixture de
Playwright aborta navegación de navegador fuera del origen bajo prueba. El audit automático rechaza UUID/PRNG/reloj
de pared/clientes de red nativos, URLs externas en `APIRequestContext` y cualquier spec E2E que omita el fixture.
Cualquier fixture con PII real está prohibida.

## Redsys E2E

Playwright ejecuta la rama real del adaptador Redsys con el vector sandbox publicado y sin alcanzar la red externa.
El TPV alojado se simula únicamente interceptando el formulario del navegador; las notificaciones firmadas atraviesan
el endpoint HTTP real y PostgreSQL. La suite cubre éxito, rechazo, abandono, callback antes/después del retorno,
duplicado, importe/firma inválidos y reintento visible. CI conserva traces, vídeo y screenshots solo en fallo.

## Cuenta y compra autenticada E2E

El recorrido autenticado crea dos cuentas sintéticas mediante la UI y recupera los tokens de verificación y reset
solo desde el outbox de la base efímera. Comprueba registro, verificación, logout, login, dirección, carrito, checkout,
Redsys, pedido, emisión y descarga de factura mock, reset y revocación de sesiones. El segundo usuario demuestra que
direcciones, pedidos y facturas no cruzan identidades; además, reinyecta las cookies anteriores de acceso a pedido y
carrito para verificar que el logout revocó sus tokens.
