# Design system NETECO — UI-002

Cubre el requisito **UI-002**, que estaba en `MISSING`: _«Crear design system funcional NETECO
inspirado en principios de Shopify»_.

«Funcional» es la palabra clave. Esto no es un manual de marca: es el conjunto mínimo de
decisiones que impide que la próxima pantalla vuelva a inventarse su propio espaciado.

---

## El principio de Polaris que aplicamos

> El comerciante no debería tener que descifrar un modelo de interacción nuevo cada vez que cambia
> de pantalla.

De ahí se derivan las tres reglas que gobiernan este sistema:

1. **Un problema, un componente.** Si dos pantallas resuelven lo mismo, comparten componente. La
   tarjeta genérica estaba copiada 49 veces como `rounded-2xl border border-slate-200 bg-white p-6`.
2. **Los estados no son opcionales.** Cargando, vacío, filtrado sin resultados y error forman parte
   del componente, no se añaden después. Seis pantallas del panel se quedaban en blanco por no
   tenerlos.
3. **La acción destructiva o contable nunca es un efecto colateral.** Se pide explícitamente, dice
   qué va a pasar y a qué registro afecta.

---

## Color

La paleta de marca **no se toca**. Estaba bien construida alrededor del azul `#009ac9` y con los
contrastes verificados. Lo que faltaba era una capa de **roles semánticos** encima, para que el
código de producto no volviera a elegir entre once escalones de `slate` a ojo.

| Rol                | Valor                  | Uso                                                  |
| ------------------ | ---------------------- | ---------------------------------------------------- |
| `--ui-primary`     | `neteco-700` `#056485` | Acción principal. Un solo botón primario por región. |
| `--canvas`         | `slate-50`             | Fondo de página                                      |
| `--surface`        | `#fff`                 | Tarjetas, tablas, diálogos                           |
| `--surface-sunken` | `slate-100`            | Contenido secundario dentro de una superficie        |
| `--text-strong`    | `slate-900`            | Titulares y cifras                                   |
| `--text`           | `slate-700`            | Cuerpo — 8,9:1 sobre blanco                          |
| `--text-muted`     | `slate-600`            | Secundario — 5,9:1, AA también sobre `--canvas`      |
| `--border`         | `slate-200`            | Separación por defecto                               |
| `--border-strong`  | `slate-300`            | Separación que necesita leerse                       |

**Cambio con impacto en accesibilidad:** el texto secundario pasa de `slate-500` (usado 181 veces,
al límite de 4,5:1 sobre el fondo de página) a `slate-600`, que cumple con holgura sobre ambos
fondos.

El azul de marca se reserva para **lo accionable**. Los estados usan la escala semántica de Nuxt UI
(`success`, `warning`, `error`, `info`), nunca el azul: un pedido «Pagado» en azul de marca sería
indistinguible de un enlace.

---

## Tipografía

Se mantiene el emparejamiento existente, que es una buena decisión: **Archivo** para titulares y
cifras (condensada, con carácter, aguanta bien un número grande) e **Inter** para cuerpo.

Lo que cambia es la escala. La interfaz vivía en `text-sm` (245 apariciones) y `text-xs` (109), es
decir, entera un escalón por debajo del tamaño de lectura cómoda. De ahí venía buena parte de la
sensación de «apretado».

| Uso                            | Tamaño                  | Peso            |
| ------------------------------ | ----------------------- | --------------- |
| Título de página               | `1.75rem` / 28 px       | 700, Archivo    |
| Título de sección              | `1.125rem` / 18 px      | 700, Archivo    |
| **Cuerpo (nuevo por defecto)** | **`0.9375rem` / 15 px** | 400, Inter      |
| Secundario                     | `0.875rem` / 14 px      | 400             |
| Etiqueta de columna            | `0.75rem` / 12 px       | 600, versalitas |

