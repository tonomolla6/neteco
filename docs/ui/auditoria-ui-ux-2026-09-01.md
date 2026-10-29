# Auditoría UI/UX de NETECO — 2026-09-01

**Alcance:** tienda pública, área de cuenta de cliente y panel de administración.
**Base auditada:** worktree `codex/neteco-produccion-20260812` en `e2158f5`.
**Método:** aplicación levantada en local (Postgres + Redis + Mailpit reales, datos de seed),
recorrido de 38 rutas con Playwright en dos viewports (1440×900 y 390×844), con tres sesiones
distintas: anónima, cliente autenticado y administrador con MFA verificada. 64 capturas a página
completa + sondeo directo de la API + análisis estático del código de `app/`.

Este documento cubre los requisitos **UI-001** (investigación de tareas, roles y arquitectura de
información) y sirve de base a **UI-003 … UI-012**.

---

## 1. Veredicto

El problema de NETECO **no es que esté feo**. Es que la capa de presentación nunca pasó por una
fase de diseño: se construyó pantalla a pantalla, cada una resolviendo su endpoint, sin una
arquitectura de información previa ni un sistema de componentes. El resultado tiene tres síntomas
que se repiten en todas las áreas:

1. **Sin jerarquía de tareas.** Todo pesa lo mismo. En el área de cuenta, la tarea que trae al
   99 % de los clientes —ver un pedido— está la última, después de la configuración de privacidad.
2. **El formulario como respuesta por defecto.** Donde debería haber una lista con un botón, hay
   un formulario desplegado de 14 campos. Donde debería haber un flujo, hay seis formularios
   apilados.
3. **La base de datos asomando por la interfaz.** `pending`, `company_admin`, `export`,
   `id 27`, UUIDs, y un bloque de documentación de `npm run db:migrate` en el panel principal.

A eso se suman **tres bugs que dejan funcionalidad muerta**, siendo el más grave que **no se puede
editar ningún producto desde el panel**.

Lo que sí está bien y hay que preservar: la paleta de marca está bien construida y es accesible,
la seguridad es seria (CSRF, MFA, rate limiting, auditoría), el copy comercial en castellano tiene
buen tono, y el catálogo público tiene una estructura de navegación razonable.

---

## 2. Bugs que dejan funcionalidad muerta

Estos no son opinables. Son fallos reproducibles encontrados durante el recorrido.

### 2.1 · CRÍTICO — No se puede editar ningún producto desde el panel

`/admin/productos/1` → **404**. Con cualquier id. Con sesión de administrador y MFA verificada.

Causa, en `app/pages/admin/productos/[id].vue:15`:

```js
const { data: existing } = await useAsyncData(`admin-product-${id}`, () =>
  isNew ? Promise.resolve(null) : $fetch(`/api/admin/products/${id}`)
)
if (!isNew && !existing.value) {
  throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado', fatal: true })
}
```

En SSR, ese `$fetch` crudo no reenvía la cookie de sesión. La API responde **401**, `existing`
queda `null`, y la página convierte ese 401 en un **404 fatal**. Verificado en el log del servidor:

```
"path":"/api/admin/products/7666dccb-...","statusCode":401
```

Y verificado que la API está sana: `GET /api/admin/products/1` → **200** con el producto completo.

Es el único sitio de `app/pages` con este patrón junto a `index.vue`. El resto usa `useFetch`, que
sí propaga las cabeceras.

**Impacto:** la pantalla de gestión de producto —el corazón del panel, 547 líneas— es inalcanzable.

### 2.2 · ALTO — Al borrar el buscador de productos, la lista se vacía

`GET /api/admin/products?q=` (cadena vacía) → `{ "items": [] }`.

El esquema acepta `q` vacío y lo mete en el `ILIKE` en vez de ignorarlo. El usuario escribe, borra
para volver a empezar, y se queda mirando una tabla en blanco.

### 2.3 · MEDIO — Un id mal formado tumba el endpoint con un 500 sin manejar

`GET /api/admin/products/{uuid}` → **500**, `PostgresError: invalid input syntax for type integer: "NaN"`.

El endpoint espera `legacy_id` (entero) y hace `Number(getRouterParam(...))`. Debería devolver
400 o 404 y no propagar el error de PostgreSQL.

### 2.4 · ALTO (UX) — El panel deja entrar sin MFA y luego rompe en cada pantalla

