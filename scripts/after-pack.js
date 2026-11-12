'use strict';

/**
 * Ad-hoc signs the macOS bundle after packaging.
 *
 * electron-builder skips signing entirely when no Developer ID is configured,
 * which leaves the main executable with only the linker's ad-hoc signature.
 * On Apple Silicon that incomplete signature makes Gatekeeper report the app as
 * "damaged" once it carries a quarantine flag — a misleading error, and a
 * support ticket every time.
 *
 * Signing the whole bundle ad-hoc fixes that: the app still shows "unidentified
 * developer" on first launch, which is honest and bypassable, instead of
 * claiming to be corrupt.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const bundle = path.join(context.appOutDir, appName);

  // Sign the bundled aria2c first: --deep does not reliably reach plain
  // executables under Contents/Resources, and an unsigned helper is killed on
  // Apple Silicon.
  const fs = require('node:fs');
  const aria2c = path.join(bundle, 'Contents', 'Resources', 'bin', 'aria2c');
  if (fs.existsSync(aria2c)) {
    execFileSync('codesign', ['--force', '--sign', '-', aria2c], { stdio: 'inherit' });
  } else {
    console.warn('[sign] no bundled aria2c — run `npm run vendor` before packaging');
  }

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], {
    stdio: 'inherit',
  });

  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], {
    stdio: 'inherit',
  });

  console.log(`[sign] ad-hoc signed ${appName}`);
};
