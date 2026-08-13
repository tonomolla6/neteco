# Releases reproducibles de catálogo

El catálogo productivo no nace del seed sintético ni de scraping directo. NETECO es maestro de publicación; el proveedor aporta datos/documentos en cuarentena, Beply es maestro fiscal y un ERP futuro solo será maestro de los campos acordados. Un campo no puede tener dos maestros simultáneos.

## Generar y revisar

En un entorno PIM/staging validado, con assets ya escaneados y derechos aprobados:

```sh
DATABASE_URL=... npm run catalog:release -- export ./neteco-catalog-2026.08.13.json 2026.08.13
```

El artefacto contiene IDs UUID inmutables, categorías, marcas, clases fiscales, perfiles logísticos, productos, variantes, identificadores, procedencia y metadatos de medios. Los binarios permanecen en el almacén de objetos versionado y se verifican por sus SHA-256. El JSON tiene checksum propio, permisos `0600` y debe pasar revisión/diff antes de promoverse.

## Aplicar

Tras migraciones, sobre un catálogo vacío:

```sh
DATABASE_URL=... APP_ENV=staging npm run catalog:release -- apply ./neteco-catalog-2026.08.13.json
```

Producción exige además `CATALOG_RELEASE_CONFIRM=release:<version>:<sha256>`. La aplicación es transaccional, bloquea versiones repetidas y registra import batch/release y conteos. Nunca sobrescribe un catálogo vivo: una nueva versión se prepara y valida en staging, se promociona mediante un proceso de diff explícito y usa forward-fix/redirects para cambios posteriores.

El readiness productivo rechaza ausencia de release, fuentes demo, imágenes fuera de la biblioteca aprobada, identificadores/excepciones ausentes, datos editoriales o dimensiones logísticas incompletas.
