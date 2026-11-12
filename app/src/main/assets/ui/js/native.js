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

  const api = (op, payload) => call('api', Object.assign({ op }, payload || {}));

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

  window.BCEmit = emit;

  window.BCNative = {
    onBack: () => {
      const handled = typeof App !== 'undefined' && App.handleBack && App.handleBack();
      return handled === true;
    },
    onIntent: (action, chatId) => {
      if (typeof App !== 'undefined' && App.handleIntent) App.handleIntent(action, chatId);
    },
  };

  return { call, api, fs, tool, env, notify, copy, share, openLink, toast, pick, on, emit };
})();

window.Native = Native;