# Regresión visual

`npm run test:visual` compara seis plantillas públicas en breakpoints estables de 1440×1000 y 390×844. Los doce baselines PNG están versionados junto al spec y requieren revisión humana cuando cambia intencionadamente la UI.

La captura usa Chromium con `deviceScaleFactor=1`, locale `es-ES`, zona `Europe/Madrid`, esquema claro y reduced motion. El servidor de prueba fija `NETECO_TEST_NOW`; PostgreSQL, Redis y catálogo se aíslan y siembran de forma determinista. Antes de cada captura se espera `document.fonts.ready`, se cargan las imágenes y se desactivan animaciones, transiciones, caret y scroll suave.

El gate falla cuando el diff supera 0,2 % de píxeles. Playwright escribe actual, esperado y diff en `test-results/visual`; CI publica esa carpeta y `playwright-visual-report` incluso al fallar.

Para un cambio visual intencionado:

1. Ejecutar `npm run test:visual -- --update-snapshots` en Linux con la versión de Chromium instalada por Playwright.
2. Revisar las doce imágenes y cualquier diff, no aprobar baselines generados sin inspección.
3. Adjuntar el motivo del cambio al commit/PR y volver a ejecutar el gate sin `--update-snapshots`.
