export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function batchPayload(texts: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(texts.map((text, i) => [String(i), text])))
}

/**
 * Fixed system prompt for page batches. Everything that varies (target language, page title)
 * goes into the user message, so the provider's prefix cache is shared across languages, pages
 * and users.
 */
export const BATCH_SYSTEM_PROMPT = [
  'You are a professional web page translation engine. Translate every value of the JSON object in the user message into the target language named there.',
  'Rules:',
  '1. Reply with ONLY one JSON object that has exactly the same keys, each value being the translation of the matching input value. No markdown, no code fences, no explanations.',
  '2. Markers like <g0>…</g0> wrap formatted text such as links or bold text. Keep every marker, translate the text inside it, and move markers if natural word order requires it.',
  '3. Markers like <c1/> or <c1>…</c1> stand for code, images or line breaks. Copy them exactly, including their content.',
  '4. Every value must be a valid JSON string: escape double quotes inside it as \\" and never leave a value empty.',
  '5. Keep URLs, code identifiers, numbers, brand names and emoji unchanged. If a value is already in the target language, return it unchanged.',
  '6. Produce fluent, natural translations that match the tone of the page.',
].join('\n')

export function buildBatchMessages(texts: readonly string[], targetLanguage: string, context: string): ChatMessage[] {
  const head = `Target language: ${targetLanguage}` + (context ? `\nPage title: ${context.slice(0, 200)}` : '')
  return [
    { role: 'system', content: BATCH_SYSTEM_PROMPT },
    { role: 'user', content: `${head}\n\n${batchPayload(texts)}` },
  ]
}

export function textSystemPrompt(targetLanguage: string): string {
  return `You are a professional translator. Translate the user's text into ${targetLanguage}. Output only the translation, keep the original line breaks, and do not add notes.`
}

export function buildTextMessages(text: string, targetLanguage: string): ChatMessage[] {
  return [
    { role: 'system', content: textSystemPrompt(targetLanguage) },
    { role: 'user', content: text },
  ]
}