`app/middleware/admin.ts` comprueba **solo el rol**:

```js
if (user.value?.role !== 'admin') return navigateTo('/')
```

Pero toda la API de admin exige MFA (`requireAdmin` → `requirePermission(..., { mfa: true })`).

Consecuencia: un administrador sin MFA entra en el panel, ve la navegación completa, y **cada
pantalla le devuelve un error rojo genérico**. El panel principal muestra `—` en los cinco
contadores; `/admin/pedidos` muestra _«No se han podido cargar los pedidos.»_ centrado sobre una
página por lo demás vacía. En ningún momento se le dice que el problema es que le falta activar la
MFA, ni se le ofrece el enlace para hacerlo.

> Evidencia: `desktop-adm-admin-pedidos.png` (primera pasada, sin MFA) frente a la segunda pasada
> con MFA verificada, donde la misma pantalla carga los 14 pedidos correctamente.

### 2.5 · MEDIO — Rutas de admin que tardan más de 45 s en dev

`/admin/categorias` y `/admin/contenido` agotaron el timeout de 45 s hasta `networkidle` en la
primera visita. `/api/admin/stats` tardó **5,8 s**. Parte es coste de compilación en dev, pero
`stats` hace seis agregados sobre tablas ya pobladas y merece medición en build de producción
antes de cerrar fase.

### 2.6 · BAJO — Desbordamiento horizontal en móvil

A 390 px de ancho, tres pantallas desbordan y provocan scroll lateral del documento:

| Ruta                | Desbordamiento |
| ------------------- | -------------- |
| `/pedido/[id]`      | 33 px          |
| `/admin/productos`  | 25 px          |
| `/admin/categorias` | 42 px          |

---

## 3. Área de cuenta de cliente — el peor punto del producto

**Ruta única:** `/cuenta`. Un solo fichero de **583 líneas** que carga **siete recursos de API** y
renderiza **once secciones**, **seis formularios** y **unas 30 entradas de datos**.

**Altura de la página: 3.309 px en escritorio, 5.802 px en móvil.** Casi siete pantallas de scroll
en un móvil para una zona cuya tarea principal se resuelve en un vistazo en cualquier competidor.

### 3.1 Lo que el cliente viene a hacer, y dónde está

Orden de aparición real, de arriba abajo:

| Orden real         | Sección                                    | Frecuencia de uso real |
| ------------------ | ------------------------------------------ | ---------------------- |
| 1                  | Datos personales (nombre, teléfono)        | Rara                   |
| 2                  | Cambiar email                              | Muy rara               |
| 3                  | Solicitar cuenta profesional               | Una vez en la vida     |
| 4                  | Seguridad / MFA                            | Rara                   |
| 5                  | Sesiones activas                           | Muy rara               |
| 6                  | Cambiar contraseña                         | Rara                   |
| 7                  | Agenda de direcciones + formulario de alta | Ocasional              |
| 8                  | Comunicaciones                             | Rara                   |
| 9                  | Privacidad (RGPD)                          | Casi nunca             |
| 10                 | Favoritos                                  | Ocasional              |
| **11 — el último** | **Mis pedidos**                            | **Constante**          |

La tarea número uno del área de cliente está enterrada bajo diez bloques de configuración. Baymard
mide que el **78 % de los sites fallan** la directriz de «dar acceso a todas las funciones desde el
panel de cuenta», y que el **96 % fallan** la de ofrecer las siete rutas clave en el menú de
cuenta. NETECO no las falla: es que **no tiene menú de cuenta**. No hay barra lateral, no hay
pestañas, no hay anclas. Solo scroll.

### 3.2 Cuatro campos de contraseña en la misma página

La página pide `Contraseña actual` en tres formularios distintos (cambiar email, datos
profesionales, cambiar contraseña) más `Nueva contraseña` y `Repite la nueva contraseña`. Cinco
campos de tipo `password` conviviendo. Los gestores de contraseñas del navegador no saben cuál
rellenar y el usuario tampoco.

### 3.3 El formulario de dirección, siempre desplegado

Catorce campos (`Etiqueta`, `Uso`, `Destinatario`, `Empresa`, `NIF/CIF/VAT`, `Teléfono`,
`Dirección`, `Complemento`, `Código postal`, `Ciudad`, `Provincia/región`, `País ISO`,
`Instrucciones`, `Predeterminada`) permanentemente visibles, **incluso cuando el cliente no quiere
añadir ninguna dirección** y aunque su agenda esté vacía. Debería ser un botón «Añadir dirección»
que abre un panel lateral o un diálogo.

