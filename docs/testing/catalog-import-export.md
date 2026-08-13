# Importación, exportación y calidad del catálogo

## Contrato tabular

El contrato operativo admite CSV UTF-8 y XLSX. Su esquema está versionado por la lista exacta y ordenada `catalogTabularColumns` de `server/services/catalog-tabular.ts`; una cabecera ausente, extra, reordenada o desconocida se rechaza. Cada fila representa la relación entre un producto, una variante y un asset mapeado.

El round-trip conserva:

- IDs UUID/legacy y estados de producto, variante y asset.
- Categoría, marca, fuente maestra y `source_version`.
- Descripciones, uso, serie, destacado, atributos y datos regulatorios JSON.
- Identificadores, precio, coste, moneda, unidades, límites, dimensiones, seguridad, backorder, color e imagen de variante.
- Procedencia, licencia, autorización, checksum, derechos, cuarentena, texto alternativo y metadatos del asset.
- Rol, versión y orden de imágenes, fichas técnicas, SDS y certificados.
- Saldos de inventario por ubicación, incluidas cantidades física/bloqueada y versión.

Los objetos JSON deben ser objetos válidos, no arrays ni escalares. `requires_sds` debe coincidir con `product_regulatory_json.requiresSds`; esto evita dos fuentes contradictorias.

## Límites y entradas hostiles

- Máximo 20 MB por archivo, 25.000 filas y 20.000 caracteres por celda.
- CSV acepta BOM, comillas escapadas, comas y saltos de línea; solo se decodifica UTF-8 válido.
- XLSX admite exactamente una hoja y ninguna columna fuera del contrato.
- Las fórmulas XLSX y los valores ricos no soportados se rechazan. Los valores con prefijo de fórmula también se rechazan durante la validación.
- La exportación CSV neutraliza celdas interpretables como fórmulas y ambas exportaciones aplican los mismos límites.
- UUID, slug, estados, moneda, booleanos, importes, cantidades, dimensiones, MIME, checksum y timestamps se validan antes de tocar la base de datos.

La calidad también detecta legacy IDs, slug, SKU/EAN/GTIN, storage key y checksum duplicados; filas/mappings incoherentes; referencias o estados distintos a PostgreSQL; documentos que no son PDF; imágenes con MIME incorrecto; publicaciones sin variantes publicables; SDS ausente y assets publicados sin derechos aprobados o cuarentena limpia. Los assets deben usar un basename `clean/`, MIME JPEG/PNG/PDF y URL canónica `/media/<uuid>`. La imagen primaria de producto debe estar sincronizada con `attributes.image`, `imageAlt` e `imageRights`, que son los campos consumidos por storefront, feed y readiness.

## Flujo operativo

Todos los comandos requieren `DATABASE_URL`:

```sh
npm run catalog:tabular -- preview catalogo.csv
npm run catalog:tabular -- apply catalogo.xlsx supplier-2026.08 --dry-run
npm run catalog:tabular -- apply catalogo.xlsx supplier-2026.08
npm run catalog:tabular -- export catalogo-publicado.csv --status=published
npm run catalog:tabular -- rollback <batch-id>
```

`preview` y `--dry-run` consultan referencias y conflictos pero no escriben. El preview devuelve altas y checksum reproducible e independiente del orden de filas. `apply` toma un advisory lock, repite la comprobación dentro de la transacción, exige una única fuente maestra y que la versión coincida con todas las filas; inserta batch, release, catálogo, inventario, assets y mappings atómicamente.

En producción, la aplicación exige `CATALOG_IMPORT_CONFIRM=import:<version>:<checksum>` obtenido del preview revisado. La salida de exportación debe ser un archivo nuevo: el comando usa creación exclusiva y permisos `0600`.

Si cualquier constraint falla, PostgreSQL revierte toda la transacción, incluido el batch. Un batch aplicado puede revertirse explícitamente; se eliminan solamente los IDs de su manifiesto y el batch pasa a `rolled_back`. El rollback se niega si un asset importado ya está referenciado como logo de marca o si una constraint posterior impide eliminar datos utilizados.

## Evidencia automatizada

- `tests/unit/catalog-tabular.test.ts`: CSV/XLSX, encoding, fórmulas, límites, cabeceras, duplicados, incoherencias, completitud y documentos.
- `tests/integration/catalog-import.test.ts`: dry run sin efecto, diff/checksum, apply PostgreSQL, conflicto, round-trip completo, rollback automático y rollback explícito.

Ambas suites forman parte de los gates unitarios, integración y coverage de CI.
