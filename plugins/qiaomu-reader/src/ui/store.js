/**
 * 轻量可订阅状态容器。纯 JS，不依赖 React（React 绑定见 hooks.js）。
 * 状态整体视为不可变对象：set 只做浅合并，订阅者拿到的是新对象。
 */

/**
 * 创建一个可订阅状态容器。
 * @param {object} [initial] 初始状态（浅拷贝）
 * @returns {{get: () => object, set: (patch: object|function) => object, subscribe: (fn: function) => (() => void), select: (selector: function, callback: function) => (() => void)}} store
 */
export function createUiStore(initial = {}) {
  let state = { ...(initial || {}) };
  const listeners = new Set();

  /** 通知所有订阅者，任何一个订阅者抛错都不影响其它订阅者 */
  function emit(next) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(next);
      } catch (_error) {
        /* 订阅者异常必须被吞掉，否则会拖垮整个界面 */
      }
    }
  }

  return {
    /** @returns {object} 当前状态快照 */
    get() {
      return state;
    },
    /**
     * 合并新状态并通知订阅者。
     * @param {object|function} patch 补丁对象，或 (state) => patch
     * @returns {object} 合并后的状态
     */
    set(patch) {
      let next = patch;
      try {
        if (typeof patch === 'function') next = patch(state);
      } catch (_error) {
        return state;
      }
      if (!next || typeof next !== 'object') return state;
      state = { ...state, ...next };
      emit(state);
      return state;
    },
    /**
     * 订阅状态变化。
     * @param {function} fn
     * @returns {function} 取消订阅
     */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    /**
     * 只订阅某个派生值的变化（Object.is 比较），订阅时立即回调一次当前值。
     * @param {function} selector (state) => value
     * @param {function} callback (value, state) => void
     * @returns {function} 取消订阅
     */
    select(selector, callback) {
      if (typeof selector !== 'function' || typeof callback !== 'function') return () => {};
      let current;
      try {
        current = selector(state);
      } catch (_error) {
        current = undefined;
      }
      try {
        callback(current, state);
      } catch (_error) {
        /* 忽略 */
      }
      let alive = true;
      const unsubscribe = this.subscribe((next) => {
        if (!alive) return;
        let value;
        try {
          value = selector(next);
        } catch (_error) {
          return;
        }
        if (Object.is(value, current)) return;
        current = value;
        try {
          callback(value, next);
        } catch (_error) {
          /* 忽略 */
        }
      });
      return () => {
        alive = false;
        unsubscribe();
      };
    },
  };
}

/**
 * 浅比较两个对象（用于避免无意义的重渲染）。
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) return false;
  }
  return true;
}