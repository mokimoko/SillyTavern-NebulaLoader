'use strict';
// Confirm the generated duotone CSS actually carries a two-layer SVG:
// the tint layer must survive as an opacity attribute, because that
// opacity is what becomes alpha in the mask channel.
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'phosphor-duotone-icons.css'), 'utf8');

const uris = [...css.matchAll(/--bd-icon: url\("data:image\/svg\+xml,([^"]+)"\)/g)];
console.log(`data URIs found: ${uris.length}`);
console.log(`remote URLs left: ${(css.match(/https:\/\/api\.iconify\.design/g) || []).length}`);

let withOpacity = 0;
for (const u of uris) if (/opacity=/.test(decodeURIComponent(u[1]))) withOpacity++;
console.log(`carrying an opacity layer: ${withOpacity}/${uris.length}`);

const gear = css.match(/\.fa-gear::before \{ --bd-icon: url\("data:image\/svg\+xml,([^"]+)"\)/);
console.log('\nsample (fa-gear):\n' + decodeURIComponent(gear[1]).slice(0, 320));
