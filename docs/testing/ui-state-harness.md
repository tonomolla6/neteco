# UI-013: estados deterministas y comparación visual

Este harness privado reutiliza Vitest/Nuxt y Playwright instalados. No instala
Storybook, añade rutas demo, crea sesiones o concede permisos. Los DTO son
fixtures sintéticos de presentación, no prueba de que un backend los haya servido.

`tests/fixtures/ui-state-harness.ts` selecciona explícitamente componente, ruta y
estado. Ofrece cola densa de 25 pedidos, vacío confirmado, carga retenida hasta
`settle()`, error, datos anteriores tras error y permiso denegado. UUID, fechas y
dominios de correo son deterministas. El actor usa `sessionVersion`, correo
verificado y MFA sólo en administración. El router sólo admite GET del recurso
seleccionado; cualquier escritura, recurso ajeno o uso tras `dispose()` falla.

Las pruebas de componente montan `AdminOrderWorkbench.vue` y la página real
`cuenta/pedidos.vue`, con la fila real `AccountOrderRow.vue`. Los paneles secundarios
de comandos/timeline/tracking y el diálogo de recompra se aíslan: no se atribuye a
estas imágenes cobertura de dichos flujos, que conservan sus suites dedicadas.

## Comprobaciones ejecutables

Con autorización del turno CPU y gates de recursos vigentes, un worker:

```sh
npx vitest run --config vitest.node.config.ts tests/unit/ui-state-harness.test.ts tests/unit/ui-state-visual-artifacts.test.ts --maxWorkers=1 --no-file-parallelism
npx vitest run --project component tests/components/ui-state-harness.test.ts --maxWorkers=1 --no-file-parallelism
```

La captura es opcional y no escribe nada por defecto. Tras disponer de CSS
Cloudflare compilado actual (`.output-cloudflare/public/_nuxt`, nunca el perfil
Node), ejecutar la suite de componentes con
`NETECO_UI_STATE_CAPTURE_DIR=test-results/ui013-components`. Sólo ese directorio
propio está permitido. Se guardan HTML de mounts reales, CSS real y hashes; no
datos de producción. Límites por caso: markup 512 KiB y CSS 4 MiB, doce casos.
El capturador rechaza directorios/targets symlink y archivos ajenos; sólo regenera
pares propios identificados por metadata y hash íntegro. Usa staging exclusivo
y limpia exclusivamente los temporales que creó.

## Baselines explícitas: no aprobación automática

`playwright.ui-state-harness.config.ts` compara los doce casos a **320, 768,
1024 y 1440 px**. Sólo conecta al Chromium remoto privado autorizado mediante
`PW_TEST_CONNECT_WS_ENDPOINT`; jamás lanza uno local ni inicia servidor. La
captura visual no realiza peticiones de red. `updateSnapshots: 'none'` es
obligatorio y el spec rechaza cualquier override que apruebe imágenes.

Las PNG revisadas deben existir en `tests/visual/ui013-reviewed-baselines/` antes
de acreditar regresión visual. Un revisor debe obtener candidatos bajo una tarea
autorizada, inspeccionarlos y aprobar su incorporación explícitamente; este
harness no los genera ni los acepta como baseline. Sin baseline la comparación
falla, no pasa vacía. No se han generado ni revisado PNG en esta entrega.

```sh
npx playwright test --config playwright.ui-state-harness.config.ts
```

Son imágenes **estáticas de componentes**, no evidencia de hidratación, layout
SSR final ni aceptación E2E del Worker. No se incorporan a los 51 journeys del
auditor compilado.
Los hashes CSS/HTML no prueban correspondencia entre los SFC/source y el hash del
bundle actual; falta esa provenance para acreditar aceptación compilada.

## E2E complementario preparado

`playwright.ui-state-routes.config.ts` ejecuta dos casos sobre las rutas reales
`/admin/pedidos` y `/cuenta/pedidos`, con cookies de fixtures efímeros obtenidas
por la autenticación real existente. Requiere origen aislado explícito
`NETECO_UI_STATE_E2E_ORIGIN` y `NETECO_UI_STATE_ADMIN_COOKIE` /
`NETECO_UI_STATE_CUSTOMER_COOKIE`; nunca imprimir sus valores. Comprueba lectura,
ausencia de writes/outbound, viewport y redirección al retirar la sesión. No
siembra autoridad ni consulta producción. No hay servidor fallback.

```sh
npx playwright test --config playwright.ui-state-routes.config.ts
```

Chromium, capturas, baselines y E2E quedan **pendientes, no acreditados**, hasta un
turno remoto autorizado con runtime y fixtures válidos. Las configuraciones no
constituyen evidencia de ejecución ni de CI Oracle. Conservar el presupuesto
host/cgroup y reservas de la política; limpiar sólo estos artefactos propios
cuando ya no se necesiten, nunca caches, sesiones o procesos ajenos.
