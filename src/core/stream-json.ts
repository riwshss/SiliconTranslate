/**
 * Incremental parser for a flat JSON object of string → string, e.g. {"0":"…","1":"…"},
 * fed with arbitrary chunks of a streamed LLM reply. Each completed key/value pair is
 * emitted as soon as its end is certain, so translations render progressively.
 *
 * Small models bend the format, so it also tolerates: leading prose, ```json fences and a
 * <think>…</think> block; raw newlines and unescaped `"` inside values; unquoted numeric keys
 * ({0:"…"}); a bare array (["…","…"], keyed by position); and a reply cut off right after the
 * last value (flushed by `end()`).
 */
export interface ObjectStreamParser {
  push(chunk: string): Array<[string, string]>
  /** Call once the stream is over: emits a final value that was still waiting for its delimiter. */
  end(): Array<[string, string]>
}

/** Need more input before the next decision can be made. */
const WAIT = -1
const UNQUOTED_KEY = /^(\d+)\s*:/
const PARTIAL_UNQUOTED_KEY = /^\d+\s*$/

export function createObjectStreamParser(): ObjectStreamParser {
  let buffer = ''
  let pos = 0
  let mode: 'seek' | 'object' | 'array' = 'seek'
  let pendingKey: string | null = null
  let arrayIndex = 0

  const isValuePosition = () => mode === 'array' || pendingKey !== null

  function seek(): boolean {
    const think = buffer.indexOf('<think>', pos)
    const open = buffer.slice(pos).search(/[{[]/)
    if (think >= 0 && (open < 0 || think < pos + open)) {
      const close = buffer.indexOf('</think>', think)
      if (close < 0) return false
      pos = close + '</think>'.length
      return seek()
    }
    if (open < 0) {
      // Keep a possible partial "<think" around; everything else can be skipped.
      pos = Math.max(pos, buffer.length - '<think>'.length)
      return false
    }
    pos += open
    mode = buffer[pos] === '[' ? 'array' : 'object'
    pos++
    return true
  }

  function emit(out: Array<[string, string]>, value: string): void {
    if (mode === 'array') out.push([String(arrayIndex++), value])
    else if (pendingKey !== null) out.push([pendingKey, value])
    pendingKey = null
  }

  return {
    push(chunk) {
      buffer += chunk
      const out: Array<[string, string]> = []
      if (mode === 'seek' && !seek()) return out
      while (pos < buffer.length) {
        const ch = buffer[pos]
        if (ch === '"') {
          const end = isValuePosition() ? findValueEnd(buffer, pos) : findStringEnd(buffer, pos)
          if (end === WAIT) break
          if (isValuePosition()) {
            emit(out, decodeLoose(buffer.slice(pos + 1, end)))
            pos = end + 1
            continue
          }
          // Key position: a string is a key only if a ':' follows.
          const next = skipSpaces(buffer, end + 1)
          if (next >= buffer.length) break
          if (buffer[next] === ':') {
            pendingKey = decodeLoose(buffer.slice(pos + 1, end))
            pos = next + 1
          } else {
            pos = end + 1
          }
          continue
        }
        if (mode === 'object' && pendingKey === null && /\d/.test(ch)) {
          const rest = buffer.slice(pos, pos + 24)
          const match = UNQUOTED_KEY.exec(rest)
          if (match) {
            pendingKey = match[1]
            pos += match[0].length
            continue
          }
          if (PARTIAL_UNQUOTED_KEY.test(rest)) break
        }
        // A number, object, true/false/null as value: not a translation, drop the key.
        if (pendingKey !== null && !/\s/.test(ch)) pendingKey = null
        pos++
      }
      return out
    },

    end() {
      const out: Array<[string, string]> = []
      if (mode === 'seek' || !isValuePosition() || buffer[pos] !== '"') return out
      const close = lastQuote(buffer, pos)
      if (close > pos) emit(out, decodeLoose(buffer.slice(pos + 1, close)))
      pos = buffer.length
      return out
    },
  }
}

/** First unescaped quote after `start` (a key), or WAIT. */
function findStringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i
  }
  return WAIT
}

/**
 * End of a value string. A quote only closes the value when it is followed by `}` / `]`, or by
 * `,` and then the start of the next entry; any other quote is an unescaped quote in the text.
 */
function findValueEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] !== '"') continue
    const next = skipSpaces(text, i + 1)
    if (next >= text.length) return WAIT
    const c = text[next]
    if (c === '}' || c === ']') return i
    if (c !== ',') continue
    const after = skipSpaces(text, next + 1)
    if (after >= text.length) return WAIT
    if (/["}\]\d]/.test(text[after])) return i
  }
  return WAIT
}

function lastQuote(text: string, after: number): number {
  for (let i = text.length - 1; i > after; i--) {
    if (text[i] === '"' && text[i - 1] !== '\\') return i
  }
  return -1
}

function skipSpaces(text: string, start: number): number {
  let i = start
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** Decodes the inside of a JSON string, escaping stray quotes and control characters first. */
function decodeLoose(inner: string): string {
  let fixed = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '\\' && i + 1 < inner.length) {
      fixed += c + inner[++i]
    } else if (c === '"') {
      fixed += '\\"'
    } else if (c === '\\') {
      fixed += '\\\\'
    } else if (c < ' ') {
      fixed += c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '' : ' '
    } else {
      fixed += c
    }
  }
  try {
    return JSON.parse(`"${fixed}"`) as string
  } catch {
    return inner
  }
}
