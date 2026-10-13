'use strict';

/** A Windows foreground grant is scoped to the Desktop that launched this Helper. */
class ActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Parse the process-boundary PID; no renderer input selects the activation target. */
function desktopPid(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid < 0xffffffff ? pid : null;
}

/** Load the Windows API in this process, which received the user's mouse input. */
function loadForegroundGrant() {
  const koffi = require('koffi');
  return koffi.load('user32.dll').func('bool __stdcall AllowSetForegroundWindow(uint32_t dwProcessId)');
}

/** Grant the exact Desktop PID before forwarding its activation request; failure stops forwarding. */
function windowsActivation(value, load = loadForegroundGrant) {
  const pid = desktopPid(value);
  let grant;
  return {
    async activate(forward) {
      if (pid === null) throw new ActivationError('unavailable', '请更新并重启 DSH Desktop');
      if (!grant) {
        try { grant = load(); }
        catch (error) {
          console.error('[dsh-pet] foreground binding unavailable:', error);
          throw new ActivationError('native-unavailable', '桌宠窗口激活组件不可用，请重新安装插件');
        }
      }
      if (!grant(pid)) throw new ActivationError('foreground-denied', '未能切换到 DSH，请点击任务栏图标');
      return forward();
    },
  };
}

module.exports = { ActivationError, desktopPid, windowsActivation };
