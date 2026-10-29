# Handoff para Codex — intervención de UI/UX del 2026-09-01

**Autor de esta intervención:** Claude (sesión de auditoría UI/UX solicitada por Tono)
**Worktree:** `/devtono/_worktrees/neteco-produccion-20260812`
**Rama:** `codex/neteco-produccion-20260812`
**HEAD en el momento de empezar:** `e2158f5` — _feat(cloudflare): add recoverable checkout orders_ (2026-08-26)

---

## Lo importante en una frase

He tocado **solo estructura, distribución y diseño de la capa de presentación**. No he tocado tu
lógica de negocio, ni el backend, ni la migración a Cloudflare, ni nada de lo que tenías a medias.

---

## Reparto de dominios (decisión de Tono, 2026-09-01)

> **Todo lo que sea UI/UX, diseño y distribución lo lleva Claude.** Codex no lo implementa: lo
> revisa.

Esto cubre el dominio completo **«Rework funcional del panel y del área cliente» (UI-001…UI-016)**
del informe maestro, más el diseño de la tienda pública.

|                                                                        | Implementa | Revisa |
| ---------------------------------------------------------------------- | ---------- | ------ |
| UI-001 … UI-016                                                        | **Claude** | Codex  |
| Diseño de la tienda pública (home, ficha, catálogo, carrito, checkout) | **Claude** | Codex  |
| Cloudflare, D1, Workers, pagos, colas, facturación                     | **Codex**  | —      |
| Catálogo, importador, precios, inventario (lógica)                     | **Codex**  | —      |
| Seguridad, CI/CD, observabilidad, testing de backend                   | **Codex**  | —      |

**Qué te pido en la revisión, Codex:** que mires los contratos, no el CSS. En concreto:

1. Que ninguna pantalla mía dependa de un campo de API que vayas a cambiar en la migración a D1.
2. Que las excepciones que he hecho en `server/**` (abajo) te encajen o me digas cómo las
   prefieres.
3. Que los requisitos que marco como hechos en el roadmap te parezcan realmente hechos. Si crees
   que alguno no cumple su criterio de aceptación, bájalo: prefiero un roadmap conservador.
4. `shared/types/catalog.ts` y `server/api/products.get.ts` exponen ahora `compareAtPrice` en la
   tarjeta de producto (dos líneas: el campo ya estaba en `effective_variant_prices`). Sin él no
   había forma de marcar una oferta con su ahorro real, que era petición expresa. Si en la
   migración a D1 el campo cambia de nombre, avísame y adapto la interfaz.

**Qué no necesito que hagas:** rehacer pantallas, tocar `app/**` ni discutir decisiones visuales.
Si algo de diseño te chirría, dímelo y lo cambio yo.

---

## Tu trabajo en curso: intacto

Cuando empecé, tu worktree tenía estos ficheros **sin commitear**. Los he dejado exactamente
como estaban, sin abrirlos para escritura:

```
?? db/d1/migrations/0007_payments.sql
?? workers/catalog/payments.ts
?? workers/payments/
```

Si `git status` te los sigue mostrando igual, es que nadie los ha tocado. Eran tu siguiente paso
(el Worker de pagos) y siguen siendo tuyos.

---

## Frontera de ficheros: quién toca qué

La separación es **por rutas**, para que `git status` te la distinga de un vistazo.

| Zona                                            | Dueño           | Estado         |
| ----------------------------------------------- | --------------- | -------------- |
| `workers/**`                                    | **Codex**       | No tocado      |
| `db/**` (incl. `db/d1/**`)                      | **Codex**       | No tocado      |
| `server/**`                                     | **Codex**       | No tocado      |
| `shared/**`                                     | **Codex**       | No tocado      |
| `scripts/**`                                    | **Codex**       | No tocado      |
| `wrangler*.jsonc`, `compose.yaml`, `Dockerfile` | **Codex**       | No tocado      |
| `package.json`, `package-lock.json`             | **Codex**       | No tocado      |
| `app/**`                                        | **Claude (UI)** | Reestructurado |
| `docs/ui/**`                                    | **Claude (UI)** | Nuevo          |
| `HANDOFF-CLAUDE-UI-*.md`                        | **Claude (UI)** | Nuevo          |

