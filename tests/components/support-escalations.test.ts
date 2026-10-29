import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminSupportPanel from '../../app/components/AdminSupportPanel.vue'
import AdminSupportEscalationsPanel from '../../app/components/AdminSupportEscalationsPanel.vue'
import { ACTOR, REF, adminContext } from './support-operations-fixture'
import { supportEscalationIntentHash } from '../../shared/support-escalations'
import '#app/nuxt-vitest-app-entry'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => request)
mockNuxtImport('useRequestFetch', () => () => request)
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
afterEach(() => {
  wrapper?.unmount()
  request.mockReset()
})
describe('SUP-006 real existing support panel integration', () => {
  it('offers explicit internal escalation without sending a customer reply or creating any command on mount', async () => {
    request.mockResolvedValue({ source: 'cloudflare', items: [], page: 1, perPage: 25, total: 0 })
    wrapper = await mountSuspended(AdminSupportPanel, {
      props: {
        snapshot: adminContext(),
        publicRef: REF,
        operatorId: ACTOR,
        runtime: 'cloudflare',
        authorize: () => true,
        reload: async () => adminContext()
      }
    })
    await flushPromises()
    expect(wrapper.find('[aria-label="Escalado interno de incidencias"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Sin cambios en cobros, existencias ni mensajes al cliente')
    expect(
      request.mock.calls.filter(([, options]) => options?.method === 'POST' || options?.method === 'PUT')
    ).toHaveLength(0)
  })
})

const BOOK = 'a2525221-4b97-4aad-b610-56a057cf2fa7',
  NOW = '2026-10-09T12:00:00Z'
function snapshot() {
  return {
    source: 'cloudflare',
    publicRef: REF,
    ticketVersion: 1,
    escalation: null,
    history: [],
    page: 1,
    perPage: 25,
    total: 0,
    staff: [{ id: ACTOR, label: 'Operador sintético' }],
    runbooks: [
      {
        source: 'cloudflare',
        id: BOOK,
        version: 2,
        queue: 'payment',
        state: 'approved',
        title: 'Revisión de pago',
        body: 'Consultar evidencia interna sin ejecutar un cobro.',
        operationalReference: 'explicit-synthetic-review',
        reviewedAt: NOW,
        expiresAt: '2027-10-09T12:00:00Z',
        updatedAt: NOW
      }
    ]
  }
}
async function panel() {
  wrapper = await mountSuspended(AdminSupportEscalationsPanel, {
    props: { publicRef: REF, scopeKey: ACTOR + ':' + REF, enabled: true, pending: false }
  })
  return wrapper
}
async function click(text: string) {
  const button = wrapper!.findAll('button').find((value) => value.text() === text)
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}
async function prepareEscalation() {
  await click('Consultar escalado del ticket')
  const field = (label: string, selector: string) =>
    wrapper!
      .findAll('label')
      .find((value) => value.text().startsWith(label))!
      .get(selector)
  await field('Responsable elegible', 'select').setValue(ACTOR)
  await field('Runbook interno aprobado', 'select').setValue(BOOK)
  await field('Siguiente acción', 'textarea').setValue('Comprobar el recibo con el responsable asignado')
  await field('Fecha de siguiente acción UTC', 'input').setValue('2026-10-10T12:00:00Z')
  await field('Motivo documentado', 'textarea').setValue('Motivo interno sintético sin datos del cliente')
  await wrapper!
    .findAll('form')
    .find((value) => value.text().includes('Motivo documentado'))!
    .trigger('submit')
  await vi.waitFor(() => expect(wrapper!.text()).toContain('Confirmar operación interna'))
}
describe('SUP-006 explicit review and private command recovery', () => {
  it.each(['version_conflict', 'ticket_version_conflict'])(
    'releases only a direct proven %s rejection and allows explicit fresh reading',
    async (code) => {
      let rejected = false
      request.mockImplementation(async (_path: string, options: { method?: string }) => {
        if (options.method === 'POST') {
          rejected = true
          throw { statusCode: 409, data: { error: { code } } }
        }
        return { ...snapshot(), ticketVersion: rejected ? 2 : 1 }
      })
      await panel()
      await prepareEscalation()
      await click('Confirmar operación interna')
      expect(wrapper!.text()).not.toContain('Resultado incierto')
      expect(wrapper!.text()).not.toContain('Comprobar operación interna')
      expect(wrapper!.emitted('pending')?.at(-1)).toEqual([false])
      expect(request).toHaveBeenCalledTimes(2)
      await click('Consultar escalado del ticket')
      expect(wrapper!.text()).toContain('versión del ticket 2')
      expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    }
  )
  it('does no implicit reads or writes and loads only the explicit authorized ticket', async () => {
    request.mockResolvedValue(snapshot())
    await panel()
    expect(request).not.toHaveBeenCalled()
    await click('Consultar escalado del ticket')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![0]).toBe('/api/admin/support/' + REF + '/escalation')
    expect(wrapper!.text()).toContain('Sin escalado registrado.')
  })
  it('freezes one POST and recovers through exact receipt plus fresh state, never reposting', async () => {
    let body: Record<string, unknown> | null = null,
      key = '',
      reads = 0
    request.mockImplementation(
      async (
        path: string,
        options: { method?: string; body?: Record<string, unknown>; headers?: Record<string, string> }
      ) => {
        if (options.method === 'POST') {
          body = options.body!
          key = options.headers!['Idempotency-Key']!
          throw { statusCode: 503 }
        }
        if (path.includes('/commands/'))
          return {
            source: 'cloudflare',
            outcome: 'applied',
            receipt: {
              source: 'cloudflare',
              commandId: key,
              targetId: REF,
              action: 'handoff',
              expectedVersion: 0,
              version: 1,
              payloadHash: await supportEscalationIntentHash(REF, body),
              recordedAt: NOW,
              inventoryEffect: 'none',
              economicEffect: 'none',
              communicationEffect: 'none'
            }
          }
        reads++
        return reads === 1
          ? snapshot()
          : {
              ...snapshot(),
              total: 1,
              escalation: {
                ...body,
                publicRef: REF,
                version: 1,
                ticketVersion: 1,
                state: 'open',
                resolution: null,
                createdAt: NOW,
                updatedAt: NOW,
                action: undefined,
                expectedVersion: undefined,
                expectedTicketVersion: undefined,
                reason: undefined
              }
            }
      }
    )
    await panel()
    await prepareEscalation()
    await click('Confirmar operación interna')
    expect(wrapper!.text()).toContain('Resultado incierto')
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    // A fresh DTO is strict: remove command-only fields rather than making them optional.
    const previous = request.getMockImplementation()!
    request.mockImplementation(async (...args: unknown[]) => {
      const result = await previous(...args)
      if (result?.escalation)
        for (const field of ['action', 'expectedVersion', 'expectedTicketVersion', 'reason'])
          Reflect.deleteProperty(result.escalation, field)
      return result
    })
    await click('Comprobar operación interna')
    expect(wrapper!.text()).toContain('Operación interna confirmada con recibo y lectura actual.')
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(
      request.mock.calls.find(([path]) => path.includes('/commands/'))![1].headers['X-Neteco-Command-Payload-Hash']
    ).toBe(await supportEscalationIntentHash(REF, body))
    expect(reads).toBe(2)
  })
  it('keeps unknown sticky with no automatic resubmission or false absence', async () => {
    request.mockImplementation(async (path: string, options: { method?: string }) =>
      options.method === 'POST'
        ? Promise.reject({ statusCode: 503 })
        : path.includes('/commands/')
          ? { source: 'cloudflare', outcome: 'unknown', receipt: null }
          : snapshot()
    )
    await panel()
    await prepareEscalation()
    await click('Confirmar operación interna')
    await click('Comprobar operación interna')
    expect(wrapper!.text()).toContain('No hay recibo confirmado')
    expect(wrapper!.text()).not.toContain('Confirmar operación interna')
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  })
  it('purges private draft and intent on authority loss, including unchanged actor identity', async () => {
    request.mockResolvedValue(snapshot())
    await panel()
    await prepareEscalation()
    await wrapper!.setProps({ enabled: false })
    await flushPromises()
    expect(wrapper!.text()).not.toContain('Motivo interno sintético')
    expect(wrapper!.find('section').exists()).toBe(false)
    expect(wrapper!.emitted('pending')?.at(-1)).toEqual([false])
    await wrapper!.setProps({ enabled: true })
    await flushPromises()
    expect(wrapper!.text()).not.toContain('Confirmar operación interna')
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })
  it('purges on confirmed server revocation and never calls GET after a rejected POST', async () => {
    request.mockImplementation(async (_path: string, options: { method?: string }) =>
      options.method === 'POST' ? Promise.reject({ statusCode: 403 }) : snapshot()
    )
    await panel()
    await prepareEscalation()
    await click('Confirmar operación interna')
    expect(wrapper!.text()).toContain('Autorización revocada')
    expect(wrapper!.text()).not.toContain('Motivo interno sintético')
    expect(wrapper!.text()).not.toContain('Comprobar operación interna')
    expect(request).toHaveBeenCalledTimes(2)
  })
})