Además `País ISO` pide al cliente que escriba un código ISO de dos letras a mano, en un `input` de
texto con `maxlength=2`, cuando debería ser un selector de países.

### 3.4 La base de datos asomando

- `Estado: pending · company_admin` — dos valores de enumeración crudos, sin traducir, en la
  tarjeta de datos profesionales. El cliente no sabe qué es `company_admin`.
- Las solicitudes de privacidad se pintan como `{{ request.requestType }} · {{ request.status }}`,
  es decir `export · pending`, en inglés y en minúsculas, dentro de una interfaz en castellano.

### 3.5 Los códigos de recuperación de MFA, como texto plano corrido

```html
<p class="text-xs text-amber-700">Guarda estos códigos una sola vez: {{ mfaEnrollment.recoveryCodes.join(' · ') }}</p>
```

Los códigos que el usuario necesita para no perder su cuenta se muestran en un párrafo de 12 px,
en color ámbar sobre blanco, sin botón de copiar, sin descarga, sin confirmación de «los he
guardado» y sin poder volver a verlos. Es el peor sitio posible para el dato más crítico del flujo.

### 3.6 Sesiones activas sin información para decidir

Cada sesión se muestra como una fecha y un botón «Revocar». Sin navegador, sin sistema operativo,
sin IP aproximada, sin ubicación. El usuario no puede distinguir su propia sesión antigua de un
intruso, que es el único motivo por el que existe esa pantalla. El dato está en la base
(`auth_sessions` guarda hash de IP y user agent).

### 3.7 Los pedidos no permiten hacer nada

Cada pedido de la lista muestra número, fecha, número de artículos, estado y total. Y nada más:
sin miniaturas de producto, sin **repetir pedido**, sin descargar factura, sin seguimiento.

Para una tienda B2B de suministros esto es el fallo comercial más caro del producto. La literatura
del sector es unánime: para la mayoría de compradores B2B la funcionalidad más valiosa es **volver
a pedir lo del mes pasado en 30 segundos**, y el 75 % prefiere el autoservicio a hablar con un
comercial para una reposición. NETECO vende guantes, químicos y celulosa: productos de consumo
recurrente y predecible. **Repetir pedido no es una mejora, es el modelo de negocio.**

### 3.8 Maquetación

Dos columnas `lg:grid-cols-2` con tarjetas de altura muy dispar: la de «Datos personales» mide el
triple que la de «Seguridad», dejando un hueco blanco enorme a la derecha. Contenedor
`max-w-5xl` (1024 px) para una página que contiene una rejilla de 14 campos, que queda comprimida.

### 3.9 Nota sobre el banner de cookies

> **Corrección.** Una versión anterior de este informe afirmaba que el diálogo de consentimiento
> flotaba en mitad del contenido y tapaba el botón de compra. **Es falso.** El componente usa
> `fixed inset-x-3 bottom-3` y se ancla correctamente al pie del viewport.
>
> El error vino del método: en capturas a página completa, los elementos `position: fixed` se
> dibujan en la posición del viewport inicial mientras el resto de la página se estira, así que
> aparecen «en el medio». Verificado después con captura a viewport real.
>
> Queda como recordatorio de que una captura a página completa no sirve para juzgar elementos
> fijos.

---

## 4. Panel de administración

### 4.1 La navegación: trece elementos planos en una barra con scroll

```
Panel · Productos · Medios · Familias · Búsqueda · Contenido · Flags ·
Precios · Pedidos · Clientes · Devoluciones · Soporte · Operaciones
```

Trece destinos al mismo nivel jerárquico, en una única fila horizontal con `overflow-x-auto`. A
1440 px ya llega justo; en móvil se convierte en una segunda fila con scroll lateral, un patrón que
oculta destinos sin ninguna señal de que existan.

No hay agrupación. «Flags» (una herramienta de ingeniería) tiene el mismo peso visual que
«Pedidos» (la operación diaria del negocio). No hay separación entre **operar** (pedidos,
devoluciones, soporte), **catalogar** (productos, familias, precios, medios) y **configurar**
(flags, búsqueda, contenido, operaciones).

