# Matriz de navegadores y dispositivos

## Soporte automatizado

`npm run test:browser-matrix` ejecuta el mismo smoke crítico, sin retries, contra los cinco proyectos de Playwright. Las versiones exactas de los motores quedan fijadas por `package-lock.json` y la imagen de CI.

| Proyecto        | Motor    | Perfil Playwright | Cobertura mínima                                                       |
| --------------- | -------- | ----------------- | ---------------------------------------------------------------------- |
| `chromium`      | Chromium | Desktop Chrome    | health, inicio, PDP, alta de carrito, carrito y protección de `/admin` |
| `firefox`       | Firefox  | Desktop Firefox   | el mismo smoke crítico                                                 |
| `webkit`        | WebKit   | Desktop Safari    | el mismo smoke crítico                                                 |
| `mobile-chrome` | Chromium | Pixel 7           | el mismo smoke y apertura/cierre de navegación móvil                   |
| `mobile-safari` | WebKit   | iPhone 15         | el mismo smoke y apertura/cierre de navegación móvil                   |

CI instala Chromium, Firefox y WebKit y conserva JUnit, traces, vídeo y screenshots de fallo en `test-results/browser-matrix`, además del informe HTML `playwright-matrix-report`. La suite E2E completa sigue ejecutándose en Chromium; esta matriz es un smoke de compatibilidad deliberadamente corto para detectar roturas de motor, viewport, touch y navegación crítica.

## Política de soporte

- Escritorio: versiones estables actuales de Chrome, Firefox y Safari representadas por los motores fijados de Playwright.
- Móvil: Chrome sobre Android y Safari sobre iOS en los perfiles objetivo anteriores, desde 390 CSS px de ancho.
- Una incompatibilidad reproducible en la matriz bloquea la release. No se añaden excepciones silenciosas ni retries.
- La emulación valida motor, viewport, touch y layout, pero no acredita teclado del sistema, WebView, memoria, GPU, red móvil ni comportamiento específico del hardware.

## Smoke en dispositivo físico

Antes de aceptar una release Alpha que cambie navegación, catálogo/PDP, carrito, checkout, autenticación o pago, QA debe ejecutar el recorrido en, como mínimo, un iPhone con Safari y un Android con Chrome dentro de la política de soporte. Debe registrar:

1. SHA y URL HTTPS de la release candidata; dispositivo, sistema operativo y versión del navegador.
2. Inicio → búsqueda/catálogo → PDP → carrito → checkout sandbox; apertura/cierre del menú y uso de teclado/autorrelleno.
3. Resultado, defectos y retest, con capturas o vídeo enlazados y aprobación de QA.

La evidencia no puede contener credenciales, datos personales ni tarjetas reales. Se conserva en el expediente de la release, no en Git. Hasta que esos dos recorridos físicos se adjunten a una release candidata, TST-028 permanece `PARTIAL_EXTERNAL`; un pase emulado de Playwright no se presenta como dispositivo real.
