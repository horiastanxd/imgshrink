# imgshrink

Compress JPEG, PNG, WebP and AVIF images in your browser. Nothing is uploaded. No account, no limits, no ads.

Try it: <https://horiastanxd.github.io/imgshrink/>

## What it does

Drop images, get smaller files. Every step runs locally:

1. Image is decoded with `createImageBitmap`, which respects EXIF orientation.
2. It is drawn to a canvas, optionally resized to fit a maximum width or height.
3. The canvas is re-encoded with `canvas.toBlob` using the format and quality you pick.
4. You download the result, either one by one or all at once as a ZIP.

No network request is made with your files. Open DevTools, watch the Network tab, compress an image, and you will see nothing.

## Features

- JPEG, PNG, WebP, and AVIF (where the browser supports it) output
- Keep-original mode that re-encodes each file in its own format
- Quality slider with sensible per-format defaults
- Optional resize to a max width or height (preserves aspect ratio)
- Side-by-side before/after slider to inspect compression artifacts
- Batch processing with a ZIP download
- Paste images from the clipboard
- Works offline after the first load

## Running locally

Four static files, no build step. Open `index.html`, or serve the folder:

```bash
python3 -m http.server
```

## Browser support

Tested on recent Chrome, Firefox and Safari. AVIF encoding is Chromium-only at the time of writing and is automatically disabled on browsers that can't produce it.

## License

MIT
