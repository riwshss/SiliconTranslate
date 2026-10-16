import type { PageState, TabMessage } from './messages'

/**
 * The page shortcut, declared under `commands` in static/manifest.json. A browser command (not a
 * keydown listener in the page) works on every tab without any site permission: pressing it
 * grants activeTab, just like clicking the toolbar icon. Users rebind it at
 * chrome://extensions/shortcuts.
 */
export const TOGGLE_COMMAND = 'toggle-translation'
export const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts'

/**
 * Sends `message` to the page in `tabId`, injecting the content script first when it is not
 * running there (no site grant, or the tab was open before install). Needs activeTab, which a
 * click on the toolbar icon or the keyboard shortcut grants; fails on pages no extension may
 * touch (chrome://, the Web Store).
 */
export async function sendToTab(tabId: number, message: TabMessage): Promise<PageState> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as PageState
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    return (await chrome.tabs.sendMessage(tabId, message)) as PageState
  }
}

/** chrome.commands.onCommand handler: the shortcut toggles the tab it was pressed in. */
export async function handleCommand(command: string, tab?: chrome.tabs.Tab): Promise<void> {
  if (command !== TOGGLE_COMMAND || tab?.id === undefined) return
  await sendToTab(tab.id, { type: 'silk:toggle' })
}
