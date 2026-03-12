/**
 * Build EasyTest Live Windows installer into a versioned folder: dist/<version>/
 * Run: npm run build:win:versioned
 * Output: dist/1.0.0/EasyTest Live-1.0.0-Setup.exe (etc.)
 */
const { execSync } = require('child_process');
const { version } = require('./package.json');

const outputDir = `dist/${version}`;
console.log(`Building EasyTest Live v${version} -> ${outputDir}\n`);

execSync(
  `npx electron-builder --win --publish=never -c.directories.output=${outputDir}`,
  { stdio: 'inherit' }
);

console.log(`\nDone. Installer: ${outputDir}/EasyTest Live-${version}-Setup.exe`);
