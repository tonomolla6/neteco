/** Canonical CMS CTA check, moved unchanged from cmsDocumentSchema. */
export function cmsCtaHrefIsSafe(href: string) {
  let safe =
    Array.from(href).every(
      (character) => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127 && character !== '\\'
    ) && !/%(?:0[0-9a-f]|1[0-9a-f]|20|5c|7f)/i.test(href)
  try {
    const url = new URL(href, 'https://cms.neteco.invalid')
    safe &&= href.startsWith('/')
      ? !href.startsWith('//') && url.origin === 'https://cms.neteco.invalid'
      : href.startsWith('https://') && url.protocol === 'https:' && !url.username && !url.password
  } catch {
    safe = false
  }
  return safe
}