El requisito **UI-003** («Rehacer shell y navegación administrativa por rol») está sin hacer: la
navegación es idéntica para cualquier rol.

### 4.2 El panel principal no es un panel

`/admin` contiene cinco contadores (Productos, Variantes, Familias, Pedidos abiertos, Clientes) y
después **un bloque de documentación técnica** explicando cómo funciona la base de datos, con
`npm run db:migrate` y `npm run db:backup` en `<code>`.

Un README pegado en la interfaz. Ocupa el 70 % de la pantalla principal del panel.

Y los cinco contadores no son accionables: no dicen si el número es bueno o malo, no comparan con
ayer, y «Pedidos abiertos: 11» no lleva a los 11 pedidos que hay que despachar hoy.

El requisito **UI-004** pide literalmente un «dashboard operativo **de excepciones**»: lo que
necesita quien abre el panel a las 8 de la mañana es _qué está bloqueado y necesita mi decisión_ —
pagos pendientes de conciliar, pedidos sin expedir pasado el corte, devoluciones sin resolver,
stock negativo, colas con mensajes muertos. Ese dashboard no existe.

### 4.3 Tablas sin ninguna de las herramientas de una tabla

`/admin/pedidos` lista los 14 pedidos con columnas _Pedido, Fecha, Cliente, Líneas, Total, Estado,
Expedición, Ver_. Le falta absolutamente todo lo que hace útil una tabla operativa:

- **Sin búsqueda.** Sin filtros por estado, fecha, importe o método de pago.
- **Sin ordenación.** No se puede ordenar por importe ni por antigüedad.
- **Sin paginación.** Con 14 pedidos no se nota; con 14.000 la pantalla es inutilizable.
- **Sin selección múltiple ni acciones masivas.** No se pueden marcar diez pedidos como expedidos.
- **Sin exportación.**
- **Sin recuento.** No dice «14 pedidos» ni cuántos hay filtrados.

Y un problema más serio que todos los anteriores:

> **El estado del pedido es un `<select>` suelto en cada fila.**

Trece desplegables editables en una tabla de lectura. Basta un clic accidental o una rueda de
ratón sobre la tabla para disparar un cambio de estado. El código sí pide un motivo antes de
confirmar, pero lo hace con `window.prompt()`: un diálogo nativo del navegador, sin estilar, que
bloquea la pestaña, no valida en su sitio, no dice a qué pedido afecta más allá de un texto
concatenado, y que al cancelarse deja la tabla en un estado que hay que refrescar. El mismo patrón
se usa para pedir el código de servicio de la expedición y el motivo de cancelación.

Cambiar el estado de un pedido tiene consecuencias contables y de inventario. Debe ser una acción
explícita, no el efecto colateral de haber pasado el ratón por encima de una tabla, y su
confirmación debe ser parte de la interfaz, no un `prompt` del navegador.

Este mismo patrón se repite en el resto de listados. El requisito **UI-005** («Rehacer tablas y
listados operativos server-side») está sin empezar: no hay paginación de servidor en ninguna tabla.

### 4.4 Familias: 45 filas planas, y solo se pueden borrar

`/admin/categorias` pinta el árbol completo de 45 familias como una lista de 2.451 px de alto:

- **Sin plegar/desplegar.** Todo el árbol siempre abierto.
- **Sin buscar.**
- **Sin reordenar.** El campo `sort` existe en la base pero no hay forma de tocarlo.
- **Renombrar existe, pero no se ve.** Este informe afirmaba que la única acción por fila era
  borrar. **Es falso:** el nombre es un `<input>` editable en línea con un botón de guardar que
  aparece al cambiarlo. El problema real es que lleva `border-transparent`, así que **parece texto
  estático** hasta que lo pulsas. Si el auditor no lo encontró leyendo la pantalla, el operario
  tampoco. Es un fallo de affordance, no de funcionalidad.
- **Sin mover de familia.** `PUT /api/admin/categories/[id]` acepta `parentId` y valida ciclos,
  pero la interfaz no ofrece forma de reubicar una familia.
- Muestra `id 27` en cada fila, exponiendo identificadores internos.
- 43 de las 45 familias dicen «0 prod.», lo que sugiere que el recuento no cuenta los productos de
  las subfamilias.

### 4.5 Precios: una página de 6.766 px