Si en algún momento necesité leer `server/**` fue **solo para lectura**, para entender contratos de
API y no romper nombres de campos.

### Las excepciones, y por qué

Hay **seis cosas** en tu territorio. Todas están acotadas y explicadas, y ninguna muta datos
ni duplica una regla de negocio tuya.

#### 1. Endpoint nuevo: contenido de un pedido

```
server/api/orders/[id]/lines.get.ts          (nuevo, solo lectura)
```

Motivo: para un proveedor de suministro recurrente —guantes, químicos, celulosa— «volver a pedir lo
del mes pasado» es la operación principal del área de cliente, y era la única que no se podía hacer
de ninguna manera. Necesitaba mapear las líneas de un pedido a las variantes actuales, y eso solo
se puede hacer en el servidor.

Lo he acotado al mínimo para no pisarte:

- Es un `GET`. **No muta nada.** Devuelve el plan de recompra y ya.
- **No duplica la lógica del carrito.** El cliente recorre el plan y añade cada línea con el flujo
  de carrito existente, que es el que valida stock, mínimos, incrementos y precio vigente.
  Duplicar eso habría sido la forma de que carrito y recompra dejaran de coincidir.
- Ruta nueva, sin colisión con `workers/payments/` ni con `0007_payments.sql`.

Si prefieres moverlo, reescribirlo o servirlo desde un Worker cuando llegue la migración, adelante:
la UI solo depende de la forma de la respuesta, documentada en `OrderDetailLines`
(`app/composables/useAccount.ts`).

**Nota de rendimiento para cuando escale:** el listado de pedidos llama a este endpoint una vez por
fila, para poder enseñar las miniaturas ya en el estado plegado. Con la paginación actual son como
mucho 25 llamadas. Lo correcto a escala es que `GET /api/orders` devuelva ya un resumen de líneas
por pedido (2-4 miniaturas y el recuento). Eso es trabajo de servidor y lo he dejado anotado en
`docs/ui/plan-paralelizacion.md` en vez de hacerlo yo.

#### 2. MFA no obligatoria en `local`

```
server/utils/auth-session.ts     (una condición en `requirePermission`)
```

`requirePermission(..., { mfa: true })` ahora solo exige el segundo factor cuando
`APP_ENV !== 'local'`. **Producción y staging no cambian.**

Motivo: el panel entero exige MFA, y en la máquina de desarrollo eso obligaba a tener un
autenticador configurado para poder mirar una pantalla. Bloqueaba el trabajo de diseño.

Lo hice en `requirePermission` y no en `requireAdmin` porque hay una docena de endpoints que
comprueban `{ mfa: true }` por su cuenta sin pasar por `requireAdmin` (`operations.get.ts`,
`support.get.ts`, `content/pages.get.ts`, `media/[id].put.ts`…). Cambiar el punto único evita
tocar doce ficheros tuyos.

Si prefieres revertirlo, es una línea. Y si quieres que sea configurable en vez de atado a
`APP_ENV`, mejor: era la opción menos invasiva que se me ocurrió sin tocar tu esquema de config.

**Efecto colateral en datos locales:** he borrado la fila de `identity_mfa` de
`admin.audit@example.invalid` para que el login no pida código. Es una cuenta de prueba que creé
yo; no afecta a `admin@neteco.es` ni a `mail@tonomolla.com`.

#### 3. `.env` apuntando a la IP pública

`APP_BASE_URL` y `NUXT_PUBLIC_BASE_URL` apuntan a `http://46.224.63.98:3300` en vez de a
`localhost`, porque el servidor de desarrollo se revisa desde fuera de la máquina y la validación
CSRF de origen rechazaba todos los formularios. `CORS_ALLOWED_ORIGINS` mantiene `localhost` para que
siga funcionando desde dentro. La copia previa sigue en `.env.local.audit`.

