import postgres from 'postgres'
import { expect, test } from '../fixtures/playwright'

const connection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'

test('blocks optional analytics until explicit consent and makes rejection equally available', async ({
  page,
  deterministic
}) => {
  await page.goto('/')
  const dialog = page.getByRole('dialog', { name: 'Tu privacidad, bajo tu control' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Rechazar opcionales' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Aceptar todas' })).toBeVisible()

  const denied = await page.evaluate(
    async ({ eventId, occurredAt }) => {
      const response = await fetch('/api/analytics/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId,
          taxonomyVersion: 'v1',
          name: 'page_view',
          occurredAt,
          properties: { path: '/' }
        })
      })
      return response.status
    },
    { eventId: deterministic.uuid('denied-event'), occurredAt: deterministic.date().toISOString() }
  )
  expect(denied).toBe(403)

  await dialog.getByRole('button', { name: 'Rechazar opcionales' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Configurar cookies' }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: /Medición/ })).not.toBeChecked()
})

test('accepts and deduplicates a consented first-party event without PII', async ({ page, deterministic }) => {
  const eventId = deterministic.uuid('accepted-event')
  const occurredAt = deterministic.date().toISOString()
  const sql = postgres(connection, { max: 1 })
  try {
    await sql`DELETE FROM analytics_events WHERE event_id = ${eventId}`
    await page.goto('/')
    await page.getByRole('dialog').getByRole('button', { name: 'Aceptar todas' }).click()
    const statuses = await page.evaluate(
      async ({ eventId, occurredAt }) => {
        const body = JSON.stringify({
          eventId,
          taxonomyVersion: 'v1',
          name: 'page_view',
          occurredAt,
          properties: { path: '/catalogo' }
        })
        const first = await fetch('/api/analytics/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body
        })
        const replay = await fetch('/api/analytics/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body
        })
        return [first.status, replay.status]
      },
      { eventId, occurredAt }
    )
    expect(statuses).toEqual([202, 202])
    await expect
      .poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === 'neteco-analytics-id'))
      .toBe(true)
    const analyticsCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'neteco-analytics-id')
    expect(analyticsCookie).toMatchObject({ httpOnly: true, secure: false, sameSite: 'Lax', path: '/' })
    expect(analyticsCookie!.expires).toBeGreaterThan(Date.now() / 1000)
  } finally {
    await sql`DELETE FROM analytics_events WHERE event_id = ${eventId}`
    await sql.end({ timeout: 5 })
  }
})
