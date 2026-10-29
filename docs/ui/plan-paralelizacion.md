# Plan de trabajo de la reestructura UI

> **Actualizado el 2026-09-01, después de ejecutar la mayor parte del plan original.**
> La versión anterior repartía dieciséis lotes entre varios agentes. Buena parte ya está hecha,
> así que este documento pasa de ser un reparto a ser un **estado + lo que queda**, con los
> lotes restantes en el mismo formato por si conviene paralelizarlos.

---

## Estado

### Hecho y verificado

| Área                           | Qué se hizo                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Design system**              | Tokens (radios, roles de color y texto, cifras tabulares, foco, movimiento reducido) y cuatro primitivos: `UiSurface`, `UiPageHeader`, `UiEmptyState`, `UiDataTable`.                                                                                                                                                  |
| **Área de cliente**            | De una ruta de 583 líneas a siete con navegación propia. Pedidos desplegables con imagen, estado de envío y totales. «Volver a pedir». Descarga de factura y edición de dirección, que existían en la API sin exponerse.                                                                                               |
| **Panel, las 14 pantallas**    | Shell agrupado en tres bloques, panel de excepciones, y todas las pantallas migradas o revisadas. Fuera los `<select>` sueltos en tablas y los diez `window.prompt()`.                                                                                                                                                 |
| **Ficha del pedido (panel)**   | Pantalla nueva. Cinco máquinas de estado en una tira de diagnóstico, contenido con miniaturas, cobro con el motivo real del rechazo del banco, expediciones con eventos del transportista, traza con autor y motivo, y lateral con cliente, direcciones, facturas e historial.                                         |
| **Ficha del pedido (cliente)** | Hacía dos trabajos con la misma cara —acuse de recibo y consulta de «¿dónde está?»— y saludaba con «¡Gracias por tu pedido!» un mes después. Encabezado que responde a lo que trae al cliente, barra de cuatro hitos distinta para reparto y recogida, ventana de entrega, miniaturas, seguimiento y «volver a pedir». |
| **Tienda**                     | Portada reconstruida con auditoría de competencia. Ficha de producto a tres columnas con caja de compra fija. Catálogo, búsqueda, carrito y checkout revisados.                                                                                                                                                        |
| **Copia**                      | Reescritas envíos, formas de pago, devoluciones, ayuda y contacto: estaban en lenguaje de sistema («tarifa server-side», «modalidad autorizada», «RMA»).                                                                                                                                                               |
| **Accesibilidad**              | 0 incidencias de `axe` en 19 rutas con WCAG 2.0/2.1/2.2 AA. Integrado en `npm run test:a11y`.                                                                                                                                                                                                                          |
| **Responsive**                 | 168 medidas de **320 a 1440 px** sin un solo desbordamiento horizontal, incluido el mínimo de 320 que exige WCAG 1.4.10.                                                                                                                                                                                               |
| **Carrito y pago**             | Desglose que cuadra, IVA real, tarjeta visible, y barra de progreso hacia el envío gratis con el umbral que aplica de verdad.                                                                                                                                                                                          |

### Bugs corregidos por el camino

1. `/admin/productos/[id]` daba **404 para todos los productos**: `useAsyncData` + `$fetch` crudo no reenvía la cookie en SSR.
2. `crypto.randomUUID()` sin reserva en **14 puntos** de cliente: fuera de contexto seguro (HTTP) el checkout entero caía a un 500.
3. Contraste de **1,78:1** en los distintivos de estado, y `10 px` de tamaño de letra en el dato que dice si un pedido está pagado.
4. Cierre de sesión que acababa en el registro por una carrera con el middleware `auth`.
5. Desbordamientos horizontales en ficha de pedido, rejilla de familias y tabla de pedidos en tablet.
6. **Dos `h1` en las seis páginas de cuenta**: el layout ponía uno con el nombre del cliente y cada
   página añadía el suyo. Para un lector de pantalla son dos títulos de documento en conflicto. El
   del layout pasa a `<p>` —identifica la sesión, no la pantalla— y `/cuenta` estrena el suyo.
7. La empresa de un pedido se leía por `customers.company_id`, columna que no existe.
8. `/pedido/[id]` decía «Pedido confirmado» a pedidos **sin cobrar**, y un correo con local largo
   ensanchaba la rejilla 6 px a 390. Los hijos de una rejilla llevan `min-width: auto`: sin
   `min-w-0` y sin punto de corte, un solo token sin espacios desborda el documento entero.
9. El cartel **«Imagen no disponible»** salía once veces en una rejilla de veinte. Doce de las
   veinte referencias no tienen foto: el cartel anunciaba lo que falta en vez de enseñar lo que hay,
   y convertía una tienda que funciona en una que parece rota. La ilustración de familia ya dice el
   formato y el color, que es información real. En la ficha sí se dice, porque ahí alguien decide si
   compra — y se ofrece la salida útil en B2B: pedir la foto.
