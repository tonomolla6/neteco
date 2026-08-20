# Estado de producción y trazabilidad

`requirements-traceability.csv` es el inventario automático de los 702 requisitos de la sección 9 del informe maestro. Se regenera con `npm run requirements:audit -- --write`; CI valida conteo, IDs únicos, fases y prioridades.

Los estados son deliberadamente estrictos:

- `REPO_EVIDENCE`: hay una ruta técnica local; todavía no equivale a aceptación productiva.
- `PARTIAL_EXTERNAL`: falta proveedor, contrato, dato real, aprobación, UAT o ejercicio operativo.
- `MISSING`: hueco de repositorio conocido.
- `NOT_VERIFIED`: no se ha demostrado cada átomo del criterio Alpha; no debe tratarse como aprobado.
- `ROADMAP_NOT_STARTED`: requisito cuyo mínimo es Beta o una fase posterior; no se afirma implementado.

Una fase solo puede cerrarse cuando todos sus requisitos acumulados tienen evidencia reproducible y las dependencias externas cuentan con aceptación formal enlazada. Mocks, páginas visibles y documentación de diseño no sustituyen pruebas contra proveedores reales ni ejercicios operativos.
