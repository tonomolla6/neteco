import type { Browser } from '@playwright/test'
import { expect, it, vi } from 'vitest'
import { runCompiledBrowserProof } from '../support/compiled-browser-proof'

it('keeps an explicit HTTP-only contract separate from browser evidence', async () => {
  const connect = vi.fn(),
    proof = vi.fn()
  expect(await runCompiledBrowserProof(proof, { required: false, connect })).toEqual({ browserExecuted: false })
  expect(connect).not.toHaveBeenCalled()
  expect(proof).not.toHaveBeenCalled()
})

it('awaits the real required proof before closing only its connection', async () => {
  const events: string[] = []
  const browser = {
    close: vi.fn(async () => {
      events.push('close')
    })
  } as unknown as Browser
  const connect = vi.fn(async () => {
    events.push('connect')
    return browser
  })
  expect(
    await runCompiledBrowserProof(
      async (value) => {
        expect(value).toBe(browser)
        events.push('proof')
      },
      { required: true, connect }
    )
  ).toEqual({ browserExecuted: true })
  expect(events).toEqual(['connect', 'proof', 'close'])
  expect(connect).toHaveBeenCalledTimes(1)
})

it('fails the required gate on unavailable browser without running a proof or a fallback', async () => {
  const unavailable = new Error('private_browser_unavailable')
  const connect = vi.fn(async () => {
      throw unavailable
    }),
    proof = vi.fn()
  await expect(runCompiledBrowserProof(proof, { required: true, connect })).rejects.toBe(unavailable)
  expect(connect).toHaveBeenCalledTimes(1)
  expect(proof).not.toHaveBeenCalled()
})

it('retains a failed proof and closes its browser connection', async () => {
  const failed = new Error('actual_ui_contract_failed')
  const browser = { close: vi.fn(async () => {}) } as unknown as Browser
  await expect(
    runCompiledBrowserProof(
      async () => {
        throw failed
      },
      {
        required: true,
        connect: async () => browser
      }
    )
  ).rejects.toBe(failed)
  expect(browser.close).toHaveBeenCalledTimes(1)
})
