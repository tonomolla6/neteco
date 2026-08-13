# Recuperación ante proveedores caídos

TST-025 se valida con `npm run test:recovery`. La suite forma parte también de `npm run test:integration`, por lo que la CI la ejecuta como gate obligatorio sin duplicar el trabajo.

La prueba usa una base PostgreSQL aislada por caso, datos deterministas y únicamente servicios loopback. No llama a proveedores externos ni reutiliza datos de otros tests.

## Matriz cubierta

- Beply devuelve HTTP 503. El job fiscal pasa a `retry`, pedido, pago e inventario conservan su estado y, al restaurar el proveedor, el mismo job termina con una sola factura y un solo evento fiscal.
- SMTP rechaza la conexión. El email pasa a `retry` sin registrar una entrega y, al restaurar el proveedor, termina con una única entrega durable.
- El carrier falla antes de aceptar `createShipment`. La transacción revierte sin expedición, etiqueta ni cambio del pedido; el reintento crea una sola expedición y una repetición es idempotente.
- Redis rechaza la conexión. El checkout y la captura siguen siendo atómicos porque no dependen de Redis; al restaurarlo, un cliente nuevo conecta y responde `PONG`.
- Un proxy TCP corta PostgreSQL después de dos escrituras de pago no confirmadas. PostgreSQL revierte ambas, una conexión nueva atraviesa el mismo endpoint restaurado y la captura real posterior produce una sola asignación y un solo evento de pago.

Las aserciones de integridad comunes exigen pedido `confirmed`, pago `captured`, inventario `allocated`, una reserva asignada, un movimiento de asignación y un evento de captura.

## Límites de la simulación

La evidencia demuestra recuperación de aplicación y cola frente a fallos reproducibles locales. No sustituye un ejercicio del proveedor cloud, una conmutación del PostgreSQL gestionado ni pruebas contractuales sobre respuestas ambiguas en las que un carrier pudiera aceptar la expedición y perderse después la respuesta. Esos ejercicios requieren el entorno contratado y evidencia operativa separada.
