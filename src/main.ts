import type {FunctionPredicate, Pixel, PngImage, Predicate, StringPredicate} from '#src/lib/types/types.ts'

import {parseHexPredicate} from '#src/lib/parseHexPredicate.ts'
import {parsePng} from '#src/lib/parsePng.ts'

function countPixelsByHexPredicate(png: PngImage, predicate: ReturnType<typeof parseHexPredicate>): number {
  let count = 0
  for (let index = 0; index < png.width * png.height; index++) {
    const offset = index * png.bytesPerPixel
    if (png.data[offset] !== predicate.red) {
      continue
    }
    if (png.data[offset + 1] !== predicate.green) {
      continue
    }
    if (png.data[offset + 2] !== predicate.blue) {
      continue
    }
    if (predicate.opacity !== undefined && png.data[offset + 3] !== predicate.opacity) {
      continue
    }
    count++
  }
  return count
}
function countPixelsByFunctionPredicate(png: PngImage, predicate: FunctionPredicate): number {
  const {data, hasAlpha, width, height} = png
  let count = 0
  for (let index = 0; index < width * height; index++) {
    const offset = index * png.bytesPerPixel
    const x = index % width
    const y = Math.floor(index / width)
    const red = data[offset]
    const green = data[offset + 1]
    const blue = data[offset + 2]
    const pixel: Pixel = hasAlpha ? {
      x,
      y,
      red,
      green,
      blue,
      opacity: data[offset + 3],
    } : {
      x,
      y,
      red,
      green,
      blue,
    }
    if (predicate(pixel, index)) {
      count++
    }
  }
  return count
}
/**
 * Count pixels in a PNG image that satisfy the given predicate.
 *
 * If no predicate is provided, the image’s total pixel count is returned.
 */
function countPixels(image: Uint8Array, predicate?: Predicate): number {
  const png = parsePng(image)
  if (predicate === undefined) {
    return png.width * png.height
  }
  if (typeof predicate === 'string') {
    return countPixelsByHexPredicate(png, parseHexPredicate(predicate))
  }
  if (typeof predicate === 'function') {
    return countPixelsByFunctionPredicate(png, predicate)
  }
  throw new TypeError('Expected predicate to be a function, a hex string or undefined.')
}

export default countPixels
export type {FunctionPredicate, Pixel, PngImage, Predicate, StringPredicate}
