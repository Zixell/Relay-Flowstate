// Without a Developer ID certificate electron-builder leaves Electron's original
// signature in place, which no longer matches the repackaged app — macOS then
// treats the app as damaged ("malware blocked"). An ad-hoc signature keeps the
// bundle consistent. With a real certificate (CSC_LINK / CSC_NAME) electron-builder
// signs it properly afterwards and this is skipped.
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
