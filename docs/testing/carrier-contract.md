# Contrato de carrier y gate de aceptación

TST-019 permanece bloqueado externamente por `DEC-014`: Compras/Logística debe seleccionar carrier, servicio, cuenta
de pruebas, cobertura, SLA y mecanismo de tracking. NETECO no incorpora nombres, endpoints, credenciales, límites ni
códigos de error de un proveedor hasta que exista contrato y documentación verificable.

## Baseline neutral ya ejecutable

`CarrierProvider` fija unidades (`g`, `mm`, céntimos EUR), dirección, bultos, perfiles, tarifa/IVA/ETA, expedición,
label binaria, cancelación, tracking, retorno y recogida. `MockCarrierProvider` y las suites unitarias/E2E prueban ese
contrato de forma determinista, incluida idempotencia, zonas, peso volumétrico, palé, ADR, polling, excepción,
entrega y entradas inválidas. El factory rechaza todos los adapters fake/manuales en producción.

Esta baseline valida la orquestación NETECO; no acredita compatibilidad con ningún carrier real.

## Matriz obligatoria tras DEC-014

El adapter seleccionado y sus fixtures versionados deben demostrar en sandbox:

- autenticación, endpoint por entorno, timeout, límites, redacción de secretos y errores 4xx/5xx;
- rate por código postal/zona, peso físico y volumétrico, número de bultos, palé, ADR, recargos, IVA y moneda;
- generación idempotente de expedición y label PDF/ZPL válida, tracking único y coste cotizado/real;
- cancelación antes y después de admisión, replay y conciliación del estado local con el carrier;
- tracking normalizado, orden alterado, duplicados, estado desconocido y entrega/incidencia;
- webhook firmado y deduplicado si el proveedor lo ofrece; si no, polling documentado con frecuencia, backoff y SLA;
- retorno elegible, label/instrucciones, tracking inbound y cancelación del retorno;
- pickup/manifiesto cuando sea contractual, fechas, cutoff, festivos y zonas remotas/insulares;
- payload inválido, rate vacío, auth, timeout, `429`, indisponibilidad, label/PDF corrupta y respuesta parcial.

La evidencia debe conservar versión/URL de documentación, fecha, tenant sandbox, identificadores sintéticos,
request/response saneados y capturas del portal. Nunca se guardan credenciales ni direcciones reales en el repo.
Hasta pasar esta matriz y el E2E de logística, TST-019 debe permanecer `PARTIAL_EXTERNAL`; después podrá reevaluarse
contra la evidencia conservada del proveedor.
