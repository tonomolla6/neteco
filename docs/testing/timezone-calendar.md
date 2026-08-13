# Gate de timezone, DST y calendario

TST-033 usa instantes UTC para persistencia y `Europe/Madrid` como calendario comercial explícito. No depende del timezone del host.

- `server/utils/madrid-calendar.ts` convierte fecha/hora local y suma días conservando la hora de pared a través de ambos cambios DST.
- La ETA aplica cutoff local y combina, sin duplicados, festivos nacionales, locales y del carrier configurados como `YYYY-MM-DD`. Fines de semana y festivos no consumen días laborables.
- Las pruebas cubren medianoche local, salto de primavera, hora repetida de otoño, cutoff antes/en el límite, festivos y ETA.
- Feature flags caducan en el instante exacto incluso dentro de la hora repetida.
- El CMS recibe fecha/hora local con `Europe/Madrid` visible, convierte en servidor y resuelve explícitamente la hora repetida. La publicación congela la versión al programar. Un worker con advisory lock publica/despublica exactamente una vez en los instantes persistidos; replay no repite la acción.
- Beply recibe `fecha` y `hora` fiscales calculadas en Madrid, incluidos medianoche y ambos cambios DST.

`npm run content:publish` procesa el lote vencido. El scheduler gestionado debe invocarlo al menos cada minuto con `APP_ENV` y `DATABASE_URL`; el lock transaccional permite ejecuciones solapadas sin duplicados. `npm run alerts:check` emite `content_publication_missed` y sale con error cuando una fecha sigue pendiente cinco minutos después. La evidencia automatizada reside en `tests/unit/madrid-calendar.test.ts`, `tests/unit/shipping.test.ts`, `tests/unit/beply.test.ts`, `tests/unit/feature-flags.test.ts`, `tests/integration/calendar-boundaries.test.ts` y `tests/integration/pricing-schedules.test.ts`.
