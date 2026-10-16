/**
 * Thin typed wrapper around Chrome's built-in AI (Chrome 138+ desktop): Translator,
 * LanguageDetector and LanguageModel (Gemini Nano). These globals only exist in window
 * contexts — the offscreen document and the popup — never in the service worker.
 */

export type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

interface DownloadMonitor {
  addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void
}
type MonitorFn = (monitor: DownloadMonitor) => void

export interface ChromeTranslator {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>
  destroy(): void
}

export interface ChromeLanguageDetector {
  detect(text: string, options?: { signal?: AbortSignal }): Promise<Array<{ detectedLanguage: string; confidence: number }>>
  destroy(): void
}

export interface ChromeLanguageModel {
  prompt(input: string, options?: { signal?: AbortSignal; responseConstraint?: object }): Promise<string>
  promptStreaming(input: string, options?: { signal?: AbortSignal; responseConstraint?: object }): ReadableStream<string>
  clone(options?: { signal?: AbortSignal }): Promise<ChromeLanguageModel>
  destroy(): void
}

interface TranslatorPair {
  sourceLanguage: string
  targetLanguage: string
}

interface ChromeAiGlobals {
  Translator?: {
    availability(options: TranslatorPair): Promise<Availability>
    create(options: TranslatorPair & { monitor?: MonitorFn; signal?: AbortSignal }): Promise<ChromeTranslator>
  }
  LanguageDetector?: {
    availability(): Promise<Availability>
    create(options?: { monitor?: MonitorFn; signal?: AbortSignal }): Promise<ChromeLanguageDetector>
  }
  LanguageModel?: {
    availability(options?: object): Promise<Availability>
    create(options?: object): Promise<ChromeLanguageModel>
  }
}

const ai = globalThis as unknown as ChromeAiGlobals

export const hasTranslator = (): boolean => !!ai.Translator && !!ai.LanguageDetector
export const hasLanguageModel = (): boolean => !!ai.LanguageModel

/** Raised for a missing API or a model that still has to be downloaded with a user gesture. */
export class ChromeAiError extends Error {
  constructor(
    readonly code: 'unavailable' | 'model-download',
    message: string,
  ) {
    super(message)
    this.name = 'ChromeAiError'
  }
}

const UNSUPPORTED = '当前浏览器不支持，需要桌面版 Chrome 138 及以上'

function monitorProgress(onProgress?: (loaded: number) => void): MonitorFn | undefined {
  return onProgress && ((m) => m.addEventListener('downloadprogress', (e) => onProgress(e.loaded)))
}

/**
 * `create()` may only start a download inside a user gesture. Without one (offscreen document)
 * a model that is not on disk yet is reported as `model-download` instead of failing obscurely.
 */
async function createChecked<T>(availability: Availability, create: () => Promise<T>, what: string): Promise<T> {
  if (availability === 'unavailable') throw new ChromeAiError('unavailable', `${what}在此设备上不可用`)
  try {
    return await create()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError' && availability !== 'available') {
      throw new ChromeAiError('model-download', `${what}尚未下载`)
    }
    throw err
  }
}

export async function translatorAvailability(pair: TranslatorPair): Promise<Availability> {
  if (!ai.Translator) return 'unavailable'
  return ai.Translator.availability(pair)
}

export async function createTranslator(pair: TranslatorPair, onProgress?: (loaded: number) => void): Promise<ChromeTranslator> {
  const api = ai.Translator
  if (!api) throw new ChromeAiError('unavailable', UNSUPPORTED)
  return createChecked(await api.availability(pair), () => api.create({ ...pair, monitor: monitorProgress(onProgress) }), `翻译模型 ${pair.sourceLanguage} → ${pair.targetLanguage} `)
}

export async function detectorAvailability(): Promise<Availability> {
  return ai.LanguageDetector ? ai.LanguageDetector.availability() : 'unavailable'
}

export async function createDetector(onProgress?: (loaded: number) => void): Promise<ChromeLanguageDetector> {
  const api = ai.LanguageDetector
  if (!api) throw new ChromeAiError('unavailable', UNSUPPORTED)
  return createChecked(await api.availability(), () => api.create({ monitor: monitorProgress(onProgress) }), '语言检测模型')
}

/**
 * Gemini Nano officially supports output in en / ja / es / de / fr only. For other targets the
 * session is created without `expectedOutputs` (Chrome would reject it) and quality may vary.
 */
const NANO_OUTPUT_LANGUAGES = ['en', 'ja', 'es', 'de', 'fr']

function nanoOptions(outputLanguage: string): object {
  const base = outputLanguage.split('-')[0]
  return NANO_OUTPUT_LANGUAGES.includes(base)
    ? { expectedInputs: [{ type: 'text' }], expectedOutputs: [{ type: 'text', languages: [base] }] }
    : { expectedInputs: [{ type: 'text' }] }
}

export function isNanoOutputSupported(outputLanguage: string): boolean {
  return NANO_OUTPUT_LANGUAGES.includes(outputLanguage.split('-')[0])
}

export async function languageModelAvailability(outputLanguage = 'en'): Promise<Availability> {
  return ai.LanguageModel ? ai.LanguageModel.availability(nanoOptions(outputLanguage)) : 'unavailable'
}

export async function createLanguageModel(
  systemPrompt: string,
  outputLanguage: string,
  onProgress?: (loaded: number) => void,
): Promise<ChromeLanguageModel> {
  const api = ai.LanguageModel
  if (!api) throw new ChromeAiError('unavailable', UNSUPPORTED)
  const options = nanoOptions(outputLanguage)
  return createChecked(
    await api.availability(options),
    () => api.create({ ...options, initialPrompts: [{ role: 'system', content: systemPrompt }], monitor: monitorProgress(onProgress) }),
    'Gemini Nano 模型',
  )
}
