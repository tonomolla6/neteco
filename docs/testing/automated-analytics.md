# Gate automatizado de analítica

TST-032 combina contrato unitario, navegador real y transacciones reales para evitar que una respuesta HTTP aceptada se confunda con evidencia de persistencia.

- `tests/unit/analytics.test.ts` recorre los ocho eventos cliente `v1`, sus campos estrictos, límites, codificaciones de consentimiento y detección de email, teléfono y NIF.
- `tests/e2e/analytics.spec.ts` intercepta las peticiones reales de la UI. Exige cero eventos antes del consentimiento y después de rechazar o retirar, eventos `202` tras aceptar y eliminación del identificador anónimo al retirar.
- El E2E reenvía un mismo `eventId` y comprueba en PostgreSQL una sola fila. Email, teléfono, NIF y timestamps fuera de ventana reciben `400` y no se persisten.
- `tests/integration/commerce-transactions.test.ts` comprueba que captura y replay producen un solo `order_confirmed`, y que ejecutar dos veces el worker produce un solo `refund_confirmed`.
- Compra y reembolso nacen exclusivamente del estado comercial del servidor. Sus registros se validan como `source=server`, con clave de deduplicación estable y propiedades sin PII.

El gate dedicado se ejecuta con `npm run test:analytics`; la suite también forma parte del recorrido E2E Chromium obligatorio de CI y conserva JUnit, trazas, capturas y vídeo cuando falla.