10. **Siete recuentos a 2,63:1** —facetas, menú de navegación, árbol de categorías— por usar
    `slate-400` sobre blanco. A `slate-500` (4,76:1) siguen leyéndose como secundarios.
11. **El checkout ocultaba el pago con tarjeta.** `v-if="bankTransferEnabled"` estaba pegado en la
    opción equivocada: con la bandera en `false` —como está— desaparecía la tarjeta, que es el
    método por defecto, y quedaba su explicación suelta sin control que elegir; la transferencia,
    en cambio, se mostraba siempre. Condición intercambiada.
12. **«IVA incluido: 0,00 €» en el checkout** sobre un pedido con 3,24 € de IVA: la línea leía
    `taxCents` de la tarifa de transporte, que vale cero mientras no hay envío cotizado. Es la
    línea que mira un cliente con empresa para deducirse el impuesto.
13. **El desglose del carrito no cuadraba a la vista**: «Subtotal 9,32 € + IVA 1,62 € = Total
    9,32 €». Los precios ya llevan el IVA dentro, así que el desglose solo lleva lo que se suma y
    el IVA baja a nota bajo el total.
14. **El umbral de envío gratis estaba escrito a mano** —«150 €»— en cuatro pantallas mientras el
    servidor lo lee de `FREE_SHIPPING_THRESHOLD_CENTS`. Bastaba cambiar la variable para que la
    tienda prometiera un umbral que ya no aplica. Ahora sale de `useFreeShipping()`, y sin umbral
    configurado las frases desaparecen en vez de mentir.
15. **Grids sin columna base, en 23 ficheros.** Un `sm:grid-cols-2` no declara columnas por debajo
    de ese punto: la pista implícita es `auto` y crece con su contenido, así que un correo o el
    nombre de una opción larga empujaban el documento entero. Era la causa común de los
    desbordamientos de checkout (86 px), catálogo (57 px) y carrito (16 px). `grid-cols-1` es
    `repeat(1, minmax(0, 1fr))`: la misma columna única que ya se veía, pero acotada.
16. **`/admin/soporte` y `/admin/productos` no cargaban**: página de error completa, las dos.
    Dos causas encadenadas y la misma raíz —la opción «Todos» del filtro valía cadena vacía—:
    `USelect` (Reka UI) reserva `''` para «sin selección» y una opción con ese valor revienta el
    render en servidor; y además el filtro viajaba como `?status=`, que el esquema del servidor
    rechaza por no estar en el enum. Ahora hay un centinela explícito que se traduce a «sin
    filtro» al construir la consulta.
17. **El barrido daba por buenas las páginas rotas.** La página de error de Nuxt se sirve con
    `200` y tiene su propio `h1`, así que pasaba las dos comprobaciones. Por eso `/admin/soporte`
    llevaba roto sin que nada lo dijera. La comprobación ahora mira también el título.
18. **La búsqueda sin resultados dejaba una caja blanca vacía** de 250 px donde iban los filtros:
    sin resultados no hay facetas. Se oculta, salvo que haya filtros puestos —pueden ser justo la
    razón de que no salga nada, y hay que poder quitarlos.
19. **La cola de trabajo enseñaba identificadores crudos** (`identity.verification.requested`) y
    daba por normal lo que no lo es: 39 eventos de hace 20 días con **cero intentos** no es una
    cola con trabajo, es una cola que nadie procesa. Ahora la frase va delante, el identificador
    debajo para buscar en logs, y hay aviso cuando el consumidor lleva parado más de un día.
20. Cuatro controles del panel **sin nombre accesible**. `UFormField` teje el `for`/`id` solo con
    componentes de Nuxt UI: pasarle `for` lo escupe como atributo del `div` y su `<label>` sigue
    apuntando a su id interno. Los dos `<select>` nativos pasan a `USelect` —de paso dejan de ser
    los únicos nativos del panel y el de envase deja de enseñar «capsulas» crudo—.

---

## Lo que queda

Cada lote toca ficheros disjuntos: se pueden lanzar a la vez.

