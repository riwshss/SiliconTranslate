import type { Language } from '../shared/languages'

/**
 * Bumped whenever the prompts below change in a way that changes translations. It is part of
 * every cache key (backend and extension), so translations made under an older prompt are not
 * served again.
 */
export const PROMPT_VERSION = 2

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

/**
 * Regional usage for targets where a plain script conversion reads wrong to local readers. Sent
 * with every request in the user message (never counted against the user's quota).
 */
export const LOCALE_GUIDES: Readonly<Record<string, string>> = {
  'zh-TW':
    'Write the way people in Taiwan do, not Mainland Chinese terms converted to traditional characters. ' +
    'Use: 影片 (not 視頻), 軟體 (not 軟件), 程式 (not 程序), 資料 (not 數據), 網路 (not 網絡), 品質 (not 質量), 伺服器 (not 服務器), ' +
    '預設 (not 默認), 設定 (not 設置), 檔案 (not 文件 for computer files), 使用者 (not 用戶), 專案 (not 項目), 記憶體 (not 內存), ' +
    '支援 (not 支持 for features), 資訊 (not 信息), 連結 (not 鏈接), 登入 (not 登錄), 帳號 (not 賬號), 介面 (not 界面), 列印 (not 打印), ' +
    '滑鼠 (not 鼠標), 線上 (not 在線), 數位 (not 數字 for digital), 硬碟 (not 硬盤), 簡訊 (not 短信), 資料庫 (not 數據庫), ' +
    '計程車, 公車, 鳳梨, 馬鈴薯. Use 「」 for quotation marks.',
  'zh-HK':
    'Write formal Hong Kong written Chinese (書面語), not Cantonese colloquial and not Mainland terms converted to traditional characters. ' +
    'Use Hong Kong vocabulary: 軟件, 網絡, 程式, 伺服器, 預設, 檔案, 用戶, 質素 (for quality), 記憶體, 支援, 資訊, 連結, 登入, 介面, ' +
    '滑鼠, 網上 (for online), 數碼 (for digital), 硬碟, 短訊, 的士, 巴士, 菠蘿. Use 「」 for quotation marks.',
}

function languageLine(language: Language): string {
  const guide = LOCALE_GUIDES[language.code]
  return `Target language: ${language.prompt}` + (guide ? `\nUsage: ${guide}` : '')
}

export function buildBatchMessages(texts: readonly string[], language: Language, context: string): ChatMessage[] {
  const head = languageLine(language) + (context ? `\nPage title: ${context.slice(0, 200)}` : '')
  return [
    { role: 'system', content: BATCH_SYSTEM_PROMPT },
    { role: 'user', content: `${head}\n\n${batchPayload(texts)}` },
  ]
}

export function textSystemPrompt(language: Language): string {
  const guide = LOCALE_GUIDES[language.code]
  return (
    `You are a professional translator. Translate the user's text into ${language.prompt}. Output only the translation, keep the original line breaks, and do not add notes.` +
    (guide ? `\n${guide}` : '')
  )
}

export function buildTextMessages(text: string, language: Language): ChatMessage[] {
  return [
    { role: 'system', content: textSystemPrompt(language) },
    { role: 'user', content: text },
  ]
}
