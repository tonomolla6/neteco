import { expect, test } from '@playwright/test'

test('blocks optional analytics until explicit consent and makes rejection equally available', async ({ page }) => {
  await page.goto('/')
  const dialog = page.getByRole('dialog', { name: 'Tu privacidad, bajo tu control' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Rechazar opcionales' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Aceptar todas' })).toBeVisible()

  const denied = await page.evaluate(async () => {
    const response = await fetch('/api/analytics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId: crypto.randomUUID(),
        taxonomyVersion: 'v1',
        name: 'page_view',
        occurredAt: new Date().toISOString(),
        properties: { path: '/' }
      })
    })
    return response.status
  })
  expect(denied).toBe(403)

  await dialog.getByRole('button', { name: 'Rechazar opcionales' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'Configurar cookies' }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: /Medición/ })).not.toBeChecked()
})

test('accepts and deduplicates a consented first-party event without PII', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('dialog').getByRole('button', { name: 'Aceptar todas' }).click()
  const statuses = await page.evaluate(async () => {
    const body = JSON.stringify({
      eventId: crypto.randomUUID(),
      taxonomyVersion: 'v1',
      name: 'page_view',
      occurredAt: new Date().toISOString(),
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
  })
  expect(statuses).toEqual([202, 202])
  await expect
    .poll(async () => (await page.context().cookies()).some((cookie) => cookie.name === 'neteco-analytics-id'))
    .toBe(true)
})