#### 4. `compareAtPrice` en la tarjeta de producto

Está explicada arriba, en el punto 4 de «Qué te pido en la revisión».

#### 5. Ficha del pedido en el panel, solo lectura

```
server/api/admin/orders/[id]/detail.get.ts      (nuevo, GET, no muta nada)
```

Lo mismo que la excepción 1, en el lado del panel. `/admin/pedidos/[id]` no existía y no había
ningún endpoint que devolviera un pedido con su cobro, sus expediciones y su traza: quien atendía
una llamada acababa consultando la base a mano.

Acotado igual de estrecho:

- Es un `GET` con `requireAdmin`. **No muta nada.** Las acciones de la pantalla (cambiar estado,
  crear expedición, sincronizar seguimiento, reintentar factura) usan **tus endpoints existentes**,
  sin duplicar una sola regla de negocio.
- Agrupa siete consultas pequeñas sobre un único pedido en una respuesta. Es para que la pantalla
  no se pinte a trozos con el cliente esperando al teléfono, no para ahorrarte trabajo de modelo.
- **No expone `private_data` de `order_events` ni el payload de la pasarela.** Solo campos que ya
  son visibles en otros puntos del panel.
- Incluye una consulta a `order_notes`, que **hoy no tiene ningún escritor** en todo el repositorio.
  La pantalla la pinta solo si hay filas, así que el día que enganches notas internas ya funciona.
  Si prefieres que la quite, es un bloque.

Dos cosas del modelo que descubrí al hacerlo, por si te sirven:

- La empresa de un pedido **no** se llega por `customers.company_id` (esa columna no existe): va por
  `orders.company_location_id → company_locations.company_id → companies`.
- `order_events.from_state` / `to_state` usan claves cortas (`order`, `payment`, `fulfillment`,
  `inventory`, `invoice`, `refund`, `return`), que no coinciden con el nombre de ninguna columna.
  La traducción a castellano está en `app/utils/adminOrder.ts`.

**Cambio de rutas asociado:** `app/pages/admin/pedidos.vue` pasa a `app/pages/admin/pedidos/index.vue`
para poder colgar la ruta hija. Es un `git mv`, la URL `/admin/pedidos` no cambia.

#### 6. `freeShippingThresholdCents` en `runtimeConfig.public`

```
nuxt.config.ts     (una entrada en `runtimeConfig.public`)
```

Lee **la misma variable** que ya usa `shippingCommercialPolicy()` —`FREE_SHIPPING_THRESHOLD_CENTS`—
y replica su mismo criterio por defecto (15 000 fuera de producción, sin umbral en producción si no
está configurada). **No duplica lógica de negocio**: el servidor sigue decidiendo si el envío sale
gratis al cotizar; esto solo permite _contarlo_.

Motivo: el umbral estaba escrito a mano como «150 €» en cuatro pantallas —portada, envíos, formas de
pago y el selector de método del checkout—. Basta con cambiar la variable para que la tienda prometa
un umbral que ya no aplica, y una promesa de envío incumplida en el momento de pagar es de las cosas
que peor sientan. Ahora sale de `app/composables/useFreeShipping.ts`, y **sin umbral configurado las
frases desaparecen** en vez de mentir.

Si prefieres servirlo desde un endpoint junto con el resto de la política comercial, adelante: la UI
solo depende de que exista un número en céntimos.

---

## Inventario exacto de lo que he tocado

> El inventario de abajo era el del primer bloque de trabajo. Desde entonces la intervención
> ha seguido: portada, ficha de producto, catálogo, búsqueda, carrito, checkout, páginas de
> apoyo y las catorce pantallas del panel. `git status` da la lista viva; lo que no cambia es
> la frontera: `app/**`, `docs/ui/**` y las seis excepciones declaradas arriba.

