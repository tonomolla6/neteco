import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

/** Keyboard and background management for dialogs teleported to document.body. */
export function useDialogFocus(dialog: Ref<HTMLElement | null>, open: Ref<boolean>) {
  let release = () => {}
  let generation = 0
  watch(
    [open, dialog],
    async ([active, element]) => {
      const current = ++generation
      release()
      release = () => {}
      if (!active || !element || typeof document === 'undefined') return
      await nextTick()
      if (current !== generation || !open.value || dialog.value !== element) return
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const overflow = document.body.style.overflow
      const background = new Map<HTMLElement, string | null>()
      for (const child of document.body.children) {
        if (!(child instanceof HTMLElement) || child.contains(element)) continue
        background.set(child, child.getAttribute('inert'))
        child.setAttribute('inert', '')
      }
      document.body.style.overflow = 'hidden'
      const controls = () =>
        Array.from(
          element.querySelectorAll<HTMLElement>(
            'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]'
          )
        ).filter((control) => {
          const style = getComputedStyle(control)
          return (
            control.tabIndex >= 0 &&
            !control.matches(':disabled, [aria-disabled="true"]') &&
            !control.closest('[hidden], [inert], [aria-hidden="true"]') &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          )
        })
      const focusFirst = () => (controls()[0] ?? element).focus()
      const focusInside = (event: FocusEvent) => {
        if (event.target instanceof Node && !element.contains(event.target)) focusFirst()
      }
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          open.value = false
        } else if (event.key === 'Tab') {
          const items = controls()
          const first = items[0],
            last = items.at(-1)
          if (!first || !last) {
            event.preventDefault()
            element.focus()
          } else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
      }
      element.addEventListener('keydown', keydown)
      document.addEventListener('focusin', focusInside)
      release = () => {
        element.removeEventListener('keydown', keydown)
        document.removeEventListener('focusin', focusInside)
        for (const [child, previous] of background) {
          if (previous === null) child.removeAttribute('inert')
          else child.setAttribute('inert', previous)
        }
        document.body.style.overflow = overflow
        if (opener?.isConnected) opener.focus()
      }
      focusFirst()
    },
    { flush: 'post' }
  )
  onBeforeUnmount(() => {
    generation++
    release()
  })
}
