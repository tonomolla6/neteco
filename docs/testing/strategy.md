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

El contrato TST-017 fija el vector `HMAC_SHA512_V2`, la clave pública de prueba y los parámetros del ejemplo oficial
de [firma de operaciones](https://pagosonline.redsys.es/desarrolladores-inicio/documentacion-operativa/firmar-una-operacion/),
además de los rangos de [códigos de respuesta](https://pagosonline.redsys.es/desarrolladores-inicio/integrate-con-nosotros/parametros-de-entrada-y-salida/)
y las URLs de [entornos de prueba](https://pagosonline.redsys.es/desarrolladores-inicio/integrate-con-nosotros/tarjetas-y-entornos-de-prueba/),
consultados el 13 de agosto de 2026. Los secretos publicados aparecen solo en fixtures sandbox; la configuración
productiva exige endpoint productivo, credenciales no vacías y rechaza el comercio público `999008881` de pruebas.

La aceptación externa se ejecuta de forma explícita con `npm run test:contract:redsys:sandbox`. El gate exige
`REDSYS_CONTRACT_SANDBOX=1`, `REDSYS_ENV=sandbox`, credenciales inyectadas y una URL HTTPS de callback; aborta en
producción y nunca imprime la clave. El smoke envía un redirect firmado de 1,45 € al endpoint sandbox. Finanzas debe
completar después los casos oficiales de autorización, denegación y cancelación, conservar callback/portal como
evidencia y rotar o retirar las credenciales temporales. Hasta entonces TST-017 permanece `PARTIAL_EXTERNAL`.

## Contrato Beply

TST-018 verifica el adapter API v3 con transporte `application/x-www-form-urlencoded`, token, zona horaria de Madrid,
cliente y contacto fiscal, factura, formas de pago, PDF y rectificativa enlazada. La matriz clasifica explícitamente
`400`, `401`, `403`, `404`, `409`, `422` y `500`; un `409` ambiguo durante emisión se prueba además contra un servidor
HTTP local y debe cerrar el job como `fiscal_pending`, emitir una única solicitud de conciliación y aparecer en el
reporte de `scripts/reconcile.ts`, sin reemitir a ciegas.

La documentación detallada del tenant Beply no es pública y debe adjuntarse/versionarse tras la validación del
proveedor. El gate `npm run test:contract:beply:sandbox` exige confirmación explícita, tenant HTTPS y credenciales
inyectadas; crea solo datos sintéticos, factura, pago, PDF y rectificativa en el tenant de pruebas, y no imprime el
token. La ejecución externa y una consulta remota contractual para conciliar estados siguen pendientes, por lo que
TST-018 permanece `PARTIAL_EXTERNAL`.

## Contrato de carrier

La interfaz y el fake determinista cubren el contrato neutral de rate, label, cancelación, polling de tracking,
retorno, pickup, unidades, zonas e inputs inválidos. Producción rechaza esos adapters de prueba. TST-019 permanece
`PARTIAL_EXTERNAL` hasta cerrar `DEC-014` y ejecutar la matriz de
[aceptación del carrier](./carrier-contract.md) contra la documentación y sandbox del proveedor seleccionado. No se
presupone webhook: el contrato decidirá webhook firmado/deduplicado o polling con SLA y backoff documentados.

## Cuenta y compra autenticada E2E

El recorrido autenticado crea dos cuentas sintéticas mediante la UI y recupera los tokens de verificación y reset
solo desde el outbox de la base efímera. Comprueba registro, verificación, logout, login, dirección, carrito, checkout,
Redsys, pedido, emisión y descarga de factura mock, reset y revocación de sesiones. El segundo usuario demuestra que
direcciones, pedidos y facturas no cruzan identidades; además, reinyecta las cookies anteriores de acceso a pedido y
carrito para verificar que el logout revocó sus tokens.

## Autorización e IDOR E2E

La [matriz automática de autorización e IDOR](./authorization-idor.md) separa autenticación, ownership, membresía de
empresa, MFA y permiso global. Usa recursos reales de un cliente A y ataques desde un cliente/empresa B, y después
eleva B a administrador con MFA para probar tanto el acceso administrativo intencionado como identificadores
inventados. La matriz distingue además los scopes internos de tienda de `support`, `warehouse` y `finance` frente a
los roles de empresa. Exportación de PII, invoice/label PDF, upload y acciones financieras forman parte del gate. Cada
bloque denegado compara filas completas y efectos atribuidos por actor/recurso/correlación para seguir siendo estable
durante la ejecución paralela de Playwright.

## Seguridad de entrada y salida

La [matriz de seguridad de entrada y salida](./input-output-security.md) prueba XSS, SQL injection, CSRF/CORS, SSRF,
path traversal, fórmulas CSV, upload, headers, cookies y rate limits. Los checks se colocan en la frontera más fuerte:
E2E cuando importa el middleware/render/cookie/Redis/storage real y unitario cuando la propiedad es un serializador,
allowlist o parser determinista. La URL de Beply queda limitada a HTTPS bajo `beply.es`, se comprueba después de
resolver DNS y se consume sin redirects; el CSV de trazabilidad usa el mismo serializador endurecido que cubren los
payloads de fórmula.

## Accesibilidad automatizada

El gate dedicado `npm run test:a11y` aplica Axe WCAG A/AA sobre la
[matriz de accesibilidad](./automated-accessibility.md): plantillas públicas, estados vacíos y de error, checkout,
consentimiento, navegación/filtros móviles, cuenta y panel autenticado con MFA. Un hallazgo `serious` o `critical`
falla CI y conserva evidencia diagnóstica. Esta automatización complementa, pero no sustituye, la revisión manual de
TST-023.

## Transferencia bancaria E2E

El journey de transferencia atraviesa catálogo, carrito, checkout y página de pedido con una reserva real de 72 horas.
La suite importa un extracto sintético por el mismo job que usa Operaciones, confirma el pedido y prueba el replay
concurrente del movimiento sin repetir captura, asignación ni evento. Una referencia incompleta pasa a revisión y se
concilia desde el panel con permiso financiero y MFA; un importe divergente permanece bloqueado. Un tercer pedido
caduca mediante dos workers simultáneos y demuestra una única transición, liberación y notificación.

## Fulfillment y transporte E2E

El journey logístico compra por la UI con reparto propio, agencia y recogida, y conserva en el pedido la elegibilidad,
tarifa y ETA cotizadas. Con el `CarrierProvider` fake prueba creación concurrente idempotente, incompatibilidad entre
método y servicio, etiqueta PDF, tracking `exception → delivered`, cancelación con replay y cierre de recogida sin
expedición de transportista. El fake solo se habilita fuera de producción y su secuencia se fija con
`MOCK_CARRIER_TRACKING_SEQUENCE`; el navegador no alcanza redes externas.

Esta evidencia de repositorio no sustituye la prueba del carrier real. `DEC-014` continúa siendo el gate externo:
Logística debe cerrar tender, contrato, API, SLA y sandbox, y después ejecutar el mismo contrato y UAT antes de aceptar
TST-014/SHP-004 para Alpha.

## Cancelaciones, devoluciones y reembolsos E2E

El journey financiero-logístico crea por UI un pedido sin captura, otro capturado antes de expedición y un tercero
capturado y expedido. Verifica cancelación e idempotencia antes y después de captura, bloqueo de cancelación y de
devolución mientras el envío no está entregado, solicitud parcial desde autoservicio y resolución desde el panel.
La conciliación final comprueba reserva y stock físico, rechazo de importes excesivos, reembolso total y parcial,
eventos de pago sin duplicados, factura origen y rectificativa PDF enlazada, además de las entregas de email de
cancelación, devolución y reembolso.

La captura atraviesa el endpoint Redsys real con una notificación firmada y el TPV alojado interceptado localmente.
Los jobs de reembolso, factura/rectificativa y correo usan adapters deterministas de test y se reejecutan para probar
idempotencia sin red externa. Esta evidencia cubre la orquestación TST-015 en el repositorio, pero no atribuye
evidencia a los proveedores Redsys o Beply reales; su aceptación con credenciales, contrato y sandbox continúa
gobernada por los requisitos PAY y BEP correspondientes.

## Concurrencia de stock, reservas y callbacks

TST-016 combina pruebas de integración y E2E sobre PostgreSQL real. Dos carritos intentan comprar a la vez la última
unidad: solo uno crea el pedido, y la captura concurrente mantiene una única reserva, asignación y solicitud de
factura. La expiración fuerza el TTL de un pedido por transferencia y lanza dos workers simultáneos; solo uno libera
la reserva y emite la transición y comunicación correspondientes.

El callback Redsys firmado se envía dos veces en paralelo al endpoint HTTP. Las restricciones de unicidad, la inbox
transaccional y el bloqueo del pedido deben dejar exactamente un callback persistido, un evento de pago, una
asignación de inventario y una solicitud de factura. Los adapters de pago siguen siendo locales al test; esta prueba
acredita la concurrencia de la aplicación y la base de datos, no la disponibilidad del TPV externo.
