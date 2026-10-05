import { useCallback, useEffect, useRef, useState } from 'react';
import { scopedStorage, logger } from '@lark-apaas/client-toolkit-lite';

/**
 * 深度合并：用 defaultVal 作为基底，把 stored 中有值的字段合并上去。
 * - stored 为 null / undefined → 全量返回 defaultVal
 * - stored 某字段为 null / undefined → 用 defaultVal 对应字段
 * - defaultVal 某字段是对象 → 递归深合并，stored 对应字段非对象时整段回退 defaultVal
 * - 数组 / 基本类型 → stored 有效则用 stored，否则用 defaultVal
 *
 * 保证返回值的每个叶子字段都非 null/undefined，类型与 defaultVal 一致。
 */
export function deepMergeDefaults<T>(defaultVal: T, stored: unknown): T {
  // stored 空 → 直接返回默认值
  if (stored === null || stored === undefined) return defaultVal;
  // defaultVal 空 → 直接用 stored 强转（极端兜底）
  if (defaultVal === null || defaultVal === undefined) return stored as unknown as T;

  // 数组：stored 是数组就用，否则用默认（必须在对象判断之前，因为 typeof [] === 'object'）
  if (Array.isArray(defaultVal)) {
    return Array.isArray(stored) ? (stored as unknown as T) : defaultVal;
  }
  // stored 是数组但 defaultVal 不是 → 类型不匹配，回退默认
  if (Array.isArray(stored)) {
    return defaultVal;
  }

  // 双方都是普通对象 → 逐字段深合并
  if (
    typeof defaultVal === 'object' &&
    typeof stored === 'object'
  ) {
    const result: Record<string, unknown> = {};
    const def = defaultVal as Record<string, unknown>;
    const sto = stored as Record<string, unknown>;
    for (const key of Object.keys(def)) {
      result[key] = deepMergeDefaults(def[key], sto[key]);
    }
    return result as T;
  }

  // 基本类型：stored 类型匹配则用，否则用默认
  if (typeof stored === typeof defaultVal) {
    return stored as unknown as T;
  }

  return defaultVal;
}

/**
 * 带 localStorage 持久化的 useState 包装
 * - 首次加载时从 scopedStorage 读取
 * - 值变化时（通过 debounce）写入 scopedStorage
 * - 读取失败 / 解析失败 / 字段缺失 / 显式 null 时，都基于 defaultVal 深度合并兜底
 */
export function usePersistentState<T>(
  key: string,
  defaultVal: T,
  debounceMs = 500,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = scopedStorage.getItem(key);
      if (raw === null || raw === undefined || raw === '') return defaultVal;
      const parsed = JSON.parse(raw);
      // 深度合并：默认值做基底，存储值覆盖有效字段；null / 类型不匹配 / 缺字段全部兜底
      return deepMergeDefaults(defaultVal, parsed);
    } catch (e) {
      logger.warn(`persistentState init fail [${key}]:`, String(e));
      return defaultVal;
    }
  });

  const timerRef = useRef<number | null>(null);

  const setValue = useCallback((v: T | ((prev: T) => T)) => {
    setVal(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      // 再保险：写入前用默认值做一次深合并，防止上层意外塞入 null / 残缺对象
      const safeNext = deepMergeDefaults(defaultVal, next);
      // debounce 写盘
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        try {
          scopedStorage.setItem(key, JSON.stringify(safeNext));
        } catch (e) {
          logger.warn(`persistentState save fail [${key}]:`, String(e));
        }
      }, debounceMs);
      return safeNext;
    });
  }, [key, debounceMs, defaultVal]);

  // 立即 flush（页面隐藏/卸载时调用）
  const flushRef = useRef(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      scopedStorage.setItem(key, JSON.stringify(val));
    } catch { /* ignore */ }
  });

  useEffect(() => {
    // 把最新 val 同步到 flush 闭包
    flushRef.current = () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      try {
        scopedStorage.setItem(key, JSON.stringify(val));
      } catch { /* ignore */ }
    };
  }, [key, val]);

  // pagehide / beforeunload 时立即写盘
  useEffect(() => {
    const flush = () => flushRef.current();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, []);

  // 组件卸载时立即写盘并清理定时器（防止 unmount 后 debounce 仍触发）
  useEffect(() => {
    return () => {
      flushRef.current();
    };
  }, []);

  return [val, setValue];
}

/** 立即把一个值写入持久化（不走 debounce，用于重要状态立即保存） */
export function savePersistent<T>(key: string, value: T, defaultVal?: T) {
  try {
    const safe = defaultVal !== undefined ? deepMergeDefaults(defaultVal, value) : value;
    scopedStorage.setItem(key, JSON.stringify(safe));
  } catch (e) {
    logger.warn(`savePersistent fail [${key}]:`, String(e));
  }
}

/** 读取一个持久化值（失败返回 defaultVal；对象会深度合并默认字段） */
export function loadPersistent<T>(key: string, defaultVal: T): T {
  try {
    const raw = scopedStorage.getItem(key);
    if (raw === null || raw === undefined || raw === '') return defaultVal;
    return deepMergeDefaults(defaultVal, JSON.parse(raw));
  } catch (e) {
    logger.warn(`loadPersistent fail [${key}]:`, String(e));
    return defaultVal;
  }
}
