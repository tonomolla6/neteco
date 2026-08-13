# Conciliación de transferencias bancarias

## Entrada automática

El conector bancario debe exportar un JSON con movimientos positivos confirmados. Cada movimiento conserva un
identificador estable del banco; nunca debe reutilizarse para datos distintos.

```json
[
  {
    "externalId": "movimiento-estable-del-banco",
    "bookedAt": "2026-08-13T12:00:00.000Z",
    "amountCents": 12345,
    "currency": "EUR",
    "reference": "NE0123456789"
  }
]
```

La ejecución es `BANK_TRANSFER_STATEMENT_PROVIDER=<banco> npm run reconcile:bank-transfers -- --file=<extracto>`.
Solo una referencia exacta, importe y moneda coincidentes y una reserva vigente confirman automáticamente. El job
puede repetirse: `(provider, externalId)` identifica el movimiento y un pedido solo admite un ingreso conciliado.

## Revisión manual

Las referencias ausentes o ambiguas, importes/monedas divergentes, reservas caducadas y pedidos ya pagados quedan en
`Administración → Operaciones`. La conciliación manual requiere el permiso `reconciliation.manage`, MFA y un motivo.
El servidor vuelve a validar pedido, importe, moneda y estado bajo bloqueo transaccional; la UI no puede forzar una
captura. Cada conciliación manual queda en el audit log.

## Respuesta operativa

- `matched`: pedido confirmado, stock asignado y factura en cola.
- `needs_review`: no cambiar el pedido; verificar extracto y referencia en el banco.
- conflicto de identidad bancaria: detener el importador y revisar el origen, porque el mismo `externalId` llegó con
  datos distintos.
- ingreso posterior a caducidad: no reabrir ni reasignar stock; tramitar revisión/devolución bancaria fuera del pedido
  cancelado.

No se deben importar datos personales, números de cuenta del ordenante ni conceptos completos adicionales: el libro
solo guarda identificador, fecha, importe, moneda, referencia y hash del payload mínimo.
