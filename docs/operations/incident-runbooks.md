# Runbooks de incidentes críticos

Todos los incidentes tienen un comandante, un escriba, una correlación/timeline y una severidad. Se preserva evidencia sin copiar secretos ni PII a chats. Antes de cerrar: reconciliación, comunicación, acciones con owner/fecha y postmortem sin culpa.

## Pago ambiguo o Redsys degradado

1. Desactivar nuevas iniciaciones si la firma/configuración no es fiable; no marcar pagado desde el retorno del navegador.
2. Consultar inbox, intento, eventos y banco por identificador; deduplicar antes de replay.
3. Mantener pedido `awaiting_payment`/`on_hold`, reserva con TTL controlado y mensaje honesto.
4. Reconciliar importe, moneda, comercio, terminal, estado y reembolsos. Solo el callback validado o una conciliación autorizada transicionan el pago.

## Sobreventa o inventario divergente

1. Bloquear variantes afectadas y nuevas reservas; no editar saldos directamente.
2. Comparar físico, bloqueado, reservas activas y suma del ledger; preservar movimientos.
3. Priorizar pedidos por captura/fecha y contactar alternativas o devolución. Aplicar ajuste con motivo, permiso y auditoría.

## Beply/fiscal

El pedido cobrado sigue a preparación cuando sea legalmente seguro. Separar 401/403 de 422 y 5xx; no reemitir a ciegas. Corregir mapeo o credencial, reencolar el mismo evento idempotente y conciliar documento, serie, importe, PDF y rectificativa.

## Carrier, etiqueta o tracking

No crear otra etiqueta sin comprobar la referencia idempotente. Usar contingencia manual registrada, conservar coste cotizado/real y tracking. Escalar mercancía ADR/palé únicamente al operador contractualmente habilitado.

## DB, Redis o worker

Sacar de readiness la instancia afectada. Redis puede degradar sesiones/limitación pero no sustituye PostgreSQL. Recuperar leases expirados, revisar backlog/edad/DLQ y ejecutar replay auditado. Para pérdida de datos seguir `restore-and-backup.md`.

## Deploy defectuoso, DNS o TLS

Detener promoción, conservar logs/versiones y revertir tráfico a la última imagen inmutable compatible. Las migraciones son forward-only: no bajar esquema; aplicar forward-fix. DNS/TLS se cambia con doble revisión, TTL planificado y verificación externa.

## Secreto expuesto o brecha

Revocar/rotar primero en el proveedor, invalidar sesiones/tokens afectados, preservar evidencia, limitar acceso y activar asesoría legal/DPO. Determinar datos, sujetos, ventana e impacto antes de comunicar; respetar plazos regulatorios. No incluir el secreto en tickets, logs o postmortem.

## Escalado pendiente de completar antes de producción

Operaciones debe rellenar en el gestor privado los nombres, suplentes y teléfonos de banco/Redsys, Beply, carrier, hosting, DNS/CDN, seguridad y asesoría. El repositorio no debe contener contactos personales ni credenciales.
