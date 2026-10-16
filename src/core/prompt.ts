export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export function batchPayload(texts: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(texts.map((text, i) => [String(i), text])))
}

export function batchSystemPrompt(targetLanguage: string, context: string): string {
  return [
    `You are a professional web page translation engine. Translate every value of the JSON object sent by the user into ${targetLanguage}.`,
    'Rules:',
    '1. Reply with ONLY one JSON object that has exactly the same keys, each value being the translation of the matching input value. No markdown, no code fences, no explanations.',
    '2. Markers like <g0>…</g0> wrap formatted text such as links or bold text. Keep every marker, translate the text inside it, and move markers if natural word order requires it.',
    '3. Markers like <c1/> or <c1>…</c1> stand for code, images or line breaks. Copy them exactly, including their content.',
    '4. Every value must be a valid JSON string: escape double quotes inside it as \\" and never leave a value empty.',
    `5. Keep URLs, code identifiers, numbers, brand names and emoji unchanged. If a value is already in ${targetLanguage}, return it unchanged.`,
    '6. Produce fluent, natural translations that match the tone of the page.',
    context ? `The page title is: ${context.slice(0, 200)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildBatchMessages(texts: readonly string[], targetLanguage: string, context: string): ChatMessage[] {
  return [
    { role: 'system', content: batchSystemPrompt(targetLanguage, context) },
    { role: 'user', content: batchPayload(texts) },
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
