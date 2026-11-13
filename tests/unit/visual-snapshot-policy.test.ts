import { expect, it } from 'vitest'
import visual from '../../playwright.visual.config'
import states from '../../playwright.ui-state-harness.config'

it('requires an explicitly reviewed baseline in every visual entry point', () => {
  expect(visual.updateSnapshots).toBe('none')
  expect(states.updateSnapshots).toBe('none')
  expect(visual.expect?.toHaveScreenshot?.maxDiffPixelRatio).toBe(0.002)
  expect(states.workers).toBe(1)
})
