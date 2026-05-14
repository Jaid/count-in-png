import type {PngImage} from '#src/lib/types/types.ts'

import {inflateSync} from 'node:zlib'

const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const adam7Passes: Array<[xStart: number, yStart: number, xStep: number, yStep: number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]
const supportedBitDepths: Partial<Record<number, ReadonlyArray<number>>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}
const channelsByColorType: Record<number, number> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
}

type Chunk = {
  readonly data: Uint8Array
  readonly type: string
}

type PngHeader = {
  readonly bitDepth: number
  readonly colorType: number
  readonly height: number
  readonly interlaceMethod: number
  readonly width: number
}

type Transparency = {
  readonly blue?: number
  readonly gray?: number
  readonly green?: number
  readonly red?: number
}

type DecodedPixel = {
  readonly blue: number
  readonly green: number
  readonly opacity: number
  readonly red: number
}

type PngDecodeContext = PngHeader & {
  readonly bitsPerPixel: number
  readonly channels: number
  readonly filterBytesPerPixel: number
  readonly palette?: Array<[number, number, number]>
  readonly paletteAlpha?: Map<number, number>
  readonly transparency?: Transparency
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
function normalizeSampleTo8Bit(sample: number, bitDepth: number): number {
  switch (bitDepth) {
    case 1: {
      return sample * 255
    }
    case 2: {
      return sample * 85
    }
    case 4: {
      return sample * 17
    }
    case 8: {
      return sample
    }
    case 16: {
      return Math.round(sample / 257)
    }
    default: {
      throw new TypeError(`Unsupported sample bit depth: ${bitDepth}`)
    }
  }
}
function readSampleAt(row: Uint8Array, x: number, bitDepth: number, samplesPerPixel: number, sampleIndex: number): number {
  if (bitDepth === 16) {
    const byteOffset = x * samplesPerPixel * 2 + sampleIndex * 2
    return row[byteOffset] << 8 | row[byteOffset + 1]
  }
  if (bitDepth === 8) {
    return row[x * samplesPerPixel + sampleIndex]
  }
  const bitOffset = x * samplesPerPixel * bitDepth + sampleIndex * bitDepth
  const byteOffset = Math.floor(bitOffset / 8)
  const shift = 8 - bitDepth - bitOffset % 8
  const mask = (1 << bitDepth) - 1
  return row[byteOffset] >> shift & mask
}
function writePixel(output: Uint8Array, offset: number, pixel: DecodedPixel): void {
  output[offset] = pixel.red
  output[offset + 1] = pixel.green
  output[offset + 2] = pixel.blue
  output[offset + 3] = pixel.opacity
}
function decodePixelAt(row: Uint8Array, x: number, context: PngDecodeContext): DecodedPixel {
  if (context.colorType === 0) {
    const graySample = readSampleAt(row, x, context.bitDepth, 1, 0)
    const gray = normalizeSampleTo8Bit(graySample, context.bitDepth)
    return {
      red: gray,
      green: gray,
      blue: gray,
      opacity: context.transparency?.gray === graySample ? 0 : 255,
    }
  }
  if (context.colorType === 2) {
    const redSample = readSampleAt(row, x, context.bitDepth, context.channels, 0)
    const greenSample = readSampleAt(row, x, context.bitDepth, context.channels, 1)
    const blueSample = readSampleAt(row, x, context.bitDepth, context.channels, 2)
    return {
      red: normalizeSampleTo8Bit(redSample, context.bitDepth),
      green: normalizeSampleTo8Bit(greenSample, context.bitDepth),
      blue: normalizeSampleTo8Bit(blueSample, context.bitDepth),
      opacity: context.transparency?.red === redSample
        && context.transparency.green === greenSample
        && context.transparency.blue === blueSample ? 0 : 255,
    }
  }
  if (context.colorType === 3) {
    const paletteIndex = readSampleAt(row, x, context.bitDepth, 1, 0)
    const paletteEntry = context.palette?.[paletteIndex]
    if (!paletteEntry) {
      throw new TypeError(`Palette index ${paletteIndex} is out of range`)
    }
    return {
      red: paletteEntry[0],
      green: paletteEntry[1],
      blue: paletteEntry[2],
      opacity: context.paletteAlpha?.get(paletteIndex) ?? 255,
    }
  }
  if (context.colorType === 4) {
    const graySample = readSampleAt(row, x, context.bitDepth, context.channels, 0)
    const alphaSample = readSampleAt(row, x, context.bitDepth, context.channels, 1)
    const gray = normalizeSampleTo8Bit(graySample, context.bitDepth)
    return {
      red: gray,
      green: gray,
      blue: gray,
      opacity: normalizeSampleTo8Bit(alphaSample, context.bitDepth),
    }
  }
  if (context.colorType === 6) {
    return {
      red: normalizeSampleTo8Bit(readSampleAt(row, x, context.bitDepth, context.channels, 0), context.bitDepth),
      green: normalizeSampleTo8Bit(readSampleAt(row, x, context.bitDepth, context.channels, 1), context.bitDepth),
      blue: normalizeSampleTo8Bit(readSampleAt(row, x, context.bitDepth, context.channels, 2), context.bitDepth),
      opacity: normalizeSampleTo8Bit(readSampleAt(row, x, context.bitDepth, context.channels, 3), context.bitDepth),
    }
  }
  throw new TypeError(`Unsupported PNG color type: ${context.colorType}`)
}
function decodeRowIntoOutput(row: Uint8Array, output: Uint8Array, y: number, width: number, context: PngDecodeContext): void {
  const rowOffset = y * width * 4
  for (let x = 0; x < width; x++) {
    const pixel = decodePixelAt(row, x, context)
    writePixel(output, rowOffset + x * 4, pixel)
  }
}
function reverseFilter(currentRow: Uint8Array, previousRow: Uint8Array, filterType: number, filterBytesPerPixel: number): void {
  switch (filterType) {
    case 0: {
      return
    }
    case 1: {
      for (let index = filterBytesPerPixel; index < currentRow.length; index++) {
        currentRow[index] = currentRow[index] + currentRow[index - filterBytesPerPixel] & 0xFF
      }
      return
    }
    case 2: {
      for (let index = 0; index < currentRow.length; index++) {
        currentRow[index] = currentRow[index] + previousRow[index] & 0xFF
      }
      return
    }
    case 3: {
      for (let index = 0; index < currentRow.length; index++) {
        const left = index >= filterBytesPerPixel ? currentRow[index - filterBytesPerPixel] : 0
        const up = previousRow[index]
        currentRow[index] = currentRow[index] + Math.floor((left + up) / 2) & 0xFF
      }
      return
    }
    case 4: {
      for (let index = 0; index < currentRow.length; index++) {
        const left = index >= filterBytesPerPixel ? currentRow[index - filterBytesPerPixel] : 0
        const up = previousRow[index]
        const upLeft = index >= filterBytesPerPixel ? previousRow[index - filterBytesPerPixel] : 0
        currentRow[index] = currentRow[index] + paethPredictor(left, up, upLeft) & 0xFF
      }
      return
    }
    default: {
      throw new TypeError(`Unknown PNG filter type: ${filterType}`)
    }
  }
}
function getPassExtent(passIndex: number, width: number, height: number): [number, number] {
  const [xStart, yStart, xStep, yStep] = adam7Passes[passIndex]
  return [
    xStart < width ? Math.ceil((width - xStart) / xStep) : 0,
    yStart < height ? Math.ceil((height - yStart) / yStep) : 0,
  ]
}
function decodeScanlines(decompressed: Uint8Array, context: PngDecodeContext): Uint8Array {
  const rowByteLength = Math.ceil(context.bitsPerPixel * context.width / 8)
  const scanlineByteLength = 1 + rowByteLength
  const output = new Uint8Array(context.width * context.height * 4)
  const previousRow = new Uint8Array(rowByteLength)
  const currentRow = new Uint8Array(rowByteLength)
  for (let y = 0; y < context.height; y++) {
    const rowOffset = y * scanlineByteLength
    if (rowOffset + scanlineByteLength > decompressed.length) {
      throw new TypeError('Unexpected end of decompressed PNG data')
    }
    const filterType = decompressed[rowOffset]
    currentRow.set(decompressed.subarray(rowOffset + 1, rowOffset + 1 + rowByteLength))
    reverseFilter(currentRow, previousRow, filterType, context.filterBytesPerPixel)
    decodeRowIntoOutput(currentRow, output, y, context.width, context)
    previousRow.set(currentRow)
  }
  return output
}
function decodeAdam7(decompressed: Uint8Array, context: PngDecodeContext): Uint8Array {
  const output = new Uint8Array(context.width * context.height * 4)
  let offset = 0
  for (const [passIndex, adam7Pass] of adam7Passes.entries()) {
    const [passWidth, passHeight] = getPassExtent(passIndex, context.width, context.height)
    if (passWidth === 0 || passHeight === 0) {
      continue
    }
    const rowByteLength = Math.ceil(context.bitsPerPixel * passWidth / 8)
    const scanlineByteLength = 1 + rowByteLength
    const previousRow = new Uint8Array(rowByteLength)
    const currentRow = new Uint8Array(rowByteLength)
    const [xStart, yStart, xStep, yStep] = adam7Pass
    for (let passY = 0; passY < passHeight; passY++) {
      if (offset + scanlineByteLength > decompressed.length) {
        throw new TypeError('Unexpected end of Adam7 PNG data')
      }
      const filterType = decompressed[offset]
      currentRow.set(decompressed.subarray(offset + 1, offset + 1 + rowByteLength))
      reverseFilter(currentRow, previousRow, filterType, context.filterBytesPerPixel)
      previousRow.set(currentRow)
      const imageY = yStart + passY * yStep
      for (let passX = 0; passX < passWidth; passX++) {
        const imageX = xStart + passX * xStep
        const pixel = decodePixelAt(currentRow, passX, context)
        writePixel(output, (imageY * context.width + imageX) * 4, pixel)
      }
      offset += scanlineByteLength
    }
  }
  return output
}
function collectIdatData(chunks: Array<Chunk>): Uint8Array {
  const idatChunks = chunks.filter(chunk => chunk.type === 'IDAT')
  if (idatChunks.length === 0) {
    throw new TypeError('Missing IDAT chunk')
  }
  const compressed = new Uint8Array(idatChunks.reduce((length, chunk) => length + chunk.data.length, 0))
  let offset = 0
  for (const chunk of idatChunks) {
    compressed.set(chunk.data, offset)
    offset += chunk.data.length
  }
  return compressed
}
function parseTransparency(trns: Chunk | undefined,
  colorType: number,
  palette: Array<[number, number, number]> | undefined): {paletteAlpha?: Map<number, number>
  transparency?: Transparency} {
  if (!trns) {
    return {}
  }
  if (colorType === 0) {
    if (trns.data.length < 2) {
      throw new TypeError('Invalid tRNS chunk length for grayscale PNG')
    }
    return {
      transparency: {
        gray: trns.data[0] << 8 | trns.data[1],
      },
    }
  }
  if (colorType === 2) {
    if (trns.data.length < 6) {
      throw new TypeError('Invalid tRNS chunk length for RGB PNG')
    }
    return {
      transparency: {
        red: trns.data[0] << 8 | trns.data[1],
        green: trns.data[2] << 8 | trns.data[3],
        blue: trns.data[4] << 8 | trns.data[5],
      },
    }
  }
  if (colorType === 3) {
    if (!palette) {
      throw new TypeError('tRNS palette transparency requires a PLTE chunk')
    }
    if (trns.data.length > palette.length) {
      throw new TypeError('tRNS contains more palette alpha entries than the palette contains colors')
    }
    if (trns.data.length === 0) {
      return {}
    }
    const paletteAlpha = new Map<number, number>
    for (let index = 0; index < trns.data.length; index++) {
      paletteAlpha.set(index, trns.data[index])
    }
    return {paletteAlpha}
  }
  if (colorType === 4 || colorType === 6) {
    throw new TypeError(`tRNS is not valid for PNG color type ${colorType}`)
  }
  return {}
}
function parsePalette(plte: Chunk | undefined, header: PngHeader): Array<[number, number, number]> | undefined {
  if (!plte) {
    if (header.colorType === 3) {
      throw new TypeError('Missing PLTE chunk')
    }
    return undefined
  }
  if (plte.data.length === 0 || plte.data.length % 3 !== 0) {
    throw new TypeError('Invalid PLTE chunk length')
  }
  const paletteEntryCount = plte.data.length / 3
  if (paletteEntryCount > 2 ** header.bitDepth) {
    throw new TypeError('PLTE contains more entries than the PNG bit depth allows')
  }
  const palette: Array<[number, number, number]> = []
  for (let offset = 0; offset < plte.data.length; offset += 3) {
    palette.push([plte.data[offset], plte.data[offset + 1], plte.data[offset + 2]])
  }
  return palette
}
function parseHeader(ihdr: Chunk): PngHeader {
  if (ihdr.data.length !== 13) {
    throw new TypeError('Invalid IHDR chunk length')
  }
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength)
  const width = view.getUint32(0, false)
  const height = view.getUint32(4, false)
  const bitDepth = view.getUint8(8)
  const colorType = view.getUint8(9)
  const compressionMethod = view.getUint8(10)
  const filterMethod = view.getUint8(11)
  const interlaceMethod = view.getUint8(12)
  if (width === 0 || height === 0) {
    throw new TypeError('PNG width and height must be greater than 0')
  }
  if (compressionMethod !== 0) {
    throw new TypeError(`Unsupported compression method: ${compressionMethod}`)
  }
  if (filterMethod !== 0) {
    throw new TypeError(`Unsupported filter method: ${filterMethod}`)
  }
  if (interlaceMethod !== 0 && interlaceMethod !== 1) {
    throw new TypeError(`Unsupported interlace method: ${interlaceMethod}`)
  }
  const allowedBitDepths = supportedBitDepths[colorType]
  if (!allowedBitDepths?.includes(bitDepth)) {
    throw new TypeError(`Unsupported bit depth ${bitDepth} for color type ${colorType}`)
  }
  return {
    width,
    height,
    bitDepth,
    colorType,
    interlaceMethod,
  }
}
function processChunks(chunks: Array<Chunk>): PngImage {
  const ihdr = chunks.find(chunk => chunk.type === 'IHDR')
  if (!ihdr) {
    throw new TypeError('Missing IHDR chunk')
  }
  const header = parseHeader(ihdr)
  const palette = parsePalette(chunks.find(chunk => chunk.type === 'PLTE'), header)
  const {paletteAlpha, transparency} = parseTransparency(chunks.find(chunk => chunk.type === 'tRNS'), header.colorType, palette)
  const compressed = collectIdatData(chunks)
  let decompressed: Uint8Array
  try {
    decompressed = inflateSync(compressed)
  } catch {
    throw new TypeError('Failed to decompress PNG image data')
  }
  const channels = channelsByColorType[header.colorType]
  if (!channels) {
    throw new TypeError(`Unsupported PNG color type: ${header.colorType}`)
  }
  const context: PngDecodeContext = {
    ...header,
    channels,
    bitsPerPixel: channels * header.bitDepth,
    filterBytesPerPixel: Math.max(1, Math.ceil(channels * header.bitDepth / 8)),
    palette,
    paletteAlpha,
    transparency,
  }
  const data = header.interlaceMethod === 1 ? decodeAdam7(decompressed, context) : decodeScanlines(decompressed, context)
  return {
    data,
    width: header.width,
    height: header.height,
    bytesPerPixel: 4,
    hasAlpha: header.colorType === 4 || header.colorType === 6 || paletteAlpha !== undefined || transparency !== undefined,
  }
}
function parseChunks(raw: Uint8Array): Array<Chunk> {
  const chunks: Array<Chunk> = []
  let offset = pngSignature.length
  while (offset < raw.length) {
    if (offset + 12 > raw.length) {
      throw new TypeError('Unexpected end of PNG data')
    }
    const headerView = new DataView(raw.buffer, raw.byteOffset + offset, 8)
    const dataLength = headerView.getUint32(0, false)
    const typeBytes = raw.subarray(offset + 4, offset + 8)
    const type = String.fromCodePoint(...typeBytes)
    offset += 8
    if (offset + dataLength + 4 > raw.length) {
      throw new TypeError(`Unexpected end of PNG data in chunk ${type}`)
    }
    const data = raw.subarray(offset, offset + dataLength)
    offset += dataLength + 4
    chunks.push({
      type,
      data,
    })
    if (type === 'IEND') {
      break
    }
  }
  return chunks
}
const parsePng = (raw: Uint8Array): PngImage => {
  if (raw.length < pngSignature.length) {
    throw new TypeError('Not a PNG file (too short)')
  }
  for (const [index, signatureByte] of pngSignature.entries()) {
    if (raw[index] !== signatureByte) {
      throw new TypeError('Not a PNG file (bad signature)')
    }
  }
  const chunks = parseChunks(raw)
  if (chunks.at(-1)?.type !== 'IEND') {
    throw new TypeError('Missing IEND chunk')
  }
  return processChunks(chunks)
}

export {parsePng}
