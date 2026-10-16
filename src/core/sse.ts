/**
 * Minimal Server-Sent-Events line parser for OpenAI-compatible streams.
 * Feeds every `data:` payload to `onData`; chunks may split lines anywhere.
 */
export function createSseParser(onData: (data: string) => void) {
  let buffer = ''

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data) onData(data)
  }

  return {
    push(chunk: string): void {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      lines.forEach(handleLine)
    },
    end(): void {
      if (buffer) handleLine(buffer)
      buffer = ''
    },
  }
}
