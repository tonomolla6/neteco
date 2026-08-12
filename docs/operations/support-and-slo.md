# Soporte, SLO y continuidad

## Soporte inicial

| Canal                        | Horario/promesa inicial                                             | Owner                | Escalado                             |
| ---------------------------- | ------------------------------------------------------------------- | -------------------- | ------------------------------------ |
| Teléfono y formulario        | laborables 09:00–18:00 Europe/Madrid; acuse inmediato               | Soporte              | pago/stock/logística/fiscal por cola |
| Email transaccional          | asíncrono; nunca único canal para urgencias                         | Plataforma/Soporte   | DLQ + proveedor                      |
| Incidencia urgente de pedido | triage ≤ 30 min en horario; fuera de horario según guardia acordada | Operaciones          | banco, Beply, carrier, hosting       |
| Incidente de seguridad       | canal privado monitorizado                                          | Seguridad/Plataforma | plan de brecha y asesoría            |

Las promesas son defaults técnicos pendientes de ratificación con disponibilidad real de personal.

## SLI/SLO iniciales

| Journey          | SLI                         | SLO mensual                    | Alerta                     |
| ---------------- | --------------------------- | ------------------------------ | -------------------------- |
| Storefront       | requests válidas y latencia | 99,90 %                        | error budget/5xx           |
| Crear pedido     | éxito sin corrupción        | 99,95 %                        | impacto inmediato en venta |
| Total            | conciliación exacta         | 100 %                          | bloquear checkout/release  |
| Callback Redsys  | válido aplicado             | 99,9 % < 60 s                  | pendiente > 15 min         |
| Beply            | facturable procesado        | 99 % < 5 min                   | edad de cola/credencial    |
| Jobs críticos    | dentro de deadline          | 99,9 %; oldest < 15 min        | DLQ/backlog                |
| Catálogo API     | p95 server-side             | < 300 ms                       | plan/caché/índice          |
| Mutación crítica | p95 sin proveedor           | < 500 ms                       | DB/lock/side effect        |
| CWV              | p75                         | LCP 2,5 s; INP 200 ms; CLS 0,1 | regresión por release      |
| Pedidos/pagos    | RPO / RTO                   | 15 min / 2 h                   | ejercicio de restore       |

## Runbooks obligatorios

Pago ambiguo, sobreventa, Beply caído, carrier caído, worker/Redis, base de datos, despliegue, DNS/TLS, fuga de secreto y brecha. Cada runbook incluye detección, contención, owner, evidencia, reconciliación, comunicación, recuperación y postmortem.
