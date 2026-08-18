# Reporting y artefactos de CI

La política versionada de TST-036 está en `docs/testing/ci-artifacts.json`. Cada ejecución publica un artifact `quality-evidence` con JUnit de Vitest y Playwright, cobertura, rendimiento y diagnósticos de navegador. Las trazas, capturas y vídeo solo se generan ante fallo. El SBOM de aplicación se incluye en esa evidencia y el SBOM de contenedor en `container-image`; los artifacts no se convierten en assets públicos de una release.

La evidencia de calidad, el SBOM de aplicación y mutation se conservan 14 días. La imagen y evidencia de contenedor se conservan 3 días por tamaño. Los logs del workflow tienen una política operativa de 14 días en la configuración de Actions del repositorio. El acceso requiere permisos de lectura del repositorio.

## Redacción

CI usa exclusivamente datos y credenciales sintéticos; nunca se inyectan datos ni secretos de producción en las pruebas. Antes de `upload-artifact`, `npm run ci:artifacts -- --publish` recorre los artefactos textuales, redacta URLs con credenciales, cabeceras de autorización, campos de password/secret/token, claves privadas, emails no reservados para pruebas y valores sensibles presentes en el entorno. También extrae las trazas ZIP de Playwright, redacta cabeceras cookie/autorización, parámetros sensibles y contenidos textuales, y reconstruye el ZIP. Después crea `test-results/ci-evidence.json` con ruta, tamaño, tipo, número de redacciones y SHA-256 de cada archivo resultante.

Las trazas, capturas y vídeos son binarios producidos por el entorno aislado con identidades `.invalid` y proveedores mock/sandbox. El JSON bruto del monitor Playwright, que contiene su configuración de ejecución, se elimina siempre después de derivar la tasa flaky, también cuando Playwright falla. Si se necesita investigar un fallo, deben usarse el artifact restringido y los datos sintéticos; no se copian valores reales a una repetición.

`npm run ci:artifacts` valida el contrato de reporters, rutas, retenciones y redacción. Una ejecución verde exige `--require-complete`: JUnit de todas las suites, resumen de cobertura, rendimiento y SBOM deben existir. Ante un fallo anterior, una segunda ruta publica un manifiesto marcado `partial` con la lista explícita de ausencias, conservando solo la evidencia que haya superado la redacción. Ningún upload se ejecuta si el sanitizador falla.
