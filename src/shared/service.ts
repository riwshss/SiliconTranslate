// Build-time constants injected by build.mjs (esbuild `define`). Tests and type-checking see the
// fallbacks, so nothing here may depend on a real build.

declare const __SILK_API_URL__: string | undefined
declare const __SILK_CHANNEL__: string | undefined

export type ReleaseChannel = 'beta' | 'stable'

/** Silk backend (Cloudflare Worker) that proxies the cloud AI engine. No trailing slash. The
 * fallback (local `wrangler dev`) only applies to tests; real builds always inject a URL. */
export const CLOUD_API_URL: string = typeof __SILK_API_URL__ === 'string' ? __SILK_API_URL__ : 'http://127.0.0.1:8787'

export const RELEASE_CHANNEL: ReleaseChannel = typeof __SILK_CHANNEL__ === 'string' && __SILK_CHANNEL__ === 'stable' ? 'stable' : 'beta'