`/admin/precios` es un muro de 50 variantes listadas una tras otra, sin tabla, sin filtro, sin
buscador, con un solo campo de entrada en toda la página. En móvil mide **9.631 px**. Con el
catálogo real (miles de referencias) esta pantalla no se puede abrir.

### 4.6 Estados vacíos y de carga sin diseñar

- `/admin/medios`, `/admin/soporte`, `/admin/busqueda`, `/admin/devoluciones`, `/admin/contenido`
  y `/admin/flags` renderizan a la altura exacta del viewport con entre 311 y 517 caracteres de
  texto: son **estados vacíos sin diseñar** —una tabla con una fila de «no hay datos»— que dejan
  el 80 % de la pantalla en blanco y no explican qué es esa sección, para qué sirve, ni cuál es la
  primera acción a realizar.
- El estado de carga es una **pantalla de bienvenida a página completa con el logo de NETECO
  centrado**. Capturé `/admin/clientes` en ese estado: 1440×900 px de blanco con un logotipo. En un
  panel de trabajo interno, donde el operario entra veinte veces al día, la carga debe ser
  esqueletos en su sitio, no un splash de marca.
- Los errores son texto rojo suelto centrado en una tarjeta («No se han podido cargar los
  pedidos.»), sin icono, sin causa, sin botón de reintentar, sin vía de escape.

---

## 5. Tienda pública — donde se pierde la venta

La home y la ficha de producto están mejor resueltas que el resto, pero fallan justo donde se
decide la compra.

### 5.1 El catálogo se muestra vacío

En la home, «Compra por familia» pinta **una sola tarjeta** (Guantes y protección) en una rejilla
preparada para varias, y «Productos destacados» pinta **un único producto** en una rejilla de
cuatro columnas, dejando tres huecos blancos. Con 45 familias en base de datos, el escaparate
enseña una. Un visitante nuevo concluye que NETECO vende guantes.

### 5.2 Las fotos de producto destruyen la credibilidad

Es el hallazgo comercial más grave de la tienda pública:

- La mayoría de productos muestran un marcador **«Imagen no disponible»** con un dibujo genérico
  de bote.
- Las pocas fotos reales son fotografías caseras: **una mano con un guante sobre una pared beige**,
  **unos guantes negros tirados sobre un escritorio junto a un teclado y un monitor Apple**.
- En la misma rejilla de «También te puede interesar» conviven dos marcadores de «imagen no
  disponible» y dos fotos caseras, con encuadres, fondos y proporciones distintos.

Para un proveedor profesional que pide a una empresa que le confíe su suministro recurrente, esto
comunica lo contrario de lo que pretende el copy («Marcas líderes», «Garantía profesional»,
«Más de 25 años»). La autoridad que construye el texto la desmonta la imagen.

### 5.3 La ficha de producto empuja la compra fuera de pantalla

El selector de formato son **cinco tarjetas verticales a ancho completo**, una por talla. Ocupan
tanto que el botón «Añadir al carrito» queda por debajo del pliegue en un portátil, y la quinta
talla aparece cortada. Con un producto de diez formatos —normal en químicos: 1 L, 5 L, 10 L, 20 L,
garrafa, bag-in-box— la ficha se vuelve impracticable.

> **Corrección importante (verificada en código el 2026-09-01).** Una versión anterior de este
> informe afirmaba que la ficha no tenía indicación de stock ni escalado de precio por volumen.
> **Ambas afirmaciones eran falsas.** El error vino de auditar sobre una captura donde el diálogo
> de cookies tapaba precisamente esa franja de la página, y de no comprobarlo en el código antes
> de escribirlo.
>
> Lo que la ficha **sí tiene ya**:
>
> - **Indicador de disponibilidad** con tres estados: «N disponibles», «Pocas unidades · N
>   disponibles» y «Agotado», con punto de color y `schema.org/InStock`.
> - **Escalado de precio por volumen** («Desde N unidades — X €/ud IVA incl.»). No se ve porque
>   **ninguna de las 50 variantes del seed tiene tramos cargados**: es un hueco de datos, no de
>   interfaz.
> - **Precio de referencia de los 30 días anteriores**, que es cumplimiento de la directiva Omnibus.
> - **Calculadora de entrega por código postal** con fecha estimada y aviso de bajo pedido.
>
> Es bastante más de lo que tienen la mayoría de tiendas B2B españolas. El problema de esta ficha
> es de **densidad y jerarquía**, no de falta de funcionalidad.

