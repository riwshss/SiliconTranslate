type KeyInfo = Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'code' | 'key'>

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/
const NAMED_CODES = new Set([
  'Space', 'Enter', 'Escape', 'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
  'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
])

/** Physical key name, layout/modifier independent (Alt+T on macOS yields key "†", code "KeyT"). */
function keyName(code: string): string | null {
  if (MODIFIER_CODES.test(code)) return null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  return NAMED_CODES.has(code) ? code : null
}

/** "Ctrl+Alt+T" style string, or null when only modifiers / unsupported keys are pressed. */
export function eventToShortcut(e: KeyInfo): string | null {
  const key = keyName(e.code)
  if (!key) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

/** A usable page shortcut needs Ctrl/Alt/Meta (or an F-key) so normal typing never triggers it. */
export function isValidShortcut(shortcut: unknown): shortcut is string {
  if (typeof shortcut !== 'string' || shortcut.length > 40) return false
  const parts = shortcut.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  if (!key || mods.some((m) => !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(m))) return false
  const hasStrongModifier = mods.some((m) => m !== 'Shift')
  return hasStrongModifier || /^F\d{1,2}$/.test(key)
}

export function matchesShortcut(e: KeyInfo, shortcut: string): boolean {
  return eventToShortcut(e) === shortcut
}
