import { resolveUiLang, translator } from '../shared/i18n'
import type { PageState } from '../shared/messages'
import { engineId, type DisplayMode, type Settings } from '../shared/settings'
import { Batcher } from './batcher'
import {
  classifyElement,
  forgetLayout,
  isOwnElement,
  nearestScanRoot,
  scanContainer,
  scanNestedBlocks,
  type Run,
  type ScanCallbacks,
  type ScanRoot,
} from './dom-classify'
import { isOwnWrite } from './text-state'
import {
  clearTranslation,
  createUnit,
  isUnitAttached,
  renderUnit,
  setTranslation,
  TRANSLATION_TAG,
  type Unit,
} from './unit'

const MUTATION_DEBOUNCE_MS = 150
const EMIT_THROTTLE_MS = 120
/**
 * Guards against frameworks that keep reverting our text (would otherwise loop forever).
 * Counted per time window so long-lived SPA roots (feeds, chats) keep translating.
 */
const MAX_RESCANS_PER_WINDOW = 40
const RESCAN_WINDOW_MS = 10_000
/** Viewport plus the area about to scroll in. */
const LAZY_ROOT_MARGIN = '40% 0px 120% 0px'

interface Stats {
  total: number
  done: number
  failed: number
}

/**
 * Owns all translation state of one page: units, the markup → translation cache, lazy
 * loading via IntersectionObserver and SPA resilience via MutationObserver. Mode switches
 * re-render purely from memory — the API is only hit for markup never seen before.
 */
export class PageTranslator {
  private mode: DisplayMode = 'original'
  private isStarted = false
  private units = new Set<Unit>()
  private readonly rootUnits = new WeakMap<ScanRoot, Unit[]>()
  private readonly targetUnits = new WeakMap<Element, Set<Unit>>()
  private readonly cache = new Map<string, string>()
  private readonly waiting = new Map<string, Set<Unit>>()
  private readonly failedKeys = new Set<string>()
  private readonly rescans = new WeakMap<ScanRoot, { count: number; windowStart: number }>()
  private readonly observedShadows = new WeakSet<ShadowRoot>()
  private stats: Stats = { total: 0, done: 0, failed: 0 }
  private lastError: string | null = null
  private io: IntersectionObserver | null = null
  private mo: MutationObserver | null = null
  private pendingRecords: MutationRecord[] = []
  private mutationTimer: ReturnType<typeof setTimeout> | null = null
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<(state: PageState) => void>()
  private readonly batcher: Batcher
  private readonly scanCallbacks: ScanCallbacks = {
    onRoot: (root, runs) => this.replaceRootUnits(root, runs),
    onShadowRoot: (shadow) => this.observeMutations(shadow),
  }

  constructor(private settings: Settings) {
    this.batcher = new Batcher(
      {
        onResult: (key, translation) => this.handleResult(key, translation),
        onFail: (keys, _code, message) => this.handleFail(keys, message),
      },
      () => document.title,
      () => translator(resolveUiLang(this.settings.uiLang)),
    )
  }

  // ───────────── public API ─────────────

  getState(): PageState {
    return { mode: this.mode, started: this.isStarted, ...this.stats, error: this.lastError }
  }

  subscribe(listener: (state: PageState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setMode(mode: DisplayMode): void {
    if (mode === this.mode) return
    this.mode = mode
    if (mode !== 'original' && !this.isStarted) {
      this.start()
    } else {
      this.units.forEach((unit) => this.render(unit))
      if (mode === 'original') this.io?.disconnect()
      else this.observePending()
    }
    this.emitNow()
  }

  retryFailed(): void {
    this.failedKeys.clear()
    this.stats = { ...this.stats, failed: 0 }
    this.lastError = null
    this.units.forEach((unit) => {
      if (unit.failed) unit.failed = false
    })
    if (this.isTranslating()) this.observePending()
    this.emitNow()
  }

  updateSettings(next: Settings): void {
    const prev = this.settings
    this.settings = next
    if (prev.targetLang !== next.targetLang || engineId(prev) !== engineId(next)) {
      this.resetTranslations()
    } else if (prev.bilingualStyle !== next.bilingualStyle && this.mode === 'bilingual') {
      this.units.forEach((unit) => this.render(unit))
    }
  }

  // ───────────── lifecycle ─────────────

  private isTranslating(): boolean {
    return this.isStarted && this.mode !== 'original'
  }

  private start(): void {
    this.isStarted = true
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: LAZY_ROOT_MARGIN })
    this.mo = new MutationObserver((records) => this.onMutations(records))
    this.observeMutations(document.body)
    scanContainer(document.body, true, this.scanCallbacks)
  }