Lo que sí falla, verificado:

- **Dos botones compiten por ser el principal:** «Añadir al carrito» (azul de marca) y «Comprar
  ahora» (gris oscuro, con icono de rayo). No hay una acción primaria clara.
- **Cero prueba social.** Sin valoraciones, sin «X empresas de tu sector lo compran», sin
  logotipos de clientes, sin sellos. La investigación reciente es consistente en que la señal que
  aún funciona es la del **par reconocible** —un cliente del mismo sector— por encima del volumen
  de reseñas anónimas.

> **Corrección.** Este informe señalaba como defectos el mensaje «Sin documentos asociados en el
> catálogo de demostración» y el sello «Demo interna · los productos y precios no son reales» del
> pie. **Los dos están ya condicionados a que el entorno no sea producción**
> (`runtime.public.appEnv !== 'production'` y `!isProduction`). No se filtran a nadie: son
> marcadores deliberados de desarrollo. Mismo error de método que en el punto anterior: juzgar
> desde una captura de local sin comprobar el condicional.

Lo que sí queda pendiente de negocio, no de interfaz: en una tienda de químicos la **ficha de datos
de seguridad es obligatoria** y además vende. Hoy no hay ninguna cargada, así que el bloque no
tiene qué enseñar. Es un hueco de contenido.

### 5.4 Incoherencia en cómo se dice el precio

En la misma rejilla conviven tres formulaciones distintas:

- `5 formatos · desde` **4,23 €**
- `4 formatos · desde` **5,03 €**
- `IVA incluido` **11,74 €**

Unas tarjetas cualifican el precio por número de formatos y otras por impuestos. El comprador no
puede comparar dos productos de un vistazo, que es exactamente lo que hace en una rejilla.

### 5.5 Dos buscadores a la vez

La cabecera lleva un buscador y el hero lleva otro, visibles simultáneamente en la primera
pantalla, con textos de ayuda distintos («Busca por nombre o referencia…» y «¿Qué necesita tu
negocio?»).

### 5.6 La banda «eco» rompe el sistema de color

El bloque de la línea ecológica usa un verde saturado a sangre que no pertenece a la paleta de
marca ni a ninguna escala semántica del sistema. Es el único elemento de la home con ese
tratamiento y lee como un anuncio de terceros incrustado.

---

## 6. Sistema de diseño: no existe

Medido sobre el código de `app/`:

| Señal             | Medición                                                                                                    | Lectura                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Radios de esquina | `rounded-2xl` ×76, `rounded-lg` ×59, `rounded-xl` ×53, `rounded-full` ×53, `rounded-md` ×3, `rounded-sm` ×1 | Cuatro radios compitiendo sin regla        |
| Tonos de gris     | 11 escalones de `slate` distintos; `slate-500` ×181                                                         | Sin escala definida de texto/borde/fondo   |
| Tamaños de texto  | 9 tamaños; `text-sm` ×245 y `text-xs` ×109                                                                  | El 80 % de la interfaz por debajo de 14 px |
| Tarjeta           | `rounded-2xl border border-slate-200 bg-white p-6` copiado **49 veces**                                     | No existe componente `Card`                |

**Componentes reutilizables en todo el proyecto: 17.** Ninguno es primitivo de diseño: son piezas
de dominio (`ProductCard`, `AdminOrderTable`, `VariantSelector`…). No hay `Card`, ni `PageHeader`,
ni `DataTable`, ni `EmptyState`, ni `StatCard`, ni `FormSection`. Por eso cada pantalla se remaqueta
a mano y ninguna se parece a la anterior.

`text-sm` como tamaño dominante en 245 apariciones es el origen del aspecto «apretado y amateur»:
la interfaz entera está un escalón por debajo del tamaño de lectura cómoda.

Lo que **sí** está bien y es la base sobre la que construir: la paleta `--color-neteco-50…950`
alrededor del azul de marca `#009ac9` está correctamente derivada, y `main.css` ya documenta que
los tonos elegidos para `--ui-primary` (`neteco-700`), error y éxito mantienen 4.5:1. **La marca no
es el problema. El problema es que no hay sistema alrededor de la marca.**

---

## 7. Accesibilidad (UI-012, WCAG 2.2 AA)

Positivo: existe enlace «Saltar al contenido», `htmlAttrs.lang="es"`, uso extensivo de
`UFormField` con etiquetas reales, y algún `aria-label` puntual en botones de icono.

