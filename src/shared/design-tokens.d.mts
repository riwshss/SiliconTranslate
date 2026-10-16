type Tokens = Readonly<Record<string, string>>

export const LIGHT: Tokens
export const DARK: Tokens
export const SHARED: Tokens
export const FONT_UI_TC: string
export const FONT_UI_SC: string
export function tokenCss(scope: string): string