  private resetTranslations(): void {
    this.batcher.cancelAll()
    this.units.forEach((unit) => renderUnit(unit, 'original', this.settings.bilingualStyle))
    this.units = new Set()
    this.cache.clear()
    this.waiting.clear()
    this.failedKeys.clear()
    this.stats = { total: 0, done: 0, failed: 0 }
    this.lastError = null
    if (this.isStarted) {
      this.io?.disconnect()
      scanContainer(document.body, true, this.scanCallbacks)
    }
    this.emitNow()
  }

  private observeMutations(node: Node): void {
    if (!this.mo) return
    if (node instanceof ShadowRoot) {
      if (this.observedShadows.has(node)) return
      this.observedShadows.add(node)
    }
    this.mo.observe(node, { childList: true, subtree: true, characterData: true })
  }

  // ───────────── units ─────────────

  private replaceRootUnits(root: ScanRoot, runs: Run[]): void {
    ;(this.rootUnits.get(root) ?? []).forEach((unit) => this.dropUnit(unit))
    const fresh = runs.flatMap((run) => createUnit(run, this.settings.targetLang) ?? [])
    this.rootUnits.set(root, fresh)
    fresh.forEach((unit) => this.addUnit(unit))
  }

  private dropUnit(unit: Unit): void {
    renderUnit(unit, 'original', this.settings.bilingualStyle)
    this.units.delete(unit)
    this.targetUnits.get(unit.target)?.delete(unit)
    this.waiting.get(unit.key)?.delete(unit)
  }

  private addUnit(unit: Unit): void {
    this.units.add(unit)
    const cached = this.cache.get(unit.key)
    if (cached !== undefined) {
      setTranslation(unit, cached)
      this.render(unit)
      return
    }
    const siblings = this.targetUnits.get(unit.target) ?? new Set<Unit>()
    siblings.add(unit)
    this.targetUnits.set(unit.target, siblings)
    if (this.failedKeys.has(unit.key)) {
      unit.failed = true
      return
    }
    const waiting = this.waiting.get(unit.key)
    if (waiting) {
      unit.requested = true
      waiting.add(unit)
      return
    }
    if (this.isTranslating()) this.observe(unit.target)
  }

  private render(unit: Unit): void {
    renderUnit(unit, this.mode, this.settings.bilingualStyle)
  }

  private needsRequest(unit: Unit): boolean {
    return !unit.translation && !unit.requested && !unit.failed
  }

  /** Re-observing makes IntersectionObserver report the current state again. */
  private observe(target: Element): void {
    this.io?.unobserve(target)
    this.io?.observe(target)
  }

