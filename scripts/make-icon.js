'use strict';

/**
 * Renders an emoji into a macOS-style app icon.
 *
 *   npx electron scripts/make-icon.js
 *
 * Produces build/icon.png (1024x1024), then scripts/make-icns.sh turns it
 * into build/icon.icns.
 */

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const EMOJI = '🐔';
const SIZE = 1024;
const INSET = 100; // Apple's grid: 824px artwork inside a 1024 canvas
const RADIUS = 185;

const ART = SIZE - INSET * 2;

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body {
        margin: 0;
        width: ${SIZE}px;
        height: ${SIZE}px;
        background: transparent;
        overflow: hidden;
      }
      .tile {
        position: absolute;
        left: ${INSET}px;
        top: ${INSET}px;
        width: ${ART}px;
        height: ${ART}px;
        border-radius: ${RADIUS}px;
        background: linear-gradient(180deg, #fcfcfe 0%, #ececf2 52%, #dcdce6 100%);
        box-shadow:
          inset 0 2px 4px rgba(255, 255, 255, 0.95),
          inset 0 -10px 26px rgba(0, 0, 0, 0.09),
          0 18px 40px rgba(0, 0, 0, 0.22);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .glyph {
        font-family: "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
        font-size: 440px;
        line-height: 1;
        filter: drop-shadow(0 10px 16px rgba(0, 0, 0, 0.16));
      }
    </style>
  </head>
  <body>
    <div class="tile"><span class="glyph">${EMOJI}</span></div>
  </body>
</html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, zoomFactor: 1 },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const captured = await win.webContents.capturePage();
  const png = captured.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG();

  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });

  const out = path.join(outDir, 'icon.png');
  fs.writeFileSync(out, png);

  const meta = nativeImage.createFromBuffer(png).getSize();
  console.log(`[icon] wrote ${out} (${meta.width}x${meta.height}, ${fs.statSync(out).size} bytes)`);

  win.destroy();
  app.quit();
});
