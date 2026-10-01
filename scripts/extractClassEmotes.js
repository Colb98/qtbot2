// Deterministic extraction: preserve the original black artwork and its alpha.
// The grey-blue outer ring is a separate color in this atlas. Low-alpha black
// quantization noise is discarded only when disconnected from opaque artwork.
// Run: node scripts/extractClassEmotes.js [source.png]
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { CLASS_SHORT, CLASS_COLOR } = require('../src/constants');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_URL = 'https://h.res.netease.com/pc/zt/20230614153517/assets/sprite-c81cc3_c81cc3a5.png';
const SOURCE_PATH = path.join(ROOT, 'emotes/sources/netease-sects.png');
const ICONS = [
    { code: 'HA', name: 'Hồng Âm', tile: [0, 0, 80, 74], components: 1,
        art: 'https://h.res.netease.com/pc/gw/20231012200834/assets/hongyin-kv_7ee9bc56.png' },
    { code: 'HC', name: 'Huyền Cơ', tile: [320, 74, 80, 74], components: 1,
        art: 'https://h.res.netease.com/pc/gw/20231012200834/assets/xuanji-kv_deae5ead.png' },
    { code: 'TL', name: 'Thương Lan', tile: [320, 222, 80, 74], components: 2,
        art: 'https://h.res.netease.com/pc/gw/20231012200834/assets/canglan-kv_c86fb336.png' }
];

function extractIcon(context, icon) {
    const [sx, sy, width, height] = icon.tile;
    const pixels = context.getImageData(sx, sy, width, height).data;
    const black = p => pixels[p * 4 + 3] > 0 &&
        pixels[p * 4] === 0 && pixels[p * 4 + 1] === 0 && pixels[p * 4 + 2] === 0;
    const seen = new Set();
    const kept = [];
    let componentCount = 0;
    for (let seed = 0; seed < width * height; seed++) {
        if (seen.has(seed) || !black(seed)) continue;
        const stack = [seed], component = [];
        let peakAlpha = 0;
        seen.add(seed);
        while (stack.length) {
            const p = stack.pop(), x = p % width, y = Math.floor(p / width);
            component.push(p);
            peakAlpha = Math.max(peakAlpha, pixels[p * 4 + 3]);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy, q = ny * width + nx;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height || seen.has(q) || !black(q)) continue;
                seen.add(q);
                stack.push(q);
            }
        }
        if (peakAlpha >= 128) { kept.push(...component); componentCount++; }
    }
    if (componentCount !== icon.components) throw Error(`${icon.code}: source artwork changed (${componentCount} components)`);
    const xs = kept.map(p => p % width), ys = kept.map(p => Math.floor(p / width));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const size = 50;
    if (maxX - minX + 1 > size - 2 || maxY - minY + 1 > size - 2) throw Error(`${icon.code}: icon exceeds native-size canvas`);
    const offsetX = Math.floor((size - (maxX - minX + 1)) / 2) - minX;
    const offsetY = Math.floor((size - (maxY - minY + 1)) / 2) - minY;
    const canvas = createCanvas(size, size), ctx = canvas.getContext('2d');
    const output = ctx.createImageData(size, size);
    const color = CLASS_COLOR[CLASS_SHORT.indexOf(icon.code)];
    for (const p of kept) {
        const q = ((Math.floor(p / width) + offsetY) * size + p % width + offsetX) * 4;
        output.data[q] = (color >> 16) & 255;
        output.data[q + 1] = (color >> 8) & 255;
        output.data[q + 2] = color & 255;
        output.data[q + 3] = pixels[p * 4 + 3];
    }
    ctx.putImageData(output, 0, 0);
    return { canvas, pixelCount: kept.length, bounds: [sx + minX, sy + minY, sx + maxX, sy + maxY] };
}

async function main() {
    const source = await loadImage(process.argv[2] || SOURCE_PATH);
    if (source.width !== 521 || source.height !== 370) throw Error('Expected original 521 × 370 sprite atlas');
    const input = createCanvas(source.width, source.height), ctx = input.getContext('2d');
    ctx.drawImage(source, 0, 0);
    for (const icon of ICONS) {
        const { canvas, pixelCount, bounds } = extractIcon(ctx, icon);
        fs.writeFileSync(path.join(ROOT, 'emotes', `${icon.code}.png`), canvas.toBuffer('image/png'));
        console.log(`${icon.code}: ${pixelCount} source pixels retained, bounds ${bounds.join(', ')}`);
    }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { extractIcon, ICONS, SOURCE_URL, SOURCE_PATH };
