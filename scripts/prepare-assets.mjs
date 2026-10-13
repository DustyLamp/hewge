import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
await mkdir('public/images', { recursive: true });
const assets = [
 ['assets/shirt-front-cutout.png', 'shirt-front', 1100, 85],
 ['assets/originals/00-approved-painted-mockup.png', 'approved-mockup', 1536, 87],
 ['assets/originals/01-front-right.png', 'front-right', 920, 84],
 ['assets/originals/02-front-left.png', 'front-left', 920, 84],
 ['assets/originals/03-back.png', 'back', 1100, 84],
 ['assets/originals/04-right-sleeve.png', 'night', 1200, 84],
 ['assets/originals/05-left-sleeve.png', 'morning', 1200, 84],
 ['assets/originals/06-collar.png', 'foliage', 1500, 82],
];
for (const [input, name, width, quality] of assets) {
 const result = await sharp(input).resize({width, withoutEnlargement:true}).webp({ quality, effort:6 }).toFile(`public/images/${name}.webp`);
 console.log(`${name}: ${Math.round(result.size / 1024)} KB`);
}
