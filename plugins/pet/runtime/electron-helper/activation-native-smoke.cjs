'use strict';
// Run with Electron as a main-process smoke; no Desktop or pet window is created.
const { app } = require('electron');
app.whenReady().then(() => {
  try {
    const koffi = require('koffi');
    const grant = koffi.load('user32.dll').func('bool __stdcall AllowSetForegroundWindow(uint32_t dwProcessId)');
    console.log(JSON.stringify({ electron: process.versions.electron, arch: process.arch, koffi: koffi.version, result: grant(process.pid) }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
