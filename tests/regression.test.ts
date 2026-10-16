import { describe, expect, it } from 'vitest'
import { checkTranslation, markersOf, validateFixture, type RegressionFixture } from '../scripts/regression-check.mjs'
import { LANGUAGES } from '../src/shared/languages'
import paragraphs from './fixtures/regression/paragraphs.json'

const fixture = paragraphs as RegressionFixture

describe('regression set', () => {
  it('is a valid fixture of 50–100 paragraphs covering every category', () => {
    expect(validateFixture(fixture, LANGUAGES.map((l) => l.code))).toEqual([])
    expect(fixture.items.length).toBeGreaterThanOrEqual(50)
    expect(fixture.items.length).toBeLessThanOrEqual(100)
    expect(new Set(fixture.items.map((item) => item.category))).toEqual(new Set(['vocab', 'markup', 'dev', 'long', 'ui']))
    // Roadmap 1.1: the common Taiwan terms are all checked.
    const twTerms = fixture.items.flatMap((item) => item.expect?.['zh-TW']?.must ?? [])
    for (const term of ['影片', '軟體', '程式', '資料', '網路', '品質']) expect(twTerms).toContain(term)
  })

  it('catches the usual problems', () => {
    const item = { id: 'x', category: 'markup', source: 'Run <c0>npm i</c0> and read <g1>the guide</g1>.', keep: ['npm i'], expect: { 'zh-TW': { must: ['指南'], mustNot: ['指引'] } } }
    expect(markersOf(item.source)).toEqual(new Set(['c0', 'g1']))
    expect(checkTranslation(item, 'zh-TW', '執行 <c0>npm i</c0> 並閱讀<g1>指南</g1>。')).toEqual([])
    expect(checkTranslation(item, 'zh-TW', '執行 npm 並閱讀指引。')).toEqual(['lost markers: c0, g1', 'changed: npm i', 'missing term: 指南', 'forbidden term: 指引'])
    expect(checkTranslation(item, 'ja', '<c0>npm i</c0> <g1>ガイド</g1>')).toEqual([])
    expect(checkTranslation(item, 'zh-TW', undefined)).toEqual(['no translation'])
  })

  it('reports fixture mistakes', () => {
    const bad = { version: 1, items: [{ id: 'a', category: 'x', source: 'hi', keep: ['bye'], expect: { xx: { must: ['影片'], mustNot: ['影'] } } }, { id: 'a', category: 'x', source: ' ' }] }
    expect(validateFixture(bad, ['zh-TW'])).toEqual([
      'a: keep "bye" is not in the source',
      'a: unknown target xx',
      'a: xx must and mustNot overlap: 影片',
      'duplicate or missing id: a',
      'a: empty source',
    ])
  })
})
