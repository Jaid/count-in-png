# count-in-png

Count pixels in a PNG image using either a hex color predicate or a custom function.

## Install

```sh
bun add count-in-png
```

## Usage

```ts
import countPixels from 'count-in-png'

const image = await Bun.file('screenshot.png').bytes()
```

### Total pixel count

```ts
const total = countPixels(image)
// → width × height
```

### Hex color predicate

```ts
// Count black pixels regardless of opacity.
const technicalCount = countPixels(image, '000000')

// Count fully opaque black pixels only.
const humanCount = countPixels(image, '000000ff')

// Shorthand and leading # are supported too.
const accentCount = countPixels(image, '#f0a')
```

Hex predicates use CSS-style RGB or RGBA notation: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. RGB predicates ignore opacity. RGBA predicates treat PNGs without alpha or `tRNS` transparency as fully opaque (`opacity = 255`). Invalid hex predicates throw a `TypeError`.

### Function predicate

```ts
const count = countPixels(image, (pixel, index) => {
	// pixel.x, pixel.y, pixel.red, pixel.green, pixel.blue, pixel.opacity?
	const isEveryOtherPixel = index % 2 === 0
	const isVisible = (pixel.opacity ?? 255) > 0
	const isPink = pixel.red > 200 && pixel.blue > 150
	return isEveryOtherPixel && isVisible && isPink
})
```

For 16-bit PNGs, channel values are normalized to 8-bit before they are exposed to predicates.

## Supported PNG features

| Feature | Supported |
|---|---|
| All color types (0, 2, 3, 4, 6) | ✓ |
| Bit depths 1, 2, 4, 8, 16 | ✓ |
| Adam7 interlacing | ✓ |
| Palette (`PLTE`) | ✓ |
| Transparency (`tRNS`) | ✓ |
| All filter types (None, Sub, Up, Average, Paeth) | ✓ |

## API

```ts
function countPixels(image: Uint8Array, predicate?: Predicate): number

type Predicate = string | ((pixel: Pixel, index: number) => boolean)

type Pixel = {
	readonly x: number
	readonly y: number
	readonly red: number
	readonly green: number
	readonly blue: number
	readonly opacity?: number
}
```

`opacity` is omitted when the PNG has neither an alpha channel nor `tRNS` transparency.

## License

MIT
