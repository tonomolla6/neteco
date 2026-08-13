import postgres from 'postgres'
import { expect, test } from '../fixtures/playwright'

const connection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'

test('intercepts analytics requests across grant, rejection and withdrawal', async ({ page, request }) => {
  const productResponse = await request.get('/api/products?limit=1')
  const product = ((await productResponse.json()) as { items: Array<{ slug: string }> }).items[0]!
  const captured: Array<Record<string, unknown>> = []
  const responseStatuses: number[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/analytics/events') responseStatuses.push(response.status())
  })
  await page.route('**/api/analytics/events', async (route) => {
    captured.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.continue()
  })

  await page.goto('/')
  const consent = page.getByRole('dialog', { name: 'Tu privacidad, bajo tu control' })
  await consent.getByRole('button', { name: 'Rechazar opcionales' }).click()
  await page.goto('/catalogo')
  await expect(page.getByRole('heading', { name: 'Todo el catálogo' })).toBeVisible()
  expect(captured).toHaveLength(0)

  await page.getByRole('button', { name: 'Configurar cookies' }).click()
  await consent.getByRole('checkbox', { name: /Medición/ }).check()
  await consent.getByRole('button', { name: 'Guardar selección' }).click()
  const consentCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'neteco-consent-v1')
  expect(decodeURIComponent(consentCookie?.value ?? '')).toContain('"analytics":true')
  await page.goto(`/producto/${product.slug}`)
  await expect.poll(() => captured.length).toBeGreaterThanOrEqual(2)
  await expect.poll(() => responseStatuses.length).toBe(captured.length)
  expect(responseStatuses.every((status) => status === 202)).toBe(true)
  expect(captured.map((event) => event.name)).toEqual(expect.arrayContaining(['page_view', 'product_viewed']))
  for (const event of captured) {
    expect(event).toMatchObject({ taxonomyVersion: 'v1' })
    expect(JSON.stringify(event.properties)).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[XYZ]?\d{7,8}[A-Z]\b/i)
  }

  const countBeforeWithdrawal = captured.length
  await page.getByRole('button', { name: 'Configurar cookies' }).click()
  await consent.getByRole('checkbox', { name: /Medición/ }).uncheck()
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/analytics/session') && response.status() === 204),
    consent.getByRole('button', { name: 'Guardar selección' }).click()
  ])
  await expect
    .poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === 'neteco-analytics-id'))
    .toBe(false)
  await page.goto('/catalogo')
  await expect(page.getByRole('heading', { name: 'Todo el catálogo' })).toBeVisible()
  expect(captured).toHaveLength(countBeforeWithdrawal)
})

test('persists one replayed event and rejects PII or stale telemetry', async ({ page, deterministic }) => {
  const sql = postgres(connection, { max: 1 })
  const acceptedId = deterministic.uuid('analytics-dedup')
  const rejectedIds = ['email', 'phone', 'nif', 'stale'].map((label) => deterministic.uuid(`analytics-${label}`))
  try {
    await sql`DELETE FROM analytics_events WHERE event_id IN ${sql([acceptedId, ...rejectedIds])}`
    await page.goto('/')
    await page.getByRole('dialog').getByRole('button', { name: 'Aceptar todas' }).click()
    const result = await page.evaluate(
      async ({ acceptedId, rejectedIds }) => {
        const send = (eventId: string, query: string, occurredAt = '2026-08-13T12:00:00.000Z') =>
          fetch('/api/analytics/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              eventId,
              taxonomyVersion: 'v1',
              name: 'search_completed',
              occurredAt,
              properties: { query, resultCount: 0 }
            })
          }).then((response) => response.status)
        const first = await send(acceptedId, 'detergente')
        const replay = await send(acceptedId, 'detergente')
        const rejected = await Promise.all([
          send(rejectedIds[0]!, 'cliente@example.com'),
          send(rejectedIds[1]!, '600123456'),
          send(rejectedIds[2]!, '12345678Z'),
          send(rejectedIds[3]!, 'detergente', '2026-08-10T12:00:00.000Z')
        ])
        return { first, replay, rejected }
      },
      { acceptedId, rejectedIds }
    )
    expect(result).toEqual({ first: 202, replay: 202, rejected: [400, 400, 400, 400] })
    const [state] = await sql<{ accepted: number; rejected: number }[]>`
      SELECT count(*) FILTER (WHERE event_id = ${acceptedId})::int AS accepted,
             count(*) FILTER (WHERE event_id IN ${sql(rejectedIds)})::int AS rejected
      FROM analytics_events
    `
    expect(state).toEqual({ accepted: 1, rejected: 0 })
  } finally {
    await sql`DELETE FROM analytics_events WHERE event_id IN ${sql([acceptedId, ...rejectedIds])}`
    await sql.end({ timeout: 5 })
  }
})