| Lote                                               | Ficheros exclusivos                                          | Trabajo                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A · Paginación de servidor**                     | `server/api/admin/*.get.ts`, `server/api/products.get.ts`    | `UiDataTable` ya tiene la interfaz (`total`, `page`, `@update:page`) pero los endpoints devuelven la colección entera y se pagina en cliente. **Es lo único que impide cerrar UI-005.** Trabajo de servidor: coordinar con Codex. |
| **B · Resumen de líneas en el listado de pedidos** | `server/api/orders/index.get.ts`                             | El listado pide `/api/orders/[id]/lines` una vez por fila para las miniaturas. Con 25 por página es asumible; a escala no. Devolver 2-4 miniaturas y el recuento ya en el listado.                                                |
| **C · Navegación del panel por rol**               | `server/utils/auth-session.ts`, `app/layouts/admin.vue`      | Los tres grupos son iguales para todos. Para ocultarlos según permisos, la sesión tiene que exponer los permisos efectivos, no solo `role`. Cierra UI-003.                                                                        |
| **E · Devoluciones y expediciones completas**      | `app/pages/admin/devoluciones.vue`, pantalla de expediciones | UI-008. El listado está rehecho y la ficha del pedido ya muestra devoluciones y eventos del transportista; faltan el flujo guiado de incidencia y la impresión de etiquetas en lote.                                              |
| **F · Modo almacén**                               | `app/layouts/`, `app/pages/admin/`                           | UI-011. Interfaz para operar con guantes puestos y a un brazo de distancia: objetivos grandes, poco texto, escaneo de referencia.                                                                                                 |
| **G · Fixtures y harness de estados UI**           | `tests/`                                                     | UI-013, sigue en `MISSING`. Poder renderizar cada pantalla en sus cuatro estados sin depender de la base.                                                                                                                         |
| **H · Accesibilidad manual**                       | —                                                            | Teclado, lector de pantalla, zoom al 400 %. Lo automático cubre alrededor de un tercio. Cierra UI-012 de verdad.                                                                                                                  |
| **I · Validación con usuarios**                    | —                                                            | UI-014. La arquitectura está fundamentada en el modelo de datos y en investigación del sector, pero **no contrastada con clientes ni con almacén**.                                                                               |

---

## Reglas de convivencia

### Ficheros congelados

Propiedad compartida. Si un lote necesita cambiarlos, lo pide.

```
app/assets/css/main.css        ← tokens
app/components/ui/*.vue        ← primitivos
app/layouts/*.vue
app/composables/useAccount.ts
app/utils/catalogImages.ts
app/utils/adminOrder.ts        ← vocabulario de estados del pedido
```

### Frontera con Codex

`workers/**`, `db/**`, `server/**`, `shared/**`, `scripts/**`, `wrangler*`, `package.json` son suyos.
Los lotes de UI **solo leen** de ahí. Las excepciones ya hechas están en
`HANDOFF-CLAUDE-UI-2026-09-01.md`. Los lotes **A**, **B** y **C** tocan servidor y van coordinados.

### Definición de terminado

- Usa `UiSurface`, `UiPageHeader`, `UiEmptyState` y `UiDataTable` en vez de maquetar a mano.
- Cuatro estados: cargando (esqueleto, no splash), vacío, filtrado sin resultados, error con reintento.
- Sin controles editables sueltos dentro de celdas de tabla.
- Ningún valor de la base llega crudo a la pantalla.
- Sin scroll horizontal del documento entre 320 y 1920 px.
- `npm run lint`, `npm run typecheck` y `npm run test:a11y` en verde.
- Capturas antes/después a 390 y 1440 px.

---

## Plantilla para lanzar un lote

> Trabajas en `/devtono/_worktrees/neteco-produccion-20260812`, rama `codex/neteco-produccion-20260812`.
>
> **Lee primero:** `docs/ui/design-system.md`, `docs/ui/arquitectura-informacion.md` y
> `docs/ui/auditoria-ui-ux-2026-09-01.md` — este último incluye **cinco correcciones** de cosas
> que el informe daba por rotas y funcionaban. No te fíes de un diagnóstico sin verificarlo en el
> código.
>
> **Tu lote es «X». Solo puedes modificar:** «lista exacta».
>
> **No toques** los ficheros congelados ni el territorio de Codex.
>
> **Cómo validar.** `npm run dev -- --port «PUERTO»`; Postgres, Redis y Mailpit ya corren en Docker.
> Entra con `admin.audit@example.invalid` o `cliente.audit@example.invalid`, contraseña
> `Auditoria2026neteco`. Si el login da 429, borra `neteco:rate:login:*` de Redis.
>
> **Terminas cuando** se cumple la definición de terminado de este documento.

---

## Lo que ningún agente puede resolver

- **La fotografía.** Las 243 imágenes del repositorio son producto a 800×800 sobre fondo blanco:
  no hay ni una foto de ambiente. El escaparate usa las de producto, que es lo honesto con lo que
  hay, pero un hero con cocina, almacén o local necesita o una sesión propia o el kit de marca del
  proveedor, que como distribuidor suele venir con licencia de uso incluida. Bajar imágenes de
  banco sin registrar su licencia se salta el circuito de derechos que esta tienda ya tiene
  montado (`asset_license`, `asset_rights_status`, `asset_authorized_at`) y el importador las
  rechazaría.
- **Las fichas de datos de seguridad.** En una tienda de químicos son obligatorias y además venden.
  Hoy no hay ninguna cargada.
- **Los tramos de precio por volumen.** La ficha ya los muestra; ninguna variante los tiene
  cargados. Es decisión comercial, no de interfaz.
