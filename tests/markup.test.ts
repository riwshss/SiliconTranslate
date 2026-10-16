// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  buildTranslationFragment,
  computeOverlayPlan,
  fromGoogleHtml,
  keepsFormattingMarkers,
  parseMarkup,
  serializeRun,
  stripMarkup,
  toGoogleHtml,
  type Classify,
} from '../src/core/markup'

const FROZEN = new Set(['code', 'kbd', 'img', 'br', 'svg'])
const classify: Classify = (el) => {
  if (el.localName === 'script') return 'ignore'
  return FROZEN.has(el.localName) ? 'frozen' : 'inline'
}
const read = (t: Text) => t.nodeValue ?? ''

function paragraph(html: string): HTMLElement {
  const p = document.createElement('p')
  p.innerHTML = html
  return p
}

function applyPlan(plan: Map<Text, string>): void {
  plan.forEach((value, node) => {
    node.nodeValue = value
  })
}

describe('serializeRun', () => {
  it('wraps inline elements in numbered g-markers and freezes code', () => {
    const p = paragraph('Click <a href="/x">here</a> to run <code>npm i</code>.')
    const ser = serializeRun([...p.childNodes], classify, read)
    expect(ser.markup).toBe('Click <g0>here</g0> to run <c1>npm i</c1>.')
    expect(ser.plain).toBe('Click here to run .')
    expect(ser.textNodes).toHaveLength(4)
  })

  it('escapes angle brackets in text and collapses whitespace', () => {
    const p = paragraph('  a &lt; b\n\n   and <b>c &amp; d</b>  ')
    const ser = serializeRun([...p.childNodes], classify, read)
    expect(ser.markup).toBe('a &lt; b and <g0>c &amp; d</g0>')
  })

  it('drops empty decorative wrappers and ignored elements', () => {
    const p = paragraph('<i class="icon"></i> Home <script>x()</script>')
    const ser = serializeRun([...p.childNodes], classify, read)
    expect(ser.markup).toBe('Home')
  })

  it('uses self-closing markers for frozen elements without text', () => {
    const p = paragraph('Line one<br>Line two')
    expect(serializeRun([...p.childNodes], classify, read).markup).toBe('Line one<c0/>Line two')
  })
})

describe('parseMarkup', () => {
  it('builds a nested tree and unescapes entities', () => {
    expect(parseMarkup('a &lt; <g0>b <g1>c</g1></g0><c2/>')).toEqual([
      { kind: 'text', text: 'a < ' },
      {
        kind: 'tag', id: 0, frozen: false,
        children: [{ kind: 'text', text: 'b ' }, { kind: 'tag', id: 1, frozen: false, children: [{ kind: 'text', text: 'c' }] }],
      },
      { kind: 'tag', id: 2, frozen: true, children: [] },
    ])
  })

  it('tolerates stray closers, spaces inside markers and unclosed markers', () => {
    expect(stripMarkup('x</g9>< g0 >y')).toBe('xy')
    expect(parseMarkup('<G0>a')).toEqual([{ kind: 'tag', id: 0, frozen: false, children: [{ kind: 'text', text: 'a' }] }])
  })
})

