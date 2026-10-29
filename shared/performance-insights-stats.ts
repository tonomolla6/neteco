export interface ArmCounts {
  visitors: number
  conversions: number
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2))
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
  const erf = 1 - poly * Math.exp(-((x / Math.SQRT2) ** 2))
  return 0.5 * (1 + sign * erf)
}

function validArm(arm: ArmCounts): boolean {
  return (
    Number.isSafeInteger(arm.visitors) &&
    Number.isSafeInteger(arm.conversions) &&
    arm.visitors >= 0 &&
    arm.conversions >= 0 &&
    arm.conversions <= arm.visitors
  )
}

/** Two-sided pooled two-proportion z-test. Degenerate inputs yield p=1 (never "significant"). */
export function twoProportionTest(control: ArmCounts, treatment: ArmCounts): { z: number; pValue: number } {
  if (!validArm(control) || !validArm(treatment)) throw new Error('invalid_arm_counts')
  if (control.visitors === 0 || treatment.visitors === 0) return { z: 0, pValue: 1 }
  const pooled = (control.conversions + treatment.conversions) / (control.visitors + treatment.visitors)
  const variance = pooled * (1 - pooled) * (1 / control.visitors + 1 / treatment.visitors)
  if (variance <= 0) return { z: 0, pValue: 1 }
  const z = (treatment.conversions / treatment.visitors - control.conversions / control.visitors) / Math.sqrt(variance)
  if (z === 0) return { z: 0, pValue: 1 }
  return { z, pValue: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) }
}

/** FNV-1a 32-bit with a final avalanche; deterministic and dependency-free. */
function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Sticky 50/50 assignment, decorrelated across experiments. */
export function assignExperimentArm(visitorKey: string, experimentKey: string): 'control' | 'treatment' {
  if (!visitorKey || !experimentKey) throw new Error('invalid_assignment_input')
  return hash32(`${experimentKey}\u0000${visitorKey}`) % 2 === 0 ? 'control' : 'treatment'
}
