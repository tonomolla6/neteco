import { expect, it } from 'vitest'
import { createUiStateHarness, selectUiStateCase } from '../fixtures/ui-state-harness'

it('selects the actual customer route/component, not the first administrative fixture', () => {
  expect(selectUiStateCase('customer-orders', 'empty')).toMatchObject({
    component: 'CustomerOrdersPage',
    path: '/cuenta/pedidos',
    state: 'empty'
  })
  expect(() => selectUiStateCase('unknown', 'empty')).toThrow()
  expect(() => selectUiStateCase('admin-orders', 'invented')).toThrow()
})
it('routes dense and empty reads to independent deterministic real DTO shapes', async () => {
  const dense = createUiStateHarness('admin-orders', 'dense'),
    repeated = createUiStateHarness('admin-orders', 'dense')
  const first = (await dense.request('/api/admin/orders')) as { items: unknown[] }
  expect(first.items).toHaveLength(25)
  expect(await repeated.request('/api/admin/orders')).toEqual(first)
  first.items.length = 0
  expect(((await dense.request('/api/admin/orders')) as { items: unknown[] }).items).toHaveLength(25)
  expect(await createUiStateHarness('customer-orders', 'empty').request('/api/orders')).toEqual({ orders: [] })
})
it('actually holds loading until explicitly released, without timers or hidden requests', async () => {
  const loading = createUiStateHarness('customer-orders', 'loading')
  let completed = false
  const request = loading.request('/api/orders').then(() => {
    completed = true
  })
  await Promise.resolve()
  expect(completed).toBe(false)
  loading.settle()
  await request
  expect(completed).toBe(true)
})
it('produces an explicit error rather than a successful empty list', async () => {
  await expect(createUiStateHarness('admin-orders', 'error').request('/api/admin/orders')).rejects.toMatchObject({
    statusCode: 503
  })
  await expect(
    createUiStateHarness('customer-orders', 'permission-denied').request('/api/orders')
  ).rejects.toMatchObject({ statusCode: 403 })
})
it('forbids wrong-resource reads, writes and requests after disposal', async () => {
  const harness = createUiStateHarness('customer-orders', 'dense')
  await expect(harness.request('/api/admin/orders')).rejects.toThrow()
  await expect(harness.request('/api/orders', { method: 'POST' })).rejects.toThrow()
  harness.dispose()
  await expect(harness.request('/api/orders')).rejects.toThrow()
})