describe('computeOverlayPlan', () => {
  it('maps translated gaps back onto the original text nodes and keeps the link node', () => {
    const p = paragraph('Click <a href="/x">here</a> to continue')
    const link = p.querySelector('a')!
    const ser = serializeRun([...p.childNodes], classify, read)
    applyPlan(computeOverlayPlan(ser, '点击<g0>这里</g0>继续'))
    expect(p.innerHTML).toBe('点击<a href="/x">这里</a>继续')
    expect(p.querySelector('a')).toBe(link)
  })

  it('handles markers moved by the model (word order change)', () => {
    const p = paragraph('Read <b>the docs</b> now')
    const ser = serializeRun([...p.childNodes], classify, read)
    applyPlan(computeOverlayPlan(ser, '<g0>文档</g0>现在读'))
    expect(p.innerHTML).toBe('<b>文档</b>现在读')
  })

  it('handles nested inline elements and leaves frozen code untouched', () => {
    const p = paragraph('Use <a href="#"><em>fast</em> mode</a> with <code>--x</code> flag')
    const ser = serializeRun([...p.childNodes], classify, read)
    applyPlan(computeOverlayPlan(ser, '使用<g0><g1>快速</g1>模式</g0>并加上 <c2>--x</c2> 参数'))
    expect(p.innerHTML).toBe('使用<a href="#"><em>快速</em>模式</a>并加上 <code>--x</code> 参数')
  })

  it('never reorders DOM nodes: permuted markers fill gaps by position', () => {
    const p = paragraph('Use <a href="#">A</a> with <code>--x</code> flag')
    const [link, code] = [p.querySelector('a'), p.querySelector('code')]
    const ser = serializeRun([...p.childNodes], classify, read)
    applyPlan(computeOverlayPlan(ser, '配合 <c1>--x</c1> 参数使用<g0>甲</g0>'))
    expect(p.innerHTML).toBe('配合 <a href="#">甲</a> 参数使用<code>--x</code>')
    expect([p.querySelector('a'), p.querySelector('code')]).toEqual([link, code])
  })

  it('moves text from a gap without nodes into the next text node', () => {
    const p = paragraph('<a href="#">A</a><b>B</b> tail')
    const ser = serializeRun([...p.childNodes], classify, read)
    applyPlan(computeOverlayPlan(ser, '前<g0>甲</g0>中<g1>乙</g1>后'))
    expect(p.textContent).toBe('甲乙前中后')
    expect(p.querySelectorAll('a,b')).toHaveLength(2)
  })

  it('falls back to the first text node when the model dropped a marker', () => {
    const p = paragraph('Hello <a href="#">world</a>!')
    const ser = serializeRun([...p.childNodes], classify, read)
    applyPlan(computeOverlayPlan(ser, '你好世界！'))
    expect(p.innerHTML).toBe('你好世界！<a href="#"></a>')
  })

  it('appends surplus translated gaps to the last gap', () => {
    const p = paragraph('only text')
    const ser = serializeRun([...p.childNodes], classify, read)
    applyPlan(computeOverlayPlan(ser, '只有<c5/>文本'))
    expect(p.textContent).toBe('只有文本')
  })
})

describe('buildTranslationFragment', () => {
  it('clones inline elements (without ids) and frozen code into the bilingual copy', () => {
    const p = paragraph('Go <a id="l" href="/y" class="k">home</a> or <code>cd ~</code>')
    const ser = serializeRun([...p.childNodes], classify, read)
    const host = document.createElement('div')
    host.append(buildTranslationFragment(ser, '回<g0>首页</g0>或 <c1>cd ~</c1>', document))
    expect(host.innerHTML).toBe('回<a href="/y" class="k">首页</a>或 <code>cd ~</code>')
  })

  it('renders unknown markers as plain children and unsafe frozen elements as text', () => {
    const p = paragraph('x <svg><text>icon</text></svg>')
    const ser = serializeRun([...p.childNodes], classify, read)
    const host = document.createElement('div')
    host.append(buildTranslationFragment(ser, '<g7>甲</g7><c0>icon</c0>', document))
    expect(host.innerHTML).toBe('甲icon')
  })
})

describe('engine adapters', () => {
  it('keepsFormattingMarkers requires every <gN> but tolerates dropped frozen markers', () => {
    expect(keepsFormattingMarkers('Click <g0>here</g0> <c1/>', '点击<g0>这里</g0>')).toBe(true)
    expect(keepsFormattingMarkers('Click <g0>here</g0>', '点击这里')).toBe(false)
    expect(keepsFormattingMarkers('plain', '纯文本')).toBe(true)
  })

  it('toGoogleHtml expands self-closing markers that HTML parsing would treat as open tags', () => {
    expect(toGoogleHtml('a<c0/>b <g1>c</g1> <c2>x</c2>')).toBe('a<c0></c0>b <g1>c</g1> <c2>x</c2>')
  })

  it('fromGoogleHtml decodes numeric entities but keeps markup-significant ones escaped', () => {
    expect(fromGoogleHtml('it&#39;s &#8217;ok&#x2019; &#60;tag&#62; &amp; &#38;')).toBe("it's ’ok’ &lt;tag&gt; &amp; &amp;")
    expect(stripMarkup(fromGoogleHtml('<g0>A &amp; B</g0> &quot;q&quot;'))).toBe('A & B "q"')
  })
})
