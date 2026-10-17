// First-install page: since the store build asks for no site access at install, new users would
// not find the shortcut or the "run on all sites" switch on their own. Opened once by the service
// worker on install (not on updates).

import { resolveUiLang, translator, type MessageKey, type Translate } from '../shared/i18n'
import { loadSettings } from '../shared/settings'
import { ALL_SITES, hasAllSites } from '../shared/site-access'
import { SHORTCUTS_PAGE, TOGGLE_COMMAND } from '../shared/tab-messaging'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

function applyLanguage(t: Translate, lang: string): void {
  document.documentElement.lang = lang
  document.title = `${t('welcomeTitle')} · Silk Translate`
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n as MessageKey)))
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria as MessageKey)))
}

/** The key Chrome bound to the toggle command; it may be unset when another extension took Alt+T. */
async function renderShortcut(t: Translate): Promise<void> {
  const commands = await chrome.commands.getAll()
  const shortcut = commands.find((c) => c.name === TOGGLE_COMMAND)?.shortcut ?? ''
  const keys = $('shortcut-keys')
  if (!shortcut) {
    const unset = document.createElement('span')
    unset.className = 'unset'
    unset.textContent = t('welcomeShortcutUnset')
    keys.replaceChildren(unset)
    return
  }
  keys.replaceChildren(
    ...shortcut.split('+').map((part) => {
      const kbd = document.createElement('kbd')
      kbd.textContent = part
      return kbd
    }),
  )
}

/** Same grant as the popup's "run on all sites" switch; the browser asks the user once. */
async function initSiteAccess(t: Translate): Promise<void> {
  const allSites = $<HTMLInputElement>('all-sites')
  const state = $('sites-state')
  const render = async () => {
    allSites.checked = await hasAllSites()
    state.hidden = !allSites.checked
    state.textContent = t('welcomeSitesOn')
  }
  await render()
  allSites.addEventListener('change', () => {
    const origins = [...ALL_SITES]
    const change = allSites.checked ? chrome.permissions.request({ origins }) : chrome.permissions.remove({ origins })
    change.catch((err) => console.error('[silk] site access change failed', err)).finally(() => void render())
  })
  chrome.permissions.onAdded.addListener(() => void render())
  chrome.permissions.onRemoved.addListener(() => void render())
}

async function main(): Promise<void> {
  const settings = await loadSettings()
  const lang = resolveUiLang(settings.uiLang)
  const t = translator(lang)
  applyLanguage(t, lang)
  $('shortcut-change').addEventListener('click', () => void chrome.tabs.create({ url: SHORTCUTS_PAGE }))
  // The user may rebind the key in the tab we just opened, then come back here.
  window.addEventListener('focus', () => void renderShortcut(t))
  await Promise.all([renderShortcut(t), initSiteAccess(t)])
}

main().catch((err) => console.error('[silk] welcome page failed', err))