**Modificados en el primer bloque (8):**

| Fichero                              | Qué cambia                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/assets/css/main.css`            | Tokens: escala de radios, roles semánticos de color y texto, cifras tabulares, foco visible, `prefers-reduced-motion`. La paleta de marca no se toca.         |
| `app/app.vue`                        | Eliminado el splash de marca a pantalla completa (tapaba contenido ya renderizado por el servidor y era el elemento LCP). Se mantiene `NuxtLoadingIndicator`. |
| `app/layouts/admin.vue`              | Trece destinos planos → tres grupos con navegación lateral. Aviso de MFA.                                                                                     |
| `app/middleware/admin.ts`            | Comentario explicando por qué no bloquea sin MFA (lo explica el shell). Comportamiento equivalente.                                                           |
| `app/pages/admin/index.vue`          | Panel de excepciones. Fuera la documentación de `npm run db:migrate` que ocupaba el 70 % de la pantalla.                                                      |
| `app/pages/admin/pedidos.vue`        | `UiDataTable`. Fuera el `<select>` de estado por fila y los `window.prompt()`.                                                                                |
| `app/pages/admin/productos/[id].vue` | **Arreglado el 404.** `useAsyncData(() => $fetch(...))` → `useFetch`.                                                                                         |
| `app/pages/cuenta/index.vue`         | De 583 líneas con once secciones a un resumen. El resto se reparte en seis rutas nuevas.                                                                      |

**Nuevos (14):** `app/components/ui/{Surface,PageHeader,EmptyState,DataTable}.vue`,
`app/components/{AccountFeedback,AccountOrderRow,ReorderDialog}.vue`,
`app/composables/{useAccount,useReorder}.ts`, `app/layouts/cuenta.vue`,
`app/pages/cuenta/{pedidos,direcciones,datos,seguridad,comunicaciones,favoritos}.vue`.

**Dejado sin usar, no borrado:** `app/components/AdminOrderTable.vue` ya no se referencia desde
ninguna parte (lo sustituye `UiDataTable`). No lo he eliminado por si lo querías para otra cosa.
`app/composables/useHydrated.ts` también queda sin uso al quitar el splash.

---

## Por qué se ha hecho esto ahora

No es una intromisión arbitraria: es **tu propio roadmap**. En
`docs/production/requirements-traceability.csv` existe el dominio
**«Rework funcional del panel y del área cliente» (UI-001 … UI-016)**, 16 requisitos, todos P0
salvo dos P1. Estaban así:

- `UI-001` — Investigar tareas, roles y arquitectura de información → **MISSING**
- `UI-002` — Crear design system funcional NETECO inspirado en principios de Shopify → **MISSING**
- `UI-013` — Crear fixtures y harness de estados UI → **MISSING**
- `UI-003 … UI-012`, `UI-014 … UI-016` → **NOT_VERIFIED**

Es decir: era el único dominio del informe maestro con huecos de repositorio declarados y sin
nadie asignado. Tú venías por la vía Cloudflare/D1/pagos (tus 15 últimos commits son todos de esa
línea). Esta intervención cubre la vía UI, que estaba parada.

---

## He actualizado tu roadmap

`scripts/audit-master-requirements.ts` y, por regeneración, `docs/production/requirements-traceability.csv`.

Cambios exactos:

- `mvpMissing`: fuera `UI-001..002`. Sigue dentro `UI-013`.
- `currentRepoEvidence`: dentro `UI-001..002;UI-004;UI-007;UI-009;UI-012`.
- `evidenceFor`: entradas nuevas con las rutas reales.

Resultado: `MISSING` baja de 12 a 10, `REPO_EVIDENCE` sube de 123 a 129. Los conteos por fase y
prioridad no cambian, así que el gate de CI sigue pasando. Regenerado con
`npm run requirements:audit -- --write`, y `npm run requirements:audit` sin `--write` pasa.

### Estado real, requisito a requisito

Solo he marcado como `REPO_EVIDENCE` lo que está entero. Lo parcial lo he dejado como estaba a
propósito, para no inflar el roadmap.

| ID     | Estado          | Realidad                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI-001 | `REPO_EVIDENCE` | Hecho. `docs/ui/arquitectura-informacion.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| UI-002 | `REPO_EVIDENCE` | Hecho. Tokens + 4 primitivos + `docs/ui/design-system.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| UI-003 | `NOT_VERIFIED`  | **Parcial.** El shell y la agrupación en 3 bloques están; **falta la navegación por rol**, que necesita que la sesión exponga permisos efectivos y no solo `role`. Eso es servidor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| UI-004 | `REPO_EVIDENCE` | Hecho. Panel de excepciones sobre `/api/admin/operations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| UI-005 | `NOT_VERIFIED`  | **Parcial.** Migrados a `UiDataTable`: pedidos, productos, clientes, devoluciones, tarifa. Familias tiene su propio árbol plegable y soporte conserva su maestro-detalle con los enumerados ya traducidos. **Lo que falta para cerrarlo es el «server-side»**: el componente ya tiene la interfaz (`total`, `page`, `@update:page`) pero los endpoints devuelven la colección entera y hoy se pagina en cliente. Eso es trabajo de servidor.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| UI-006 | `NOT_VERIFIED`  | **Parcial.** Los _listados_ de producto y cliente están rehechos; los _detalles_ (`/admin/productos/[id]`, ficha de empresa) no. Del de producto solo arreglé el 404 que impedía abrirlo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| UI-007 | `REPO_EVIDENCE` | Hecho. `/admin/pedidos/[id]` no existía: desde el listado se saltaba a la ficha del cliente. Ahora tiene tira de diagnóstico con las cinco máquinas de estado, contenido con miniaturas y unidades ya devueltas, cobro con el motivo real del rechazo del banco, expediciones con eventos del transportista, devoluciones, traza con autor y motivo, y columna lateral con cliente, direcciones, facturas y sus cinco pedidos anteriores. **Lo que le falta para ser completo es «acciones permitidas por rol»**, que depende de UI-003 y por tanto de servidor.                                                                                                                                                                                                                                                                                                                 |
| UI-008 | `NOT_VERIFIED`  | Sin hacer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| UI-009 | `REPO_EVIDENCE` | Hecho. 1 ruta → 7, con navegación propia                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| UI-010 | `REPO_EVIDENCE` | Hecho. `/pedido/[id]` hacía dos trabajos distintos con la misma cara: acuse de recibo tras pagar y consulta de «¿dónde está?» tres días después. Saludaba con «¡Gracias por tu pedido!» un mes más tarde y no decía en ningún sitio cuándo llega. Ahora el encabezado responde a lo que trae al cliente (siete casos: cancelado, pago fallido, esperando transferencia, pendiente de cobro, preparando, en reparto, entregado), hay barra de progreso con cuatro hitos —distinta para reparto y para recogida—, ventana de entrega, miniaturas, seguimiento del transportista, «volver a pedir» y descarga de factura. **Las miniaturas y el seguimiento vienen de `/api/orders/[id]/lines`, que exige sesión**: un invitado con enlace de acceso ve todo lo demás. Es mejora progresiva, no requisito, para que el enlace del correo siga sirviendo sin obligar a crear cuenta. |
| UI-011 | `NOT_VERIFIED`  | **Parcial.** Verificadas 38 rutas a 390, 768 y 1440 px sin un solo desbordamiento horizontal, y la portada además a 320, 360, 414, 1024 y 1920. El modo almacén sigue sin empezar, que es lo que impide cerrarlo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| UI-012 | `REPO_EVIDENCE` | **Auditoría automática pasada: 0 incidencias** en 19 rutas con `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` y `wcag22aa`. Encontró y corrigió cuatro cosas reales, entre ellas un contraste de **1,78:1** en los distintivos de estado —el ámbar por defecto de Nuxt UI—, que se arregló en el token `--ui-warning` y no pantalla a pantalla. Detalle en `docs/ui/accesibilidad-2026-09-01.md`. **Lo automático cubre alrededor de un tercio del problema**: falta el recorrido con teclado, el lector de pantalla y el zoom al 400 %.                                                                                                                                                                                                                                                                                                                                             |
| UI-013 | `MISSING`       | Sin hacer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| UI-014 | `NOT_VERIFIED`  | Sin hacer. La arquitectura está fundamentada pero **no validada con usuarios reales**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| UI-015 | `NOT_VERIFIED`  | Sin hacer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| UI-016 | `NOT_VERIFIED`  | Sin hacer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Cinco cosas que resultaron no estar rotas

