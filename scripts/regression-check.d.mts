export interface RegressionItem {
  readonly id: string
  readonly category: string
  readonly source: string
  /** Text that must appear unchanged in every translation (identifiers, numbers, brands). */
  readonly keep?: readonly string[]
  /** Required and forbidden terms per target language code. */
  readonly expect?: Readonly<Record<string, { readonly must?: readonly string[]; readonly mustNot?: readonly string[] }>>
  readonly note?: string
}

export interface RegressionFixture {
  readonly version: number
  readonly items: readonly RegressionItem[]
}

export function markersOf(markup: string): Set<string>
export function checkTranslation(item: RegressionItem, target: string, translation: string | undefined): string[]
export function validateFixture(fixture: RegressionFixture, targets: readonly string[]): string[]
