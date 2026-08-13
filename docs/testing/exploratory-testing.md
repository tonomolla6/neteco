# Pruebas exploratorias guiadas por riesgo

TST-034 se ejecuta como una sesión acotada sobre el commit candidato, apoyada por sondas reproducibles pero gobernada por charters y observaciones. El paquete mínimo cubre exactamente checkout, panel, móvil, errores de proveedor y operación.

La ejecución conservada está en [`exploratory-runs/2026-08-13-tst034.json`](./exploratory-runs/2026-08-13-tst034.json). Se valida con:

```bash
npm run audit:exploratory
```

El comando comprueba con Git que el SHA ensayado existe, es ancestro del build actual y que ninguna sonda versionada enlazada por la sesión cambió desde entonces. Un cambio de esas pruebas/scripts obliga a repetir la sesión y actualizar el manifest; no se intenta guardar en un commit su propio hash autorreferencial.

## Protocolo

1. Fijar SHA, entorno, tester, revisor independiente y timebox antes de explorar.
2. Para cada área declarar misión, riesgos, heurísticas, setup y al menos dos escenarios. Variar orden, interrupción, repetición, permisos, viewport, tiempo y fallo según el riesgo.
3. Registrar confirmaciones, riesgos residuales y defectos; enlazar comandos, archivos o logs sanitizados que permitan reproducir la observación.
4. Todo hallazgo de producto usa un ID `EXP-DEF-NNN`, aparece tanto en el charter como en `defectBacklog` y conserva severidad, owner, estado, reproducción, esperado y observado. Un defecto resuelto necesita evidencia de retest. Si no se descubre ninguno, el backlog se registra explícitamente vacío.
5. El revisor comprueba el alcance y la coherencia después de terminar la sesión. El validador rechaza áreas ausentes/duplicadas, autorrevisión, referencias rotas, resultados no-pass sin backlog y defectos ocultos.

Los recorridos automatizados son sondas y oráculos de estado, no sustituyen la observación ni convierten servicios mock en aceptación externa. La emulación móvil tampoco acredita hardware físico; esas limitaciones quedan registradas como riesgos, no se ocultan para declarar un pase más amplio.
