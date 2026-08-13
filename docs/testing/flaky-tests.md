# Política de cero tests flaky

TST-035 aplica tolerancia cero: un rojo bloquea aunque una ejecución posterior pase. No hay retry en Vitest ni Playwright, no se permiten `skip`, `todo`, `fixme`, `only`, tests marcados como fallo esperado ni `continue-on-error` en CI.

CI ejecuta dos veces de forma independiente los cuatro proyectos Vitest mediante `npm run test:flake-monitor`, y el smoke crítico de los cinco perfiles Playwright mediante `npm run test:flake-browser`. El primer resultado nunca se sustituye por el segundo: una diferencia de estado, una ejecución ausente o cualquier estado distinto de `passed` produce salida no cero. Los artifacts `test-results/flaky-rate.json` y `test-results/flaky-browser-rate.json` publican tests distintos, ejecuciones, inconsistencias, fallos y tasa flaky; el objetivo obligatorio es exactamente `0` en ambos denominadores por ejecución CI.

`npm run test:flaky-policy` audita además código y configuración para impedir cuarentena o retries silenciosos. E2E completa, visual, accesibilidad, rendimiento y mutation conservan una sola oportunidad y bloquean directamente si fallan; Vitest y la matriz crítica se repiten como ejecuciones independientes, no como retry perdonado.

## Tratamiento de una inestabilidad

1. Conservar el artifact y los logs del primer fallo; una repetición manual sirve para clasificar, nunca para volver verde el job original.
2. Abrir defecto con test, seed/namespace, commit, entorno, primer error, frecuencia observada, owner y fecha objetivo.
3. Bloquear la release o reparar la causa. Si el entorno externo impide ejecutar, el gate queda bloqueado: no se comenta, no se salta y no se convierte en fallo esperado.
4. El cierre exige prueba de estrés/repetición pertinente y tasa cero. No existe una lista de cuarentena aceptada.

La ventana versionada es cada ejecución CI: dos observaciones por test Vitest y por perfil del smoke Playwright. Los artifacts conservados permiten agregar tendencia entre ejecuciones, pero no se afirma una tasa histórica del proveedor CI si todavía no se ha integrado un almacén externo de series temporales.
