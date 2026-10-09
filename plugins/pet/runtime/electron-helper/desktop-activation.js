'use strict';

const { execFile } = require('node:child_process');

/** Resolve the macOS app that owns the DSH Host, never the pet Helper app. */
function desktopAppPath(executable) {
  if (typeof executable !== 'string') return null;
  const suffix = '.app/Contents/MacOS/';
  const index = executable.lastIndexOf(suffix);
  if (!executable.startsWith('/') || index < 0) return null;
  const binary = executable.slice(index + suffix.length);
  if (!binary || binary.includes('/')) return null;
  return executable.slice(0, index + 4);
}

/** Activate the exact macOS owner; Windows uses the Host bridge instead. */
function activateDesktop(executable, platform = process.platform, run = execFile) {
  const appPath = platform === 'darwin' ? desktopAppPath(executable) : null;
  if (!appPath) return Promise.reject(new Error('当前宿主不是可识别的 macOS DSH Desktop 应用'));
  const command = '/usr/bin/open';
  const args = ['-a', appPath, 'dsh://open'];
  const options = { timeout: 5000 };
  return new Promise((resolve, reject) => {
    run(command, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

module.exports = { desktopAppPath, activateDesktop };