Pendiente:

- **`slate-500` sobre `slate-50`** (el fondo del `body`) queda en el límite de 4.5:1, y se usa 181
  veces para texto secundario. Sobre las tarjetas blancas pasa; sobre el fondo de página, no en
  todos los pesos.
- **`text-xs` (12 px) en 109 sitios**, incluyendo información no decorativa como los códigos de
  recuperación de MFA y los estados de las solicitudes de privacidad.
- **Scroll horizontal del documento** en tres rutas a 390 px: incumple _Reflow_ (1.4.10).
- **La barra de navegación del panel con `overflow-x-auto`** oculta destinos sin indicador; en
  móvil es la única navegación.
- **Los `<select>` de estado dentro de la tabla de pedidos** no tienen etiqueta accesible propia;
  un lector de pantalla anuncia trece desplegables idénticos sin contexto de fila.
- **Los estados de error** se pintan como texto de color sin `role="alert"`, por lo que no se
  anuncian.

---

## 8. Prioridad de intervención

Ordenado por daño causado, no por esfuerzo.

| #   | Intervención                                                                | Requisito  | Daño que corrige                 |
| --- | --------------------------------------------------------------------------- | ---------- | -------------------------------- |
| 1   | Arreglar el 404 de edición de producto                                      | —          | Panel inutilizable               |
| 2   | Gate de MFA en el middleware del panel, con mensaje                         | UI-003     | Pared de errores sin explicación |
| 3   | Design system: tokens, `Card`, `PageHeader`, `DataTable`, `EmptyState`      | **UI-002** | Origen de todo lo demás          |
| 4   | Trocear `/cuenta` en subrutas con navegación propia                         | **UI-009** | La peor pantalla del producto    |
| 5   | Pedidos del cliente: detalle, repetir pedido, factura, seguimiento          | UI-010     | Pérdida comercial directa        |
| 6   | Shell del panel: agrupar 13 destinos en 3 grupos, barra lateral             | UI-003     | Navegación ilegible              |
| 7   | `DataTable` con filtros, orden, paginación de servidor y acciones masivas   | UI-005     | Tablas inoperables a escala      |
| 8   | Sacar el `<select>` de estado de la tabla; acción con confirmación y motivo | UI-005/007 | Riesgo de datos                  |
| 9   | Dashboard de excepciones que sustituya la documentación pegada              | UI-004     | Panel principal inútil           |
| 10  | Fotografía de producto y fichas de seguridad                                | —          | Credibilidad comercial           |
| 11  | Escalado de precio por volumen y stock en la ficha                          | —          | Conversión B2B                   |
| 12  | Familias: editar, plegar, buscar, reordenar                                 | UI-006     | Solo se puede destruir           |
| 13  | Estados vacíos, de carga y de error del sistema                             | UI-005     | 6 pantallas en blanco            |
| 14  | Consentimiento anclado abajo, sin tapar contenido                           | UI-012     | Bloquea la compra                |
| 15  | Reflow móvil y contraste                                                    | **UI-012** | WCAG 2.2 AA                      |

---

## 9. Anexo — evidencia

64 capturas a página completa en dos viewports, tres roles de sesión:

- Primera pasada (incluye el estado de admin **sin MFA**, útil como evidencia del punto 2.4)
- Segunda pasada (admin con MFA verificada, datos reales cargados)
- Tercera pasada (rutas de admin con identificadores correctos)

Datos de la instancia auditada: 20 productos, 50 variantes, 45 familias, 14 pedidos, 5 identidades.

### Fuentes consultadas para el marco de referencia

- [Accounts & Self-Service UX Best Practices — Baymard Institute](https://baymard.com/blog/current-state-accounts-selfservice)
- [Accounts & Self-Service UX Research — Baymard Institute](https://baymard.com/research/self-service)
- [The practical B2B UX guide: designing the My Account area — SparkLayer](https://www.sparklayer.io/blog/2024/11/12/b2b-account-area-ui/)
- [Index table — Shopify Polaris](https://polaris-react.shopify.com/components/tables/index-table)
- [Persuasion Techniques for Ecommerce — Shopify](https://www.shopify.com/blog/13-persuasion-techniques)
- [Trust Signals: placement framework — Digital Applied](https://www.digitalapplied.com/blog/social-proof-trust-signals-2026-conversion-placement-framework)
