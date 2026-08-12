import { expect, test } from '@playwright/test'

test('publishes a live health check with security headers', async ({ request }) => {
  const response = await request.get('/api/health/live')
  expect(response.ok()).toBe(true)
  expect(await response.json()).toEqual({ status: 'ok', service: 'neteco' })
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['x-correlation-id']).toBeTruthy()
})