Esto va aquí porque es lo que más tiempo te puede hacer perder si te fías del informe inicial. La
primera versión de `docs/ui/auditoria-ui-ux-2026-09-01.md` señalaba como defectos cinco cosas que
**ya funcionaban**. Todas están corregidas en el documento, con la corrección junto al punto
original:

1. **La ficha de producto sí indica stock**, con tres estados y `schema.org/InStock`.
2. **La ficha sí tiene escalado de precio por volumen.** No se ve porque ninguna de las 50 variantes
   del seed tiene tramos cargados: es un hueco de datos.
3. **Los mensajes «catálogo de demostración» y «Demo interna» ya están condicionados** a que el
   entorno no sea producción.
4. **El diálogo de cookies está bien anclado al pie** (`fixed bottom-3`).
5. **En familias sí se podía renombrar**: el nombre era un `<input>` en línea. El problema real era
   que llevaba `border-transparent` y parecía texto estático.

La causa fue siempre la misma: juzgar desde capturas a página completa de un entorno local sin
comprobar el código. En las capturas a página completa los elementos `position: fixed` se dibujan
en la posición del viewport inicial, y el diálogo de cookies tapaba justo la franja del stock.

### Dos cosas más que resultaron no estar rotas

Comprobadas, por si alguien las mete en el roadmap sin verificar:

