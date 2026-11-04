import { copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
for (const name of ['manifest.webmanifest','icon-192.png','icon-512.png']) copyFileSync(name, `dist/${name}`);
const assets = readdirSync('dist/assets').map(name => `./assets/${name}`);
const version = createHash('sha256').update(assets.join('|')).digest('hex').slice(0,12);
writeFileSync('dist/sw.js', readFileSync('sw.js','utf8').replace('lux-next-shell-v1', `lux-next-shell-${version}`).replace("['./', './icon-192.png', './manifest.webmanifest']", JSON.stringify(['./','./icon-192.png','./manifest.webmanifest', ...assets])));
