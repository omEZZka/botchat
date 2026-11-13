'use strict';

/**
 * Единственный мост к Android. Всё остальное — поверх него.
 * Сеть и ключи здесь не видны: только api-операции с нормализованными событиями.
 */
const Native = (() => {
  const bridge = () => window.BCBridge || null;

  const call = async (method, payload) => {
    const b = bridge();
    if (!b) return { ok: false, error: 'bridge unavailable' };
    try {
      const raw = b.call(method, JSON.stringify(payload || {}));
      return raw ? JSON.parse(raw) : { ok: false, error: 'empty response' };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  };

  // Асинхронный мост: сетевые операции не блокируют поток WebView.
  const pending = new Map();
  let seq = 0;

  const ensureResultListener = () => {
    if (ensureResultListener.done) return;
    ensureResultListener.done = true;
    window.BCEmit = window.BCEmit || (() => {});
  };

  const callAsync = (method, payload, timeoutMs) => {
    const b = bridge();
    if (!b || typeof b.async !== 'function') return call(method, payload);
    ensureResultListener();
    const id = 'r' + (++seq).toString(36) + Date.now().toString(36);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        pending.delete(id);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs || 120000);
      pending.set(id, finish);
      try {
        b.async(method, JSON.stringify(payload || {}), id);
      } catch (err) {
        finish({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
  };

  const resolveAsync = (payload) => {
    if (!payload || !payload.id) return;
    const finish = pending.get(payload.id);
    if (finish) finish(payload.data || { ok: false, error: 'empty' });
  };

  const api = (op, payload) => {
    const body = Object.assign({ op }, payload || {});
    const b = bridge();
    if (b && typeof b.async === 'function') {
      const heavy = op.indexOf('chat.') === 0 || op.indexOf('providers.') === 0 ||
        op.indexOf('models.') === 0 || op.indexOf('tools.') === 0;
      return heavy ? callAsync('api', body) : call('api', body);
    }
    return call('api', body);
  };

  const chatId = () => (typeof S !== 'undefined' && S && S.chatId) || '';

  const fs = {
    info: (path) => call('fs', { path, chatId: chatId() }),
    ls: (path) => call('ls', { path, chatId: chatId() }),
    readText: (path, maxBytes) => call('readText', { path, maxBytes: maxBytes || 524288, chatId: chatId() }),
    readBase64: (path, maxBytes) => call('readBase64', { path, maxBytes: maxBytes || 4194304, chatId: chatId() }),
    writeText: (path, text) => call('writeText', { path, text, chatId: chatId() }),
    mkdir: (path) => call('mkdir', { path, chatId: chatId() }),
    remove: (path) => call('delete', { path, chatId: chatId() }),
  };

  const tool = (name, args) => api('tool', { name, args: args || {} });

  const env = () => call('env', {});
  const notify = (payload) => call('notify', payload || {});
  const copy = (text) => call('copy', { text });
  const share = (text, title) => call('share', { text, title: title || 'botCHAT' });
  const openLink = (url) => call('openLink', { url });
  const toast = (text) => call('toast', { text });
  const pick = (kind) => call('pick', { kind: kind || 'file' });

  const listeners = new Map();

  const on = (event, handler) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event).delete(handler);
  };

  const emit = (event, payload) => {
    const set = listeners.get(event);
    if (set) {
      for (const handler of Array.from(set)) {
        try {
          handler(payload);
        } catch (err) {
          console.error(err);
        }
      }
    }
    const all = listeners.get('*');
    if (all) {
      for (const handler of Array.from(all)) {
        try {
          handler({ event, payload });
        } catch (err) {
          console.error(err);
        }
      }
    }
  };

  window.BCEmit = (event, payload) => {
    if (event === 'bridge.result') {
      resolveAsync(payload);
      return;
    }
    emit(event, payload);
  };

  window.BCNative = {
    /**
     * Возвращает true, если навигация обработана внутри приложения.
     * Возврат идёт строкой: так его читает evaluateJavascript на стороне Android.
     */
    onBack: () => {
      try {
        return window.Actions && window.Actions.handleBack ? window.Actions.handleBack() === true : false;
      } catch (err) {
        console.error('back failed', err);
        return false;
      }
    },
    onIntent: (action, chatId) => {
      if (window.Actions && window.Actions.handleIntent) window.Actions.handleIntent(action, chatId);
    },
  };

  return { call, api, fs, tool, env, notify, copy, share, openLink, toast, pick, on, emit };
})();

window.Native = Native;