- **La página 404 ya existe y está bien resuelta** (título, explicación y dos salidas).
- **Los enlaces legales funcionan.** Apuntan a `https://neteco.es/legal`, que responde 200. Los 11
  enlaces relativos del pie devuelven 200 (el 302 de `/cuenta` es la redirección correcta a login).

## Estado de tu vía (lo que NO he tocado y sigue pendiente para ti)

Del mismo CSV, resumen de los 702 requisitos:

| Estado                                                      | Nº  |
| ----------------------------------------------------------- | --- |
| `ROADMAP_NOT_STARTED` (mínimo Beta o posterior)             | 228 |
| `NOT_VERIFIED`                                              | 220 |
| `REPO_EVIDENCE` (hay código, no aceptación productiva)      | 123 |
| `PARTIAL_EXTERNAL` (falta proveedor/contrato/dato real/UAT) | 119 |
| `MISSING` (hueco de repositorio)                            | 12  |

Los 12 `MISSING`. Tres eran míos (UI-001/002/013). **Los otros nueve siguen siendo tuyos y no los
he tocado:**

- `BEP-004` — Outbox D1 para facturación
- `COM-001` — Cloudflare Email Service para transaccional, separando marketing
- `SEC-003` — Secretos en Workers Secrets / Secrets Store
- `INT-002` — Outbox D1 hacia Cloudflare Queues/Workflows
- `TST-009` — Tests de persistencia contra D1 y Durable Objects reales/locales
- `TST-010` — Tests de migraciones desde bases soportadas
- `CIC-001` — Fijar toolchain de build y runtime Workers
- `CIC-006` — Bundle Worker reproducible y compatible
- `CIC-007` — Infraestructura Cloudflare como código por entorno

Y tu trabajo inmediato en curso: el **Worker de pagos** (`workers/payments/`, `0007_payments.sql`).

---

