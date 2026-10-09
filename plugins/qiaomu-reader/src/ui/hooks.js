/**
 * React 绑定与通用小 hook。只依赖 react。
 */
import * as React from 'react';
import { shallowEqual } from './store.js';

/**
 * 订阅 UI store 的某个派生值并触发重渲染。
 * selector 通过 ref 保存，所以每次渲染传入新函数不会导致反复订阅。
 * @param {object} store createUiStore() 的返回值
 * @param {function} [selector] (state) => value，默认整个 state
 * @returns {*} 派生值
 */
export function useUiStore(store, selector) {
  const selectRef = React.useRef(selector || ((state) => state));
  selectRef.current = selector || ((state) => state);
  const read = () => {
    try {
      return selectRef.current(store.get());
    } catch (_error) {
      return undefined;
    }
  };
  const [value, setValue] = React.useState(read);
  React.useEffect(() => {
    let current = read();
    setValue(current);
    return store.subscribe((state) => {
      let next;
      try {
        next = selectRef.current(state);
      } catch (_error) {
        return;
      }
      if (Object.is(next, current)) return;
      current = next;
      setValue(next);
    });
    // read 依赖 store，store 实例在会话内稳定
  }, [store]);
  return value;
}

/**
 * 订阅 store 中的一个对象值，用浅比较判断是否变化（避免每帧新建对象导致的重渲染）。
 * @param {object} store
 * @param {function} selector
 * @returns {*}
 */
export function useUiStoreShallow(store, selector) {
  const selectRef = React.useRef(selector);
  selectRef.current = selector;
  const read = () => {
    try {
      return selectRef.current(store.get());
    } catch (_error) {
      return undefined;
    }
  };
  const [value, setValue] = React.useState(read);
  React.useEffect(() => {
    let current = read();
    setValue(current);
    return store.subscribe((state) => {
      let next;
      try {
        next = selectRef.current(state);
      } catch (_error) {
        return;
      }
      if (shallowEqual(next, current)) return;
      current = next;
      setValue(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);
  return value;
}

/**
 * 生成一个防抖函数（组件卸载时清理定时器）。
 * @param {function} fn 目标函数
 * @param {number} delay 毫秒
 * @returns {function} 防抖后的函数
 */
export function useDebounced(fn, delay = 250) {
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  const timerRef = React.useRef(null);
  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  return React.useCallback((...args) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      try {
        fnRef.current(...args);
      } catch (_error) {
        /* 忽略 */
      }
    }, Math.max(0, delay));
  }, [delay]);
}

/**
 * 媒体查询 hook（窄屏时阅读面板改为覆盖层）。
 * @param {string} query 例如 '(max-width: 900px)'
 * @returns {boolean}
 */
export function useMediaQuery(query) {
  const read = () => {
    try {
      if (typeof window === 'undefined' || !window.matchMedia) return false;
      return !!window.matchMedia(query).matches;
    } catch (_error) {
      return false;
    }
  };
  const [matches, setMatches] = React.useState(read);
  React.useEffect(() => {
    let media = null;
    const onChange = (event) => setMatches(!!(event && event.matches));
    try {
      if (typeof window === 'undefined' || !window.matchMedia) return undefined;
      media = window.matchMedia(query);
      setMatches(!!media.matches);
      if (media.addEventListener) media.addEventListener('change', onChange);
      else if (media.addListener) media.addListener(onChange);
    } catch (_error) {
      return undefined;
    }
    return () => {
      try {
        if (!media) return;
        if (media.removeEventListener) media.removeEventListener('change', onChange);
        else if (media.removeListener) media.removeListener(onChange);
      } catch (_error) {
        /* 忽略 */
      }
    };
  }, [query]);
  return matches;
}

/**
 * 挂载全局事件并自动清理。
 * @param {string} type 事件名，如 'keydown'
 * @param {function} handler
 * @param {object|boolean} [options] addEventListener 选项
 * @param {boolean} [enabled] 传 false 时不挂载
 */
export function useGlobalEvent(type, handler, options, enabled = true) {
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  React.useEffect(() => {
    if (!enabled) return undefined;
    const listener = (event) => {
      try {
        handlerRef.current(event);
      } catch (_error) {
        /* 事件处理异常不能冒泡到宿主 */
      }
    };
    const target = typeof window !== 'undefined' ? window : null;
    if (!target || !target.addEventListener) return undefined;
    target.addEventListener(type, listener, options);
    return () => target.removeEventListener(type, listener, options);
  }, [type, enabled, options]);
}