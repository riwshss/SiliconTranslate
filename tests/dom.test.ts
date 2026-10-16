// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  classifyElement,
  hasBlockDescendant,
  nearestScanRoot,
  scanContainer,
  scanNestedBlocks,
  type Run,
  type ScanRoot,
} from '../src/content/dom-classify'
import { isOwnWrite, originalText, restoreText, writeText } from '../src/content/text-state'
import { createUnit, renderUnit, setTranslation } from '../src/content/unit'

function collect(root: ScanRoot, deep = true): Map<ScanRoot, Run[]> {
  const out = new Map<ScanRoot, Run[]>()
  scanContainer(root, deep, { onRoot: (r, runs) => out.set(r, runs) })
  return out
}

const runText = (run: Run) => run.nodes.map((n) => n.textContent).join('')

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('classifyElement', () => {
  it('classifies by computed display and skip rules', () => {
    document.body.innerHTML = `
      <span id="s">a</span><div id="d">b</div><code id="c">x</code><pre id="p">y</pre>
      <script id="js"></script><span id="nt" translate="no">z</span><div class="notranslate" id="ntb">q</div>
      <span id="icon" class="material-icons">home</span><silk-trans id="own">t</silk-trans>
      <div id="ce" contenteditable="true">e</div>`
    const kind = (id: string) => classifyElement(document.getElementById(id)!)
    expect(kind('s')).toBe('inline')
    expect(kind('d')).toBe('block')
    expect(kind('c')).toBe('frozen')
    expect(kind('p')).toBe('opaque')
    expect(kind('js')).toBe('ignore')
    expect(kind('nt')).toBe('frozen')
    expect(kind('ntb')).toBe('opaque')
    expect(kind('icon')).toBe('frozen')
    expect(kind('own')).toBe('ignore')
    expect(kind('d')).toBe('block')
  })
})

describe('scanContainer', () => {
  it('splits block content into runs and reports nested blocks as their own roots', () => {
    document.body.innerHTML = `<article id="a">Intro <b>bold</b><p id="p">Para <a href="#">link</a></p>tail<pre>code</pre>end</article>`
    const roots = collect(document.getElementById('a')!)
    const article = roots.get(document.getElementById('a')!)!
    expect(article.map(runText)).toEqual(['Intro bold', 'tail', 'end'])
    expect(roots.get(document.getElementById('p')!)!.map(runText)).toEqual(['Para link'])
  })

  it('walks inline wrappers that contain blocks as part of the parent flow', () => {
    document.body.innerHTML = `<div id="r"><a id="card" href="#">Card <div id="t">Title</div></a></div>`
    const roots = collect(document.getElementById('r')!)
    const runs = roots.get(document.getElementById('r')!)!
    expect(runs.map(runText)).toEqual(['Card '])
    expect(runs[0].parent).toBe(document.getElementById('card'))
    expect(roots.get(document.getElementById('t')!)!.map(runText)).toEqual(['Title'])
    expect(hasBlockDescendant(document.getElementById('card')!)).toBe(true)
  })

  it('shallow scans do not descend into nested blocks', () => {
    document.body.innerHTML = `<div id="r">top<p>inner</p></div>`
    const roots = collect(document.getElementById('r')!, false)
    expect([...roots.keys()]).toEqual([document.getElementById('r')])
  })

  it('scans open shadow roots during deep scans', () => {
    document.body.innerHTML = `<div id="host"></div>`
    const host = document.getElementById('host')!
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<p>Shadow text</p>'
    const seen: ShadowRoot[] = []
    const roots = new Map<ScanRoot, Run[]>()
    scanContainer(document.body, true, { onRoot: (r, runs) => roots.set(r, runs), onShadowRoot: (s) => seen.push(s) })
    expect(seen).toEqual([shadow])
    expect(roots.get(shadow.querySelector('p')!)!.map(runText)).toEqual(['Shadow text'])
  })

  it('scanNestedBlocks finds blocks inside an inserted inline subtree', () => {
    document.body.innerHTML = `<span id="s"><b><div id="x">deep</div></b></span>`
    const roots = new Map<ScanRoot, Run[]>()
    scanNestedBlocks(document.getElementById('s')!, { onRoot: (r, runs) => roots.set(r, runs) })
    expect([...roots.keys()]).toEqual([document.getElementById('x')])
  })
})

