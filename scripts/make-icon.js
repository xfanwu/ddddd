#!/usr/bin/env node
'use strict';

/**
 * Draws Dung's app icon: a pixel swirl of golden dung, sparkling, on an
 * ink-black tile — the treasure the beetle rolls home. Its gold is the
 * golden trail of the progress bar.
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
  base: '#e2a23c', // golden trail
  light: '#ffe08a',
  dark: '#b9791f', // golden trail shade
  seam: '#8f5a12', // between tiers
  edge: '#4a2f08',
  shine: '#fff6dc',
  spark: '#fff2c4',
  stink: 'rgba(255,255,255,.32)',
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
  const glow = ctx.createRadialGradient(512, 600, 30, 512, 600, 430);
  glow.addColorStop(0, 'rgba(255,200,90,.25)');
  glow.addColorStop(1, 'rgba(255,200,90,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);

  const cell = 24;
  const ox = (S - 32 * cell) / 2;
  const oy = ox + 10;
  const put = (x, y, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
  };

  // Golden swirl: three stacked tiers and a curled tip. Later tiers paint
  // over earlier ones; a darker seam under each upper tier keeps the swirl
  // readable instead of a blob, and a dark rim outlines the whole shape.
  const grid = new Map();
  const at = (x, y) => `${x},${y}`;
  const tiers = [
    [16, 25, 11.5, 3.8],
    [16, 20.2, 8.8, 3.4],
    [16, 15.8, 6.2, 3.0],
    [17.5, 12.0, 3.0, 2.2],
  ];
  const owner = new Map();
  tiers.forEach(([cx, cy, rx, ry], t) => {
    for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) {
      for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
        const nx = (x + 0.5 - cx) / rx;
        const ny = (y + 0.5 - cy) / ry;
        const d = nx * nx + ny * ny;
        if (d > 1) continue;
        const lit = -(nx * 0.6 + ny * 0.8);
        let c = colors.base;
        if (d > 0.72) c = lit > 0.2 ? colors.base : colors.dark;
        if (lit > 0.55 && d > 0.35) c = colors.light;
        if (ny > 0.55) c = colors.dark;
        grid.set(at(x, y), c);
        owner.set(at(x, y), t);
      }
    }
  });
  for (const [key, t] of owner) {
    if (t === 0) continue;
    const [x, y] = key.split(',').map(Number);
    const below = at(x, y + 1);
    if (owner.has(below) && owner.get(below) < t) grid.set(below, colors.seam);
  }
  const rim = new Set();
  for (const key of grid.keys()) {
    const [x, y] = key.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!grid.has(at(x + dx, y + dy))) rim.add(at(x + dx, y + dy));
  }
  for (const key of rim) grid.set(key, colors.edge);
  for (const [x, y] of [[11, 19], [12, 19], [13, 14], [9, 24]]) grid.set(at(x, y), colors.shine);

  // sparkles and two lazy stink lines
  const plus = (x, y, c) => [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => grid.set(at(x + dx, y + dy), c));
  plus(6, 6, colors.spark);
  plus(26, 8, colors.spark);
  grid.set(at(25, 4), colors.spark);
  grid.set(at(5, 14), colors.spark);
  grid.set(at(27, 17), colors.spark);
  for (const [x0, y0] of [[11, 4], [21, 3]]) for (let i = 0; i < 5; i++) grid.set(at(x0 + (i % 2), y0 + i), colors.stink);

  for (const [key, c] of grid) {
    const [x, y] = key.split(',').map(Number);
    put(x, y, c);
  }
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
