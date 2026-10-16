import { errorText, type UiLang } from '../shared/i18n'
import type { ErrorCode, WireError } from '../shared/messages'

/**
 * `detail` is either raw text from the server or a message key (see i18n); the friendly text is
 * produced in the interface language only when the error is shown or sent to the page.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly detail = '',
  ) {
    super(errorText('en', code, detail))
    this.name = 'ApiError'
  }

  text(lang: UiLang): string {
    return errorText(lang, this.code, this.detail)
  }

  toWire(lang: UiLang): WireError {
    return { code: this.code, message: this.text(lang) }
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof DOMException && err.name === 'AbortError') return new ApiError('aborted')
  return new ApiError('network', err instanceof Error ? err.message : String(err))
}
