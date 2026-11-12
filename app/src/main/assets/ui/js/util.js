'use strict';

/**
 * Утилиты: DOM, форматирование, время, буферы, идентификаторы.
 * Никаких зависимостей и глобальных побочных эффектов, кроме U.
 */
const U = (() => {
  const el = (tag, attrs, children) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key in node && key !== 'list' && typeof value !== 'object') {
          node[key] = value;
        } else {
          node.setAttribute(key, String(value));
        }
      }
    }
    if (children) {
      const list = Array.isArray(children) ? children : [children];
      for (const child of list) {
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
    }
    return node;
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const clear = (node) => {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  };

  const escape = (text) => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const uid = (prefix) => {
    const rnd = Math.random().toString(36).slice(2, 10);
    return (prefix || 'id') + '_' + Date.now().toString(36) + rnd;
  };

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const debounce = (fn, ms) => {
    let timer = null;
    const wrapped = (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, ms);
    };
    wrapped.cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return wrapped;
  };

  const raf = (fn) => requestAnimationFrame(fn);

  const queue = (() => {
    let pending = false;
    const jobs = new Set();
    const run = () => {
      pending = false;
      const batch = Array.from(jobs);
      jobs.clear();
      for (const job of batch) {
        try {
          job();
        } catch (err) {
          console.error(err);
        }
      }
    };
    return (job) => {
      jobs.add(job);
      if (!pending) {
        pending = true;
        raf(run);
      }
    };
  })();

  const pad = (n) => (n < 10 ? '0' + n : String(n));

  const time = (ts) => {
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  };

  const dayKey = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };

  const dayLabel = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const diff = Math.floor((start - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
    if (diff === 0) return 'Сегодня';
    if (diff === 1) return 'Вчера';
    if (diff < 7) {
      return ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'][d.getDay()];
    }
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
  };

  const listLabel = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.floor((start - dayStart) / 86400000);
    if (diff === 0) return time(ts);
    if (diff === 1) return 'Вчера';
    if (diff < 7) return ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()];
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1);
  };

  const groupLabel = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.floor((start - dayStart) / 86400000);
    const tr = (key, fallback) => (window.I18n ? window.I18n.t(key, fallback) : fallback);
    if (diff === 0) return tr('chats.group.today', 'Сегодня');
    if (diff === 1) return tr('chats.group.yesterday', 'Вчера');
    if (diff < 7) return tr('chats.group.week', 'На этой неделе');
    if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) return tr('chats.group.month', 'В этом месяце');
    return tr('chats.group.earlier', 'Раньше');
  };

  const bytes = (n) => {
    if (!n) return '0 Б';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return (i === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 0 : 1)) + ' ' + units[i];
  };

  const initials = (name) => {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return 'BC';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  };

  const colorIndex = (text) => {
    let hash = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return hash % 7;
  };

  const truncate = (text, max) => {
    const s = String(text || '');
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  };

  const parseTime = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : Date.now();
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const safeJson = (text, fallback) => {
    try {
      return JSON.parse(text);
    } catch (_) {
      return fallback;
    }
  };

  const plural = (n, one, few, many) => {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
  };

  const isReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const highlight = (root, query) => {
    const q = String(query || '').trim();
    if (!q) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const needle = q.toLowerCase();
    for (const node of nodes) {
      const text = node.nodeValue;
      const idx = text.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      const frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode(text.slice(0, idx)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      frag.appendChild(document.createTextNode(text.slice(idx + q.length)));
      node.parentNode.replaceChild(frag, node);
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const res = await Native.call('copy', { text });
      return !!(res && res.ok);
    }
  };

  const formatDelta = (added, removed) => {
    const a = Number(added) || 0;
    const r = Number(removed) || 0;
    return '+' + a + ' −' + r;
  };

  const parsePath = (path) => {
    const clean = String(path || '').replace(/\\/g, '/');
    const idx = clean.lastIndexOf('/');
    if (idx < 0) return { dir: '', name: clean };
    return { dir: clean.slice(0, idx), name: clean.slice(idx + 1) };
  };

  const basename = (path) => parsePath(path).name;

  const ext = (path) => {
    const name = basename(path);
    const idx = name.lastIndexOf('.');
    return idx < 0 ? '' : name.slice(idx + 1).toLowerCase();
  };

  const looksBinary = (text) => {
    if (!text) return false;
    const sample = text.slice(0, 512);
    let control = 0;
    for (let i = 0; i < sample.length; i += 1) {
      const code = sample.charCodeAt(i);
      if (code === 0) return true;
      if (code < 9 || (code > 13 && code < 32)) control += 1;
    }
    return control > sample.length * 0.1;
  };

  const formatRelative = (ts) => {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч назад';
    return dayLabel(ts) + ', ' + time(ts);
  };

  return {
    el,
    $,
    $$,
    clear,
    escape,
    uid,
    clamp,
    debounce,
    raf,
    queue,
    pad,
    time,
    dayKey,
    dayLabel,
    listLabel,
    groupLabel,
    bytes,
    initials,
    colorIndex,
    truncate,
    parseTime,
    sleep,
    safeJson,
    plural,
    isReducedMotion,
    highlight,
    copyToClipboard,
    formatDelta,
    parsePath,
    basename,
    ext,
    looksBinary,
    formatRelative,
  };
})();

window.U = U;