# Organización de fotos de producto

## Estructura
- **Químicos (marca + modelo)** → `<marca>/<modelo>.jpg` — ej. `delenex/dtr.jpg`, `nettion/gl-eco-p.jpg`.
  El producto base de la marca usa su propio nombre: `nettion/nettion.jpg`.
- **Resto de productos** → `<slug-del-producto>/principal.jpg` — ej. `guante-ignifugo-azul-par/principal.jpg`.
- **Variantes por color** (mantelería y similares) → dentro de la carpeta del producto:
  - `<acabado>/<COD>.jpg` → LA foto del color (código en MAYÚSCULAS, igual que Karme y el ERP).
    Una sola imagen para todo: usa la grande de Karme (~900×506), que sirve para la ficha y para el zoom.

  Ejemplo Novotex:
  ```
  rollo-mantel-novotex/
    principal.jpg
    precortado/AM.jpg
    sin-precorte/AM.jpg
  ```

## Cómo poner o cambiar una foto
- Si el fichero **ya tiene ese nombre asignado** (todas las combinaciones actuales del Novotex lo tienen),
  basta con **sobrescribir el archivo** — no hay que tocar nada en el panel.
- Para una variante nueva, pon la ruta en su campo «Imagen (ruta)» del panel de productos.

## Formato recomendado
- La del proveedor TAL CUAL, sin reprocesar: `https://clientes.karme.es/img/ItemVariantBig/<REF>/<COD>.jpg` (~900×506).
  Las de `ItemVariant/` (296×160) son correctas pero pequeñas para el tamaño de la ficha (~500 px): no hacen falta.
  Importante: nunca reescalar/regenerar las fotos con capturas u otros procesados — degrada la calidad; original siempre.
- (Opcional, futuro) si algún día hay fotos en alta resolución, se pueden dejar en `<acabado>/big/<COD>.jpg`
  y la lupa las usará automáticamente para el zoom.

## Fuente Karme
- Refs: `NR1X` = 1,00×50 sin precorte · `NR1.2X` = 1,20×50 sin precorte · `NRP1.2X` = 1,20×50 precortado
