import type {Pixel} from '#src/lib/types/types.ts'

import {describe, expect, test} from 'bun:test'
import {deflateSync} from 'node:zlib'

import countPixels from '#src/main.ts'

const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
function buildCrcTable(): Int32Array {
  const table = new Int32Array(256)
  for (let entry = 0; entry < 256; entry++) {
    let crc = entry
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? 0xED_B8_83_20 ^ crc >>> 1 : crc >>> 1
    }
    table[entry] = crc
  }
  return table
}
const crcTable = buildCrcTable()
function crc32(data: Uint8Array): number {
  let crc = -1
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xFF] ^ crc >>> 8
  }
  return (crc ^ -1) >>> 0
}
function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  view.setUint32(0, data.length, false)
  for (let index = 0; index < 4; index++) {
    chunk[4 + index] = type.codePointAt(index)!
  }
  chunk.set(data, 8)
  const crcInput = new Uint8Array(4 + data.length)
  for (let index = 0; index < 4; index++) {
    crcInput[index] = type.codePointAt(index)!
  }
  crcInput.set(data, 4)
  view.setUint32(8 + data.length, crc32(crcInput), false)
  return chunk
}
function makeIhdr(width: number, height: number, bitDepth: number, colorType: number, interlaceMethod = 0): Uint8Array {
  const data = new Uint8Array(13)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  view.setUint32(0, width, false)
  view.setUint32(4, height, false)
  view.setUint8(8, bitDepth)
  view.setUint8(9, colorType)
  view.setUint8(10, 0)
  view.setUint8(11, 0)
  view.setUint8(12, interlaceMethod)
  return makeChunk('IHDR', data)
}
function makeIdat(scanlines: Uint8Array): Uint8Array {
  return makeChunk('IDAT', deflateSync(scanlines))
}
const iendChunk = makeChunk('IEND', new Uint8Array(0))
function assemblePng(chunks: Array<Uint8Array>): Uint8Array {
  const png = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, pngSignature.length))
  let offset = 0
  png.set(pngSignature, offset)
  offset += pngSignature.length
  for (const chunk of chunks) {
    png.set(chunk, offset)
    offset += chunk.length
  }
  return png
}
function rawScanlines(width: number, height: number, bytesPerPixel: number, fill: (x: number, y: number) => Array<number>): Uint8Array {
  const scanlineLength = 1 + width * bytesPerPixel
  const scanlines = new Uint8Array(scanlineLength * height)
  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength
    scanlines[rowOffset] = 0
    for (let x = 0; x < width; x++) {
      const pixel = fill(x, y)
      for (let byteIndex = 0; byteIndex < bytesPerPixel; byteIndex++) {
        scanlines[rowOffset + 1 + x * bytesPerPixel + byteIndex] = pixel[byteIndex] ?? 0
      }
    }
  }
  return scanlines
}
function packSubByteSamples(samples: Array<number>, bitDepth: 1 | 2 | 4): Uint8Array {
  const bitsPerByte = 8
  const packed = new Uint8Array(Math.ceil(samples.length * bitDepth / bitsPerByte))
  const mask = (1 << bitDepth) - 1
  for (const [index, sample] of samples.entries()) {
    const bitOffset = index * bitDepth
    const byteIndex = Math.floor(bitOffset / bitsPerByte)
    const shift = bitsPerByte - bitDepth - bitOffset % bitsPerByte
    packed[byteIndex] |= (sample & mask) << shift
  }
  return packed
}
function paethPredictor(left: number, up: number, upLeft: number): number {
  const prediction = left + up - upLeft
  const leftDistance = Math.abs(prediction - left)
  const upDistance = Math.abs(prediction - up)
  const upLeftDistance = Math.abs(prediction - upLeft)
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left
  }
  if (upDistance <= upLeftDistance) {
    return up
  }
  return upLeft
}
function encodeFilterRow(rawRow: Uint8Array, previousRow: Uint8Array, filterType: number, bytesPerPixel: number): Uint8Array {
  const encoded = new Uint8Array(rawRow.length)
  switch (filterType) {
    case 0: {
      encoded.set(rawRow)
      return encoded
    }
    case 1: {
      for (const [index, rawByte] of rawRow.entries()) {
        const left = index >= bytesPerPixel ? rawRow[index - bytesPerPixel] : 0
        encoded[index] = rawByte - left + 256 & 0xFF
      }
      return encoded
    }
    case 2: {
      for (const [index, rawByte] of rawRow.entries()) {
        encoded[index] = rawByte - previousRow[index] + 256 & 0xFF
      }
      return encoded
    }
    case 3: {
      for (const [index, rawByte] of rawRow.entries()) {
        const left = index >= bytesPerPixel ? rawRow[index - bytesPerPixel] : 0
        const up = previousRow[index]
        encoded[index] = rawByte - Math.floor((left + up) / 2) + 256 & 0xFF
      }
      return encoded
    }
    case 4: {
      for (const [index, rawByte] of rawRow.entries()) {
        const left = index >= bytesPerPixel ? rawRow[index - bytesPerPixel] : 0
        const up = previousRow[index]
        const upLeft = index >= bytesPerPixel ? previousRow[index - bytesPerPixel] : 0
        encoded[index] = rawByte - paethPredictor(left, up, upLeft) + 256 & 0xFF
      }
      return encoded
    }
    default: {
      throw new TypeError(`Unknown filter type: ${filterType}`)
    }
  }
}
function encodeFilteredScanlines(rows: Array<Uint8Array>, filterTypes: Array<number>, bytesPerPixel: number): Uint8Array {
  const scanlineLength = 1 + rows[0].length
  const scanlines = new Uint8Array(scanlineLength * rows.length)
  let previousRow: Uint8Array = new Uint8Array(rows[0].length)
  for (const [rowIndex, row] of rows.entries()) {
    const rawRow = row
    const filterType = filterTypes[rowIndex]
    const rowOffset = rowIndex * scanlineLength
    scanlines[rowOffset] = filterType
    scanlines.set(encodeFilterRow(rawRow, previousRow, filterType, bytesPerPixel), rowOffset + 1)
    previousRow = rawRow
  }
  return scanlines
}
describe('countPixels', () => {
  describe('no predicate', () => {
    test('returns the total pixel count', () => {
      const raw = rawScanlines(10, 10, 3, () => [128, 128, 128])
      const png = assemblePng([
        makeIhdr(10, 10, 8, 2),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png)).toBe(100)
    })
    test('works for all main color types', () => {
      const cases: Array<[colorType: number, bytesPerPixel: number, fill: (x: number, y: number) => Array<number>]> = [
        [0, 1, () => [128]],
        [2, 3, () => [1, 2, 3]],
        [6, 4, () => [1, 2, 3, 255]],
      ]
      for (const [colorType, bytesPerPixel, fill] of cases) {
        const raw = rawScanlines(4, 4, bytesPerPixel, fill)
        const png = assemblePng([
          makeIhdr(4, 4, 8, colorType),
          makeIdat(raw),
          iendChunk,
        ])
        expect(countPixels(png)).toBe(16)
      }
    })
  })
  describe('hex predicates', () => {
    test('count matching RGB pixels', () => {
      const raw = rawScanlines(2, 2, 3, (x, y) => {
        const colors = [
          [255, 0, 0],
          [0, 255, 0],
          [0, 0, 255],
          [255, 255, 255],
        ]
        return colors[y * 2 + x] ?? [0, 0, 0]
      })
      const png = assemblePng([
        makeIhdr(2, 2, 8, 2),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, 'ff0000')).toBe(1)
      expect(countPixels(png, '00ff00')).toBe(1)
      expect(countPixels(png, '0000ff')).toBe(1)
      expect(countPixels(png, 'ffffff')).toBe(1)
      expect(countPixels(png, '000000')).toBe(0)
    })
    test('RGB predicates ignore opacity', () => {
      const raw = rawScanlines(2, 1, 4, x => {
        return x === 0 ? [255, 0, 0, 255] : [255, 0, 0, 32]
      })
      const png = assemblePng([
        makeIhdr(2, 1, 8, 6),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, 'ff0000')).toBe(2)
      expect(countPixels(png, 'ff0000ff')).toBe(1)
      expect(countPixels(png, 'ff000020')).toBe(1)
    })
    test('supports shorthand hex and an optional leading #', () => {
      const raw = rawScanlines(2, 1, 4, x => {
        return x === 0 ? [255, 0, 170, 255] : [255, 0, 170, 170]
      })
      const png = assemblePng([
        makeIhdr(2, 1, 8, 6),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, '#f0a')).toBe(2)
      expect(countPixels(png, '#f0af')).toBe(1)
      expect(countPixels(png, 'f0aa')).toBe(1)
    })
    test('treats images without alpha as fully opaque for RGBA predicates', () => {
      const raw = rawScanlines(1, 1, 3, () => [0, 0, 0])
      const png = assemblePng([
        makeIhdr(1, 1, 8, 2),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, '000000ff')).toBe(1)
      expect(countPixels(png, '00000000')).toBe(0)
    })
    test('throws on invalid hex predicates', () => {
      const raw = rawScanlines(1, 1, 3, () => [0, 0, 0])
      const png = assemblePng([
        makeIhdr(1, 1, 8, 2),
        makeIdat(raw),
        iendChunk,
      ])
      expect(() => countPixels(png, 'nope')).toThrow('Invalid hex predicate')
    })
  })
  describe('function predicates', () => {
    test('receive the correct pixel coordinates and values', () => {
      const raw = rawScanlines(2, 2, 4, (x, y) => {
        const values = [
          [10, 20, 30, 255],
          [40, 50, 60, 200],
          [70, 80, 90, 100],
          [100, 110, 120, 50],
        ]
        return values[y * 2 + x] ?? [0, 0, 0, 0]
      })
      const png = assemblePng([
        makeIhdr(2, 2, 8, 6),
        makeIdat(raw),
        iendChunk,
      ])
      const visited: Array<Pixel> = []
      countPixels(png, pixel => {
        visited.push(pixel)
        return false
      })
      expect(visited).toEqual([
        {
          x: 0,
          y: 0,
          red: 10,
          green: 20,
          blue: 30,
          opacity: 255,
        },
        {
          x: 1,
          y: 0,
          red: 40,
          green: 50,
          blue: 60,
          opacity: 200,
        },
        {
          x: 0,
          y: 1,
          red: 70,
          green: 80,
          blue: 90,
          opacity: 100,
        },
        {
          x: 1,
          y: 1,
          red: 100,
          green: 110,
          blue: 120,
          opacity: 50,
        },
      ])
    })
    test('receive linear indices', () => {
      const raw = rawScanlines(2, 2, 3, () => [0, 0, 0])
      const png = assemblePng([
        makeIhdr(2, 2, 8, 2),
        makeIdat(raw),
        iendChunk,
      ])
      const indices: Array<number> = []
      countPixels(png, (_pixel, index) => {
        indices.push(index)
        return false
      })
      expect(indices).toEqual([0, 1, 2, 3])
    })
    test('omit opacity when the PNG has no alpha or tRNS transparency', () => {
      const raw = rawScanlines(1, 1, 3, () => [1, 2, 3])
      const png = assemblePng([
        makeIhdr(1, 1, 8, 2),
        makeIdat(raw),
        iendChunk,
      ])
      let seenPixel: Pixel | undefined
      countPixels(png, pixel => {
        seenPixel = pixel
        return false
      })
      expect(seenPixel).toEqual({
        x: 0,
        y: 0,
        red: 1,
        green: 2,
        blue: 3,
      })
    })
  })
  describe('grayscale PNGs', () => {
    test('work at 8-bit depth', () => {
      const raw = rawScanlines(2, 2, 1, (x, y) => {
        const values = [0, 85, 170, 255]
        return [values[y * 2 + x] ?? 0]
      })
      const png = assemblePng([
        makeIhdr(2, 2, 8, 0),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, '000000')).toBe(1)
      expect(countPixels(png, '555555')).toBe(1)
      expect(countPixels(png, 'aaaaaa')).toBe(1)
      expect(countPixels(png, 'ffffff')).toBe(1)
    })
    test('work at 1-bit depth', () => {
      const raw = new Uint8Array([
        0,
        ...packSubByteSamples([0, 0, 0, 0, 1, 1, 1, 1], 1),
      ])
      const png = assemblePng([
        makeIhdr(8, 1, 1, 0),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, '000000')).toBe(4)
      expect(countPixels(png, 'ffffff')).toBe(4)
    })
    test('apply tRNS transparency at sub-byte bit depths', () => {
      const raw = new Uint8Array([
        0,
        ...packSubByteSamples([0, 1], 1),
      ])
      const png = assemblePng([
        makeIhdr(2, 1, 1, 0),
        makeChunk('tRNS', new Uint8Array([0, 1])),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, '000000ff')).toBe(1)
      expect(countPixels(png, 'ffffff00')).toBe(1)
    })
  })
  describe('palette PNGs', () => {
    test('work at 8-bit depth', () => {
      const palette = new Uint8Array([
        255,
        0,
        0,
        0,
        255,
        0,
        0,
        0,
        255,
        255,
        255,
        255,
      ])
      const raw = rawScanlines(2, 2, 1, (x, y) => [y * 2 + x])
      const png = assemblePng([
        makeIhdr(2, 2, 8, 3),
        makeChunk('PLTE', palette),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, 'ff0000')).toBe(1)
      expect(countPixels(png, '00ff00')).toBe(1)
      expect(countPixels(png, '0000ff')).toBe(1)
      expect(countPixels(png, 'ffffff')).toBe(1)
    })
    test('work at 1-bit depth', () => {
      const palette = new Uint8Array([
        255,
        0,
        0,
        0,
        255,
        0,
      ])
      const raw = new Uint8Array([
        0,
        ...packSubByteSamples([0, 1], 1),
      ])
      const png = assemblePng([
        makeIhdr(2, 1, 1, 3),
        makeChunk('PLTE', palette),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, 'ff0000')).toBe(1)
      expect(countPixels(png, '00ff00')).toBe(1)
    })
    test('apply palette transparency from tRNS', () => {
      const palette = new Uint8Array([255, 0, 0, 0, 255, 0])
      const trns = new Uint8Array([0, 255])
      const raw = rawScanlines(2, 1, 1, x => [x])
      const png = assemblePng([
        makeIhdr(2, 1, 8, 3),
        makeChunk('PLTE', palette),
        makeChunk('tRNS', trns),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, 'ff0000')).toBe(1)
      expect(countPixels(png, 'ff0000ff')).toBe(0)
      expect(countPixels(png, 'ff000000')).toBe(1)
      expect(countPixels(png, '00ff00ff')).toBe(1)
    })
  })
  describe('filters', () => {
    test('reverse all PNG filter types correctly for multi-byte pixels', () => {
      const rows = [
        Uint8Array.from([10, 20, 30, 40, 50, 60]),
        Uint8Array.from([11, 21, 31, 41, 51, 61]),
        Uint8Array.from([12, 22, 32, 42, 52, 62]),
        Uint8Array.from([13, 23, 33, 43, 53, 63]),
        Uint8Array.from([14, 24, 34, 44, 54, 64]),
      ]
      const scanlines = encodeFilteredScanlines(rows, [0, 1, 2, 3, 4], 3)
      const png = assemblePng([
        makeIhdr(2, 5, 8, 2),
        makeIdat(scanlines),
        iendChunk,
      ])
      const visited: Array<Pixel> = []
      countPixels(png, pixel => {
        visited.push(pixel)
        return false
      })
      expect(visited).toEqual([
        {
          x: 0,
          y: 0,
          red: 10,
          green: 20,
          blue: 30,
        },
        {
          x: 1,
          y: 0,
          red: 40,
          green: 50,
          blue: 60,
        },
        {
          x: 0,
          y: 1,
          red: 11,
          green: 21,
          blue: 31,
        },
        {
          x: 1,
          y: 1,
          red: 41,
          green: 51,
          blue: 61,
        },
        {
          x: 0,
          y: 2,
          red: 12,
          green: 22,
          blue: 32,
        },
        {
          x: 1,
          y: 2,
          red: 42,
          green: 52,
          blue: 62,
        },
        {
          x: 0,
          y: 3,
          red: 13,
          green: 23,
          blue: 33,
        },
        {
          x: 1,
          y: 3,
          red: 43,
          green: 53,
          blue: 63,
        },
        {
          x: 0,
          y: 4,
          red: 14,
          green: 24,
          blue: 34,
        },
        {
          x: 1,
          y: 4,
          red: 44,
          green: 54,
          blue: 64,
        },
      ])
    })
  })
  describe('16-bit PNGs', () => {
    test('normalize 16-bit RGBA samples to 8-bit values', () => {
      const raw = new Uint8Array([
        0,
        0x12,
        0x12,
        0x34,
        0x34,
        0xFF,
        0xFF,
        0x80,
        0x80,
      ])
      const png = assemblePng([
        makeIhdr(1, 1, 16, 6),
        makeIdat(raw),
        iendChunk,
      ])
      expect(countPixels(png, '1234ff')).toBe(1)
      expect(countPixels(png, '1234ff80')).toBe(1)
      expect(countPixels(png, pixel => pixel.opacity === 128)).toBe(1)
    })
  })
  describe('Adam7 interlacing', () => {
    test('decode interlaced RGB images', () => {
      const interlacedRaw = new Uint8Array([
        0,
        255,
        0,
        0,
        0,
        0,
        255,
        0,
        0,
        0,
        0,
        255,
        255,
        255,
        255,
      ])
      const png = assemblePng([
        makeIhdr(2, 2, 8, 2, 1),
        makeIdat(interlacedRaw),
        iendChunk,
      ])
      expect(countPixels(png)).toBe(4)
      expect(countPixels(png, 'ff0000')).toBe(1)
      expect(countPixels(png, '00ff00')).toBe(1)
      expect(countPixels(png, '0000ff')).toBe(1)
      expect(countPixels(png, 'ffffff')).toBe(1)
    })
  })
  describe('invalid input', () => {
    test('throws on empty input', () => {
      expect(() => countPixels(new Uint8Array(0))).toThrow('Not a PNG file')
    })
    test('throws on non-PNG data', () => {
      expect(() => countPixels(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow('Not a PNG file')
    })
    test('throws on truncated PNG data', () => {
      expect(() => countPixels(Uint8Array.from(pngSignature))).toThrow()
    })
  })
})