`text-xs` (12 px) queda reservado a etiquetas de columna y metadatos decorativos. **Nunca** para
información que el usuario necesita leer: los códigos de recuperación de MFA estaban a 12 px.

### Cifras tabulares

La clase `.tabular` (y los atributos `data-numeric` en tablas) activan `font-variant-numeric:
tabular-nums`. Obligatoria en cualquier columna de importes, cantidades o números de pedido: sin
ella las columnas de euros bailan y no se pueden comparar de un vistazo.

---

## Forma y elevación

Había cuatro radios compitiendo sin regla (`2xl` ×76, `lg` ×59, `xl` ×53, `full` ×53). Ahora son
tres decisiones con significado:

| Token              | Valor | Qué lo lleva                                      |
| ------------------ | ----- | ------------------------------------------------- |
| `--radius-control` | 8 px  | Lo que se pulsa o se escribe: botón, input, badge |
| `--radius-surface` | 12 px | Lo que agrupa contenido: fila, tarjeta interior   |
| `--radius-panel`   | 16 px | Lo que enmarca una región: panel, diálogo, tabla  |

`rounded-full` queda solo para píldoras y avatares.

**Elevación:** casi todo vive en el nivel 0 —borde, sin sombra—. Solo hay `--shadow-raised` (algo
que flota levemente) y `--shadow-overlay` (diálogos). Una interfaz de trabajo con sombras por todas
partes se lee como ruido.

---

## Componentes

Están en `app/components/ui/` y se autoimportan con el prefijo `Ui`.

### `UiSurface`

Sustituye a las 49 copias de la tarjeta. `tone` (`default` | `sunken` | `accent`) y `padding`
(`none` | `sm` | `md` | `lg`). **Regla: como mucho una superficie `accent` por pantalla**, y se
reserva para la acción principal.

### `UiPageHeader`

Título, descripción, recuento y acciones. El recuento va junto al título porque el operario
necesita saber cuántas cosas mira antes de decidir si filtra.

### `UiEmptyState`

Tres variantes: `empty` (no hay datos todavía), `filtered` (el filtro los ha escondido) y `error`.
Obliga a dar título y, casi siempre, una acción. Un vacío es una invitación a actuar.

### `UiDataTable`

El componente que faltaba. Incluye búsqueda con rebote, ranura de filtros, orden por columna,
paginación, selección múltiple con acciones masivas, recuento del rango visible, y los cuatro
estados. En móvil convierte cada fila en tarjeta —una tabla de ocho columnas a 390 px provocaba
scroll lateral del documento.

**Deliberadamente no acepta controles editables dentro de las celdas.** Es la regla que impide que
vuelva a aparecer un `<select>` de estado de pedido que se dispara con la rueda del ratón.

---

## Reglas de escritura

Las mismas que aplican al resto del producto, resumidas:

- **Nombrar por lo que el usuario controla, no por cómo está construido el sistema.** Ni `pending`,
  ni `company_admin`, ni `export · pending`. El mapa de traducciones está en
  `app/composables/useAccount.ts`.
- **El verbo de un botón sobrevive a todo el flujo.** Si el botón dice «Volver a pedir», el aviso
  dice qué se ha añadido, no «Operación completada».
- **Los errores no piden perdón y no son vagos.** Dicen qué ha pasado y cuál es la salida.
- **Cada elemento hace un solo trabajo.** Una etiqueta etiqueta; una pista da un ejemplo.

---

## Calidad mínima, sin anunciarla

- Foco visible y consistente en todo lo enfocable (`:focus-visible` con el azul de marca).
- `prefers-reduced-motion` respetado globalmente.
- Sin scroll horizontal del documento en ningún ancho.
- Estados de carga como esqueletos en el sitio donde estará el dato. **Nunca** una pantalla de
  bienvenida de marca: se ha eliminado el splash a página completa que tapaba contenido ya
  renderizado por el servidor y convertía el logotipo en el elemento LCP.
