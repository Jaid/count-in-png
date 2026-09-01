/**
 * A decoded PNG image ready for pixel iteration.
 */
export type PngImage = {
  readonly bytesPerPixel: 4
  /** decoded RGBA pixels, 4 bytes per pixel */
  readonly data: Uint8Array
  /** `true` when the PNG contains alpha or `tRNS` transparency information */
  readonly hasAlpha: boolean
  readonly height: number
  readonly width: number
}

/** per-pixel descriptor passed to function predicates */
export type Pixel = {
  readonly blue: number
  readonly green: number
  /** absent when the PNG has no alpha channel and no `tRNS` transparency */
  readonly opacity?: number
  readonly red: number
  /** 0-based column, 0 … (image.width − 1) */
  readonly x: number
  /** 0-based row, 0 … (image.height − 1) */
  readonly y: number
}

/** CSS-style hex color string such as `f0a`, `#f0af`, `ff00aa` or `#ff00aaff` */
export type StringPredicate = ColorString8

/** function that receives a pixel descriptor and its linear index; return `true` to count it */
export type FunctionPredicate = (pixel: Pixel, index: number) => boolean

export type Predicate = FunctionPredicate | StringPredicate

type HexChar = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'a' | 'A' | 'b' | 'B' | 'c' | 'C' | 'd' | 'D' | 'e' | 'E' | 'f' | 'F'

type ColorString8 = `#${HexChar}${HexChar}${HexChar}${HexChar}${HexChar}${HexChar}${HexChar}${HexChar}`