  private observePending(): void {
    const targets = new Set<Element>()
    this.units.forEach((unit) => {
      if (this.needsRequest(unit)) targets.add(unit.target)
    })
    targets.forEach((target) => this.observe(target))
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    if (!this.isTranslating()) return
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      this.targetUnits.get(entry.target)?.forEach((unit) => {
        if (this.units.has(unit) && this.needsRequest(unit)) this.request(unit)
      })
      this.io?.unobserve(entry.target)
    }
  }

  private request(unit: Unit): void {
    const cached = this.cache.get(unit.key)
    if (cached !== undefined) {
      setTranslation(unit, cached)
      this.render(unit)
      return
    }
    unit.requested = true
    let waiting = this.waiting.get(unit.key)
    if (!waiting) {
      waiting = new Set()
      this.waiting.set(unit.key, waiting)
      this.stats = { ...this.stats, total: this.stats.total + 1 }
      this.batcher.enqueue(unit.key)
    }
    waiting.add(unit)
    this.emit()
  }

  private handleResult(key: string, translation: string): void {
    this.cache.set(key, translation)
    const waiting = this.waiting.get(key)
    if (!waiting) return
    this.waiting.delete(key)
    this.stats = { ...this.stats, done: this.stats.done + 1 }
    waiting.forEach((unit) => {
      if (!this.units.has(unit)) return
      setTranslation(unit, translation)
      this.render(unit)
    })
    this.emit()
  }

  private handleFail(keys: string[], message: string): void {
    keys.forEach((key) => {
      const waiting = this.waiting.get(key)
      if (!waiting) return
      this.waiting.delete(key)
      this.failedKeys.add(key)
      waiting.forEach((unit) => {
        clearTranslation(unit)
        unit.failed = true
      })
      this.stats = { ...this.stats, failed: this.stats.failed + 1 }
    })
    this.lastError = message
    this.emit()
  }

  // ───────────── SPA / mutations ─────────────

  private onMutations(records: MutationRecord[]): void {
    this.pendingRecords.push(...records)
    this.mutationTimer ??= setTimeout(() => this.processMutations(), MUTATION_DEBOUNCE_MS)
  }

  private processMutations(): void {
    const records = this.pendingRecords
    this.pendingRecords = []
    this.mutationTimer = null
    const shallowRoots = new Set<ScanRoot>()
    const addedElements = new Set<Element>()
    let hasRemovals = false

    for (const record of records) {
      if (record.type === 'characterData') {
        const node = record.target
        if (node.nodeType !== Node.TEXT_NODE || isOwnWrite(node as Text)) continue
        const root = nearestScanRoot(node)
        if (root) shallowRoots.add(root)
        continue
      }
      const added = [...record.addedNodes].filter((n) => !isOwnNode(n))
      const removed = [...record.removedNodes].filter((n) => !isOwnNode(n))
      if ((!added.length && !removed.length) || isInsideTranslation(record.target)) continue
      hasRemovals ||= removed.length > 0
      forgetLayoutChain(record.target)
      const root = nearestScanRoot(record.target)
      if (!root) continue
      shallowRoots.add(root)
      added.forEach((n) => n instanceof Element && n.isConnected && addedElements.add(n))
    }

    addedElements.forEach((el) => this.scanAdded(el))
    shallowRoots.forEach((root) => this.rescan(root))
    if (hasRemovals) this.pruneDetached()
    this.emit()
  }

  private scanAdded(el: Element): void {
    const kind = classifyElement(el)
    if (kind === 'block') scanContainer(el, true, this.scanCallbacks)
    else if (kind === 'inline') scanNestedBlocks(el, this.scanCallbacks)
  }

  private rescan(root: ScanRoot): void {
    if (!root.isConnected) return
    const now = performance.now()
    const prev = this.rescans.get(root)
    const isSameWindow = !!prev && now - prev.windowStart < RESCAN_WINDOW_MS
    const next = isSameWindow ? { count: prev.count + 1, windowStart: prev.windowStart } : { count: 1, windowStart: now }
    this.rescans.set(root, next)
    if (next.count > MAX_RESCANS_PER_WINDOW) return
    scanContainer(root, false, this.scanCallbacks)
  }

  private pruneDetached(): void {
    this.units.forEach((unit) => {
      if (!isUnitAttached(unit)) this.units.delete(unit)
    })
  }

  // ───────────── state broadcast ─────────────

  private emit(): void {
    this.emitTimer ??= setTimeout(() => this.emitNow(), EMIT_THROTTLE_MS)
  }

  private emitNow(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    this.emitTimer = null
    const state = this.getState()
    this.listeners.forEach((listener) => listener(state))
  }
}

function isOwnNode(node: Node): boolean {
  return node instanceof Element && isOwnElement(node)
}

function isInsideTranslation(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement
  return !!el?.closest(TRANSLATION_TAG)
}

function forgetLayoutChain(node: Node): void {
  for (let el = node instanceof Element ? node : node.parentElement; el; el = el.parentElement) forgetLayout(el)
}
