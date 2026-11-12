#!/usr/bin/env node
'use strict';

/**
 * Draws Dung's app icon: the pixel beetle standing on its dung ball, on the
 * golden trail, sparkling — the 100% moment — on an ink-black tile.
 *
 *   node scripts/make-icon.js        (needs Playwright: npm i -D playwright)
 *
 * Writes build/icon.png (1024², used for Windows and Linux) and
 * build/icon.icns (every macOS size, 16–1024) without needing macOS tools.
 * Colours come from the beetle palette in docs/DESIGN.md.
 */

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'build');

const PALETTE = {
  shell: '#46348a',
  sheen: '#2fb8a6',
  sheen2: '#8f66f2',
  edge: '#05030c',
  ball: '#8a5a33',
  ballLight: '#bb8750',
  ballDark: '#573720',
  fill: '#e2a23c',
  fill2: '#b9791f',
  spark: '#ffd36b',
  dust: '#c4a779',
};

// Runs in the browser: paints the scene on a 32×32 pixel grid.
function paint(colors) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  const S = 1024;
  const I = 100; // Apple grid: 824px tile inside a 1024 canvas
  const A = S - 2 * I;
  const R = 185;
  const tile = () => {
    ctx.beginPath();
    ctx.roundRect(I, I, A, A, R);
  };

  // shadow, tile, warm glow, hairline rim
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.28)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 12;
  tile();
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();

  const bg = ctx.createLinearGradient(0, I, 0, S - I);
  bg.addColorStop(0, '#262626');
  bg.addColorStop(1, '#0b0b0b');
  tile();
  ctx.fillStyle = bg;
  ctx.fill();

  ctx.save();
  tile();
  ctx.clip();
  const glow = ctx.createRadialGradient(512, 560, 40, 512, 560, 420);
  glow.addColorStop(0, 'rgba(255,214,120,.22)');
  glow.addColorStop(1, 'rgba(255,214,120,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);

  const cell = 24;
  const ox = (S - 32 * cell) / 2;
  const oy = ox + 8;
  const put = (x, y, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
  };

  // golden trail
  const G = 27;
  for (let x = 2; x <= 29; x++) {
    put(x, G, colors.fill);
    put(x, G + 1, x % 3 === 0 ? colors.fill2 : colors.fill);
    put(x, G + 2, colors.fill2);
  }
  put(1, G + 1, colors.fill);
  put(30, G + 1, colors.fill);

  // the ball, shaded like the progress bar's
  const r = 7.5;
  const cx = 16;
  const cy = G - r;
  const FLECKS = [[0.2, 0.4, 1], [0.55, 1.9, 0], [0.62, 3.4, 1], [0.5, 5.1, 0], [0.34, 2.9, 0], [0.7, 0.2, 0], [0.68, 4.3, 1]];
  const flecks = FLECKS.map((f) => [Math.floor(Math.cos(f[1] + 0.6) * f[0] * r), Math.floor(Math.sin(f[1] + 0.6) * f[0] * r), f[2]]);
  for (let y = -8; y < 8; y++) {
    for (let x = -8; x < 8; x++) {
      const nx = (x + 0.5) / r;
      const ny = (y + 0.5) / r;
      const d = nx * nx + ny * ny;
      if (d > 1) continue;
      const lit = -(nx * 0.55 + ny * 0.83);
      let c = colors.ball;
      if (d > Math.pow(1 - 1.15 / r, 2)) c = lit > 0.25 ? colors.ball : colors.ballDark;
      else if (lit > 0.42) c = colors.ballLight;
      else if (lit < -0.38) c = colors.ballDark;
      for (const f of flecks) if (f[0] === x && f[1] === y && d < 0.7) c = f[2] ? colors.ballLight : colors.ballDark;
      put(Math.round(cx + x), Math.round(cy + y), c);
    }
  }

  // the beetle, standing on top (same sprite as the 100% dance)
  const TOP = ['.....KKKK......', '...KKHHBBKK....', '..KHHBBBBBBK...', '.KHHBBBBBBBBKK.', 'KHBBBBBBBBBKBBK', 'KBBBBBBBBVBKBBK', '.KKBBBBBVBKKKK.', '...KKKKKKK.....'];
  const key = { K: colors.edge, B: colors.shell, H: colors.sheen, V: colors.sheen2 };
  const bx = 9;
  const by = Math.round(cy - r) - 9;
  for (const lx of [4, 7, 10]) {
    put(bx + lx + 1, by + 8, colors.edge);
    put(bx + lx + (lx === 7 ? 2 : 0), by + 9, colors.edge);
  }
  TOP.forEach((row, j) => [...row].forEach((ch, i) => ch !== '.' && put(bx + i, by + j, key[ch])));
  put(bx + 15, by + 4, colors.edge);
  put(bx + 16, by + 3, colors.edge);

  // sparkles and dust
  const plus = (x, y, c) => [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => put(x + dx, y + dy, c));
  plus(5, 7, colors.spark);
  plus(26, 4, colors.spark);
  put(28, 11, colors.spark);
  put(4, 15, colors.spark);
  put(25, 15, colors.dust);
  put(7, 22, colors.dust);
  ctx.restore();

  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,.08)';
  tile();
  ctx.stroke();

  // Every size the .icns needs, downscaled in steps for clean edges.
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  const out = {};
  for (const size of sizes) {
    let src = canvas;
    let w = 1024;
    while (w / 2 >= size) {
      const step = document.createElement('canvas');
      step.width = step.height = w / 2;
      const sctx = step.getContext('2d');
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(src, 0, 0, w / 2, w / 2);
      src = step;
      w /= 2;
    }
    if (w !== size) {
      const fin = document.createElement('canvas');
      fin.width = fin.height = size;
      fin.getContext('2d').drawImage(src, 0, 0, size, size);
      src = fin;
    }
    out[size] = src.toDataURL('image/png').split(',')[1];
  }
  return out;
}

// .icns: 'icns' + length, then (type, length, PNG) entries.
function icns(pngs) {
  const entries = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ].map(([type, size]) => {
    const data = pngs[size];
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const encoded = await page.evaluate(paint, PALETTE);
  await browser.close();

  const pngs = Object.fromEntries(Object.entries(encoded).map(([size, b64]) => [size, Buffer.from(b64, 'base64')]));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[1024]);
  fs.writeFileSync(path.join(OUT, 'icon.icns'), icns(pngs));
  console.log(`wrote ${path.join(OUT, 'icon.png')} and icon.icns`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