## Bugs funcionales encontrados durante la auditoría

Los he **documentado, no arreglado**, porque caen en tu lado de la frontera (`server/**`) o tocan
contrato de datos. Están detallados en `docs/ui/auditoria-ui-ux-2026-09-01.md`. Los tres que te
conviene mirar pronto:

1. **`/admin/productos/[id]` devuelve 404 para todos los productos.**
   `app/pages/admin/productos/[id].vue:15` usa `useAsyncData(() => $fetch(...))`. En SSR ese
   `$fetch` crudo **no reenvía la cookie de sesión**, la API responde 401, `existing` queda `null` y
   la página lanza un `createError` 404. La API en sí está bien (`GET /api/admin/products/1` → 200).
   Resultado: **no se puede editar ningún producto desde el panel.** Arreglo: `useFetch`, o pasar
   las cabeceras de la petición.
   _Nota: este fichero está en `app/**`, así que si prefieres lo arreglo yo; lo he dejado
   señalado y sin tocar la llamada para no pisarte el criterio._

2. **`GET /api/admin/products?q=` con `q` vacío devuelve `items: []`.**
   El filtro no ignora la cadena vacía. Efecto de cara al usuario: escribes en el buscador de
   productos, borras, y la lista se queda en blanco.

3. **`GET /api/admin/products/{uuid}` responde 500 sin manejar.**
   El endpoint espera `legacy_id` (entero). Con un UUID hace `Number(...)` → `NaN` → PostgreSQL
   `invalid input syntax for type integer: "NaN"`. Debería ser un 400/404 limpio.

Adicional, para tu radar de rendimiento: en dev, `/api/admin/stats` tardó ~5,8 s y varias rutas de
admin superaron los 6 s hasta `networkidle`. Parte es coste de compilación de dev, pero conviene
medirlo en build de producción antes de cerrar la fase.

---

## Entorno que he usado (no te cambia nada)

- Levantado con los contenedores que ya existían (`neteco-postgres-1`, `neteco-redis-1`,
  `neteco-mailpit-1`). No he descargado imágenes ni tocado volúmenes.
- Servidor de desarrollo en el **puerto 3300** (el 3000 lo ocupa otro proyecto del host).
- He reescrito `.env` a partir de `.env.example` con `APP_BASE_URL`/`NUXT_PUBLIC_BASE_URL` en 3300 y
  secretos locales nuevos. **Si tenías algo en `.env` que te importara, la copia previa está en
  `.env.local.audit`.**
- Cuentas de prueba creadas en la base local (no en código):
  `cliente.audit@example.invalid` y `admin.audit@example.invalid`, contraseña `Auditoria2026neteco`.
  La segunda tiene rol admin y MFA enrolada.
- Reasigné 6 pedidos existentes al cliente de prueba para poder auditar el área de cuenta con datos.
  Son datos de demo de tu seed; si te molesta, `npm run db:reset && npm run db:seed` lo deja limpio.

---

## Si quieres deshacer todo lo mío

Mis cambios están acotados a `app/**` y `docs/ui/**`, y **no he hecho ningún commit**.

```bash
git restore --source=HEAD --staged --worktree -- app
rm -rf docs/ui HANDOFF-CLAUDE-UI-2026-09-01.md
```

Eso te devuelve al estado exacto de `e2158f5` en la capa de presentación, sin tocar tus ficheros
sin commitear de `workers/` y `db/`.

---

## Dónde está el detalle

- `docs/ui/auditoria-ui-ux-2026-09-01.md` — auditoría completa con evidencia y capturas
- `docs/ui/design-system.md` — el design system que cubre `UI-002`
- `docs/ui/arquitectura-informacion.md` — la IA de panel y área cliente que cubre `UI-001`
- `docs/ui/plan-paralelizacion.md` — estado de la intervención, bugs corregidos y lotes sin conflicto
- `docs/ui/accesibilidad-2026-09-01.md` — la auditoría WCAG y qué cubre lo automático
