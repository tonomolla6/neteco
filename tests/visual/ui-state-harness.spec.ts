import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium, expect, test as base } from '@playwright/test'
import { connectRemoteTestBrowser } from '../../scripts/lib/remote-test-browser'
import { UI_STATES, UI_STATE_SURFACES, UI_STATE_WIDTHS, selectUiStateCase } from '../fixtures/ui-state-harness'

const test = base.extend({
  browser: [
    async ({ browserName }, use) => {
      if (browserName !== 'chromium') throw Error('Only the authorized remote Chromium is supported')
      const browser = await connectRemoteTestBrowser(chromium)
      try {
        await use(browser)
      } finally {
        await browser.close()
      }
    },
    { scope: 'worker' }
  ]
})

for (const surface of UI_STATE_SURFACES)
  for (const state of UI_STATES)
    for (const width of UI_STATE_WIDTHS) {
      const selected = selectUiStateCase(surface, state)
      test(`${selected.id} at ${width}px compares a manually reviewed component baseline`, async ({
        page
      }, testInfo) => {
        if (testInfo.config.updateSnapshots !== 'none')
          throw Error('Automatic baseline creation/approval is prohibited')
        const directory = resolve('test-results/ui013-components')
        const html = await readFile(resolve(directory, selected.id + '.html'), 'utf8')
        const metadata = JSON.parse(await readFile(resolve(directory, selected.id + '.json'), 'utf8')) as Record<
          string,
          unknown
        >
        expect(metadata.id).toBe(selected.id)
        expect(metadata.component).toBe(selected.component)
        expect(metadata.kind).toBe('static_real_component_mount')
        expect(metadata.htmlHash).toBe(createHash('sha256').update(html).digest('hex'))
        expect(metadata.cssHash).toMatch(/^[0-9a-f]{64}$/)
        await page.setViewportSize({ width, height: 1000 })
        await page.route('**/*', (route) => route.abort('blockedbyclient'))
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
        await page.setContent(html, { waitUntil: 'domcontentloaded' })
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        await expect(page.locator('body')).not.toBeEmpty()
        await expect(page).toHaveScreenshot(`${selected.id}-${width}.png`, {
          fullPage: true,
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.002
        })
      })
    }