describe('nearestScanRoot', () => {
  it('returns the closest block, or null inside skipped zones', () => {
    document.body.innerHTML = `<p id="p">a <b id="b">b</b></p><pre><span id="in">x</span></pre>`
    expect(nearestScanRoot(document.getElementById('b')!.firstChild!)).toBe(document.getElementById('p'))
    expect(nearestScanRoot(document.getElementById('in')!.firstChild!)).toBeNull()
    expect(nearestScanRoot(document.body)).toBe(document.body)
  })
})

describe('text-state', () => {
  it('remembers originals, detects own writes and adopts framework updates', () => {
    const node = document.createTextNode('Hello')
    writeText(node, '你好')
    expect(node.nodeValue).toBe('你好')
    expect(originalText(node)).toBe('Hello')
    expect(isOwnWrite(node)).toBe(true)
    node.nodeValue = 'Hi again' // a framework re-render
    expect(isOwnWrite(node)).toBe(false)
    expect(originalText(node)).toBe('Hi again')
    writeText(node, '再见')
    restoreText(node)
    expect(node.nodeValue).toBe('Hi again')
    restoreText(document.createTextNode('untracked'))
  })
})

describe('unit rendering', () => {
  it('switches original / overlay / bilingual from memory and restores the exact DOM', () => {
    document.body.innerHTML = `<p id="p">Click <a href="/go">here</a> to continue reading this article.</p>`
    const p = document.getElementById('p')!
    const before = p.innerHTML
    const runs = collect(p).get(p)!
    const unit = createUnit(runs[0], 'zh-CN')!
    expect(unit.key).toBe('Click <g0>here</g0> to continue reading this article.')
    setTranslation(unit, '点击<g0>这里</g0>继续阅读本文。')

    renderUnit(unit, 'overlay', { style: 'dashed' })
    expect(p.innerHTML).toBe('点击<a href="/go">这里</a>继续阅读本文。')

    renderUnit(unit, 'bilingual', { style: 'highlight', lang: 'zh-CN', revealDelay: 30 })
    expect(p.firstChild?.nodeValue).toBe('Click ')
    const trans = p.querySelector('silk-trans')!
    expect(trans.textContent).toBe('点击这里继续阅读本文。')
    expect(trans.querySelector('a')?.getAttribute('href')).toBe('/go')
    expect(trans.getAttribute('style')).toContain('display:block')
    expect(trans.getAttribute('lang')).toBe('zh-CN')

    renderUnit(unit, 'original', { style: 'dashed' })
    expect(p.innerHTML).toBe(before)
  })

  it('marks bilingual translations lightly: silk dotted underline, dashed, or a silk highlight', () => {
    document.body.innerHTML = `<p id="p">Read the full article before you comment.</p>`
    const p = document.getElementById('p')!
    const unit = createUnit(collect(p).get(p)![0], 'zh-TW')!
    setTranslation(unit, '留言前請先讀完整篇文章。')
    const innerStyle = (style: 'silk' | 'dashed' | 'highlight') => {
      renderUnit(unit, 'bilingual', { style })
      return p.querySelector('silk-t')!.getAttribute('style') ?? ''
    }
    // Inherits the page's font and colour: only a decoration, no colours of its own for the text.
    expect(innerStyle('silk')).toMatch(/text-decoration:underline dotted color-mix\(.*currentColor\)/)
    expect(innerStyle('silk')).toContain('text-underline-offset:.32em')
    expect(innerStyle('silk')).not.toMatch(/(^|;)(color|font|background):/)
    expect(innerStyle('dashed')).toContain('underline dashed')
    expect(innerStyle('highlight')).toMatch(/background:color-mix\(in srgb,#c49b56 18%,transparent\)/)
    expect(innerStyle('highlight')).not.toContain('#f6c445')
  })

  it('skips runs that are already in the target language or not translatable', () => {
    document.body.innerHTML = `<p id="a">这已经是中文了</p><p id="b">12:30</p>`
    const unitFor = (id: string) => createUnit(collect(document.getElementById(id)!).get(document.getElementById(id)!)![0], 'zh-CN')
    expect(unitFor('a')).toBeNull()
    expect(unitFor('b')).toBeNull()
  })
})
