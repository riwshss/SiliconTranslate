export interface Segmented {
  setValue(value: string): void
  /** Re-measures the thumb after the button labels changed (interface language switch). */
  repaint(): void
}

/** Wires a `.seg` radiogroup: sliding thumb, aria-checked, keyboard arrows. */
export function segmented(root: HTMLElement, onChange: (value: string) => void): Segmented {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[data-value]')]
  const thumb = document.createElement('span')
  thumb.className = 'thumb'
  root.prepend(thumb)
  let current = ''

  const paint = () => {
    const active = buttons.find((b) => b.dataset.value === current)
    buttons.forEach((b) => {
      b.setAttribute('aria-checked', String(b === active))
      b.tabIndex = b === active ? 0 : -1
    })
    thumb.hidden = !active
    if (!active) return
    thumb.style.width = `${active.offsetWidth}px`
    thumb.style.transform = `translateX(${active.offsetLeft}px)`
  }

  const select = (value: string) => {
    if (value === current) return
    current = value
    paint()
    onChange(value)
  }

  buttons.forEach((button, i) => {
    button.addEventListener('click', () => select(button.dataset.value ?? ''))
    button.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
      if (!step) return
      const next = buttons[(i + step + buttons.length) % buttons.length]
      next.focus()
      select(next.dataset.value ?? '')
    })
  })

  return {
    setValue(value: string) {
      // First paint without animation so the thumb doesn't slide in from the left.
      const isFirst = current === '' && !thumb.style.width
      if (isFirst) root.classList.add('no-anim')
      current = value
      requestAnimationFrame(() => {
        paint()
        if (isFirst) requestAnimationFrame(() => root.classList.remove('no-anim'))
      })
    },
    repaint() {
      root.classList.add('no-anim')
      requestAnimationFrame(() => {
        paint()
        requestAnimationFrame(() => root.classList.remove('no-anim'))
      })
    },
  }
}
