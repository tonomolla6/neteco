# Accesibilidad del panel y del área de cliente — UI-012

**Fecha:** 2026-09-01
**Herramienta:** `axe-core` vía `@axe-core/playwright`, ya presente en el proyecto.
**Reglas:** `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`.
**Cobertura:** 19 rutas con sesión de cliente y de administrador, a 1440×900.

## Resultado

**0 incidencias.**

Rutas auditadas: `/`, `/catalogo`, ficha de producto, `/carrito`, `/checkout`, las siete rutas de
`/cuenta`, `/login`, `/registro`, `/contacto`, `/ayuda`, `/admin`, `/admin/pedidos`,
`/admin/productos`, `/admin/categorias`, `/admin/precios`, `/admin/clientes`.

## Qué se corrigió para llegar aquí

| Incidencia       | Gravedad | Alcance           | Corrección                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `color-contrast` | Serious  | 14 nodos, 4 rutas | El ámbar por defecto de Nuxt UI daba **1,78:1** en los distintivos `subtle`: «Pago pendiente» y «En revisión» eran ilegibles. Se corrigió en el token (`--ui-warning`), no pantalla a pantalla. `amber-700` subía a 4,37 —todavía insuficiente—, así que quedó en `amber-800` (6,5:1). Igual para `--ui-info`. |
| `button-name`    | Critical | `/cuenta/pedidos` | El filtro de estado era un combobox sin nombre accesible.                                                                                                                                                                                                                                                      |
| `select-name`    | Critical | `/contacto`       | El desplegable de motivo no estaba asociado a su etiqueta.                                                                                                                                                                                                                                                     |
| `target-size`    | Serious  | portada           | Los puntos del carrusel medían 6 px. WCAG 2.2 exige 24×24 como mínimo: el punto sigue midiendo 6 px, pero su botón mide 24.                                                                                                                                                                                    |

Además, los distintivos de estado usaban `size="sm"` de Nuxt UI, que renderiza a **10 px**. Es el
dato que dice si un pedido está pagado: se subieron los 19 ficheros afectados al tamaño por
defecto (12 px).

## Lo que esto no cubre

Una auditoría automática detecta alrededor de un tercio de los problemas reales. **No** se ha
verificado todavía:

- Recorrido completo con teclado y trampas de foco en los diálogos.
- Lectura con lector de pantalla real (NVDA/VoiceOver) de los flujos de compra y de pedido.
- Orden de lectura y anuncios de cambios dinámicos (`aria-live`) en las tablas al filtrar.
- Zoom al 200 % y 400 % con reflujo.
- El modo almacén de `UI-011`, que no existe todavía.

Por eso `UI-012` queda como evidencia de repositorio, no como aceptación: el criterio de la
sección 9 pide cumplimiento, y el cumplimiento incluye lo manual.

## Cómo repetirla

Está integrada en la suite del proyecto:

```sh
npm run test:a11y
```

`tests/e2e/accessibility.spec.ts` ya cubría la tienda pública, el carrito, el checkout y dos
pantallas del panel. Se le han añadido dos pruebas nuevas que recorren **las seis rutas nuevas del
área de cliente** y **las seis pantallas del panel rehechas**, porque son justo donde más cambió la
interfaz y donde estaban las cuatro incidencias.

La prueba falla si aparece cualquier violación `serious` o `critical`, y adjunta el informe de axe
como artefacto para poder verlo en CI.
