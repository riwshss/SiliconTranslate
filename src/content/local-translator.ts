// Chrome's built-in, on-device Translator API. Plans without cloud AI use it when the browser has
// it (it needs a newer Chrome than minimum_chrome_version, hence feature detection); otherwise
// they fall back to the cloud engine and its small free quota.

import { stripMarkup } from '../core/markup-text'
import { canUseCloudAi, defaultEntitlement, ENTITLEMENT_KEY, sanitizeEntitlement } from '../shared/entitlement'
import { RELEASE_CHANNEL } from '../shared/service'

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

interface TranslatorInstance {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>
}

interface TranslatorApi {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorInstance>
}

interface LanguageDetectorApi {
  create(): Promise<{ detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>> }>
}

interface BuiltInAi {
  Translator?: TranslatorApi
  LanguageDetector?: LanguageDetectorApi
}

const ai = self as unknown as BuiltInAi

export function hasLocalTranslator(): boolean {
  return 'Translator' in self
}

/** Our language codes (src/shared/languages.ts) as BCP 47 tags the Translator API knows. */
export function toTranslatorLanguage(code: string): string {
  if (code === 'zh-CN') return 'zh'
  if (code === 'zh-TW') return 'zh-Hant'
  return code
}

/** Language for "is this already the target?": the base tag, with Chinese split by script. */
function sameLanguageKey(tag: string): string {
  const base = tag.toLowerCase().split('-')[0]
  if (base !== 'zh') return base
  return /-(hant|tw|hk|mo)\b/i.test(tag) ? 'zh-hant' : 'zh'
}
const MIN_DETECT_CONFIDENCE = 0.5

/** Engine for page translation: the plan decides, then whether this browser can translate on device. */
export async function pickPageEngine(): Promise<'cloud' | 'local'> {
  const stored = (await chrome.storage.local.get(ENTITLEMENT_KEY))[ENTITLEMENT_KEY]
  const entitlement = sanitizeEntitlement(stored) ?? defaultEntitlement(RELEASE_CHANNEL)
  return !canUseCloudAi(entitlement) && hasLocalTranslator() ? 'local' : 'cloud'
}

/**
 * Translates markup strings on device. Markers are dropped (the on-device model does not keep
 * them), so units render as plain text, the same fallback as a cloud reply that lost them.
 */
export class LocalTranslator {
  private readonly translators = new Map<string, Promise<TranslatorInstance | null>>()
  private detector: ReturnType<LanguageDetectorApi['create']> | null = null

  constructor(private readonly target: string) {}

  /** The translation, or null when this language pair cannot be translated on device. */
  async translate(markup: string, signal?: AbortSignal): Promise<string | null> {
    const text = stripMarkup(markup)
    const source = await this.sourceLanguage(text)
    const target = toTranslatorLanguage(this.target)
    if (sameLanguageKey(source) === sameLanguageKey(target)) return text
    const translator = await this.translatorFor(source, target)
    return translator ? translator.translate(text, { signal }) : null
  }

  private translatorFor(source: string, target: string): Promise<TranslatorInstance | null> {
    const key = `${source}>${target}`
    let translator = this.translators.get(key)
    if (!translator) {
      translator = (async () => {
        const api = ai.Translator
        if (!api || (await api.availability({ sourceLanguage: source, targetLanguage: target })) === 'unavailable') return null
        return api.create({ sourceLanguage: source, targetLanguage: target })
      })().catch(() => null)
      this.translators.set(key, translator)
    }
    return translator
  }

  private async sourceLanguage(text: string): Promise<string> {
    const fallback = document.documentElement.lang || 'en'
    if (!ai.LanguageDetector) return fallback
    try {
      this.detector ??= ai.LanguageDetector.create()
      const [best] = await (await this.detector).detect(text)
      return best && best.confidence >= MIN_DETECT_CONFIDENCE && best.detectedLanguage !== 'und' ? best.detectedLanguage : fallback
    } catch {
      return fallback
    }
  }
}
