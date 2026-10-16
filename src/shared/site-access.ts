// Site access: the store build asks for no site at install. Users grant every site (selection
// translation, the page shortcut and "always translate" work everywhere) or one site at a time
// ("always translate" on that host) through optional_host_permissions, and the service worker
// registers the content script for exactly the origins granted. Without a grant the popup still
// injects into the active tab on click (activeTab).

export const ALL_SITES: readonly string[] = ['http://*/*', 'https://*/*']

/** Match pattern for one host, e.g. `https://example.com/*` (ports are ignored by match patterns). */
export function sitePattern(url: URL): string {
  return `${url.protocol}//${url.hostname}/*`
}

/** Granted origins the content script should run on: web pages only, never the Silk backend. */
export function contentScriptMatches(origins: readonly string[], apiUrl: string): string[] {
  const api = sitePattern(new URL(apiUrl))
  return origins.filter((origin) => /^(https?|\*):\/\//.test(origin) && origin !== api)
}

export function hasAllSites(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [...ALL_SITES] })
}
