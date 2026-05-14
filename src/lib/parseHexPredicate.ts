const hexPredicatePattern = /^#?(?<digits>[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export type HexPredicate = {
  readonly blue: number
  readonly green: number
  readonly opacity?: number
  readonly red: number
}

export function parseHexPredicate(input: string): HexPredicate {
  const match = hexPredicatePattern.exec(input.trim())
  const digits = match?.groups?.digits
  if (!digits) {
    throw new TypeError('Invalid hex predicate. Expected #RGB, #RGBA, #RRGGBB or #RRGGBBAA.')
  }
  const expandedDigits = digits.length <= 4 ? [...digits].map(component => component.repeat(2)).join('') : digits
  return {
    red: Number.parseInt(expandedDigits.slice(0, 2), 16),
    green: Number.parseInt(expandedDigits.slice(2, 4), 16),
    blue: Number.parseInt(expandedDigits.slice(4, 6), 16),
    opacity: expandedDigits.length === 8 ? Number.parseInt(expandedDigits.slice(6, 8), 16) : undefined,
  }
}
