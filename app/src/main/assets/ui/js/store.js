'use strict';

/**
 * Единое состояние и шина событий.
 * DOM-обработчики не вызывают сеть напрямую: они меняют S или вызывают движок,
 * движок публикует события, нормализация обновляет S, рендер подписан на bus.
 */
const Bus = (() => {
  const map = new Map();
  const on = (event, handler) => {
    if (!map.has(event)) map.set(event, new Set());
    map.get(event).add(handler);
    return () => off(event, handler);
  };
  const off = (event, handler) => {
    const set = map.get(event);
    if (set) set.delete(handler);
  };
  const emit = (event, payload) => {
    const set = map.get(event);
    if (set) {
      for (const handler of Array.from(set)) {
        try {
          handler(payload);
        } catch (err) {
          console.error('bus', event, err);
        }
      }
    }
  };
  const clear = () => map.clear();
  return { on, off, emit, clear };
})();

const Settings = (() => {
  const KEY = 'bc.settings';

  const defaults = {
    onboarded: false,
    theme: 'dark',
    accent: 'blue',
    language: 'ru',
    activeProvider: 'opencode',
    activeModel: '',
    modelProfiles: { fast: '', quality: '', cheap: '' },
    pinnedModels: [],
    modelFolders: {},
    agentMode: 'agent',
    stepLimit: 30,
    autoApproveInChat: 'ask',
    trustChats: [],
    notifications: true,
    sounds: true,
    reduceMotion: false,
    sendOnEnter: false,
    windowSize: 60,
    fallbackChain: [],
    compact: false,
    onboardedAt: 0,
  };

  const read = () => {
    const raw = localStorage.getItem(KEY);
    if (!raw) return Object.assign({}, defaults);
    const parsed = U.safeJson(raw, null);
    if (!parsed || typeof parsed !== 'object') return Object.assign({}, defaults);
    return Object.assign({}, defaults, parsed);
  };

  const write = (settings) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
      return true;
    } catch (_) {
      return false;
    }
  };

  return { KEY, defaults, read, write };
})();

const S = {
  booted: false,
  route: 'chats',
  screen: 'list',
  chatId: null,
  chats: [],
  messages: new Map(),
  drafts: {},
  queue: [],
  providers: [],
  keys: {},
  models: [],
  customProviders: [],
  settings: Settings.read(),
  agent: {
    running: false,
    chatId: null,
    phase: 'idle',
    step: 0,
    total: 0,
    label: '',
    paused: false,
    tasks: [],
  },
  pending: null,
  online: navigator.onLine !== false,
  sheets: [],
  toast: null,
  search: { query: '', results: [], scope: 'all' },
  files: { path: '', entries: [], open: null },
  stats: { renderMs: 0, messages: 0 },
};

const Db = (() => {
  const NAME = 'botchat';
  const VERSION = 2;
  let dbPromise = null;
  const pending = new Map();

  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('chats')) {
          const store = db.createObjectStore('chats', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' });
          store.createIndex('chatId', 'chatId');
          store.createIndex('chatTime', ['chatId', 'ts']);
        }
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  };

  const tx = async (storeName, mode) => {
    const db = await open();
    return db.transaction(storeName, mode).objectStore(storeName);
  };

  const request = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const put = async (storeName, value) => {
    const store = await tx(storeName, 'readwrite');
    return request(store.put(value));
  };

  const get = async (storeName, key) => {
    const store = await tx(storeName, 'readonly');
    return request(store.get(key));
  };

  const all = async (storeName) => {
    const store = await tx(storeName, 'readonly');
    return request(store.getAll());
  };

  const del = async (storeName, key) => {
    const store = await tx(storeName, 'readwrite');
    return request(store.delete(key));
  };

  const byChat = async (chatId) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const store = db.transaction('messages', 'readonly').objectStore('messages');
      const idx = store.index('chatId');
      const req = idx.getAll(chatId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  };

  const messagesOfChat = (chatId, fn) => {
    const key = 'chat:' + chatId;
    if (!pending.has(key)) {
      const chain = byChat(chatId).then((rows) => {
        fn(rows);
        pending.delete(key);
      }).catch(() => pending.delete(key));
      pending.set(key, chain);
    }
    return pending.get(key);
  };

  const prune = async (chatId, keep) => {
    const rows = await byChat(chatId);
    if (rows.length <= keep) return;
    const sorted = rows.sort((a, b) => a.ts - b.ts);
    const drop = sorted.slice(0, rows.length - keep);
    const db = await open();
    const batch = db.transaction('messages', 'readwrite').objectStore('messages');
    for (const row of drop) batch.delete(row.id);
    return new Promise((resolve) => {
      batch.transaction.oncomplete = () => resolve(drop.length);
      batch.transaction.onerror = () => resolve(0);
    });
  };

  const clearChat = async (chatId) => {
    const rows = await byChat(chatId);
    const db = await open();
    const batch = db.transaction('messages', 'readwrite').objectStore('messages');
    for (const row of rows) batch.delete(row.id);
    return new Promise((resolve) => {
      batch.transaction.oncomplete = () => resolve(rows.length);
      batch.transaction.onerror = () => resolve(0);
    });
  };

  return { open, put, get, all, del, byChat, messagesOfChat, prune, clearChat };
})();

const Store = (() => {
  const SEND = 'send';
  const QUEUE_KEY = 'bc.queue';
  const DRAFT_KEY = 'bc.drafts';

  const load = async () => {
    S.settings = Settings.read();
    S.drafts = U.safeJson(localStorage.getItem(DRAFT_KEY) || '{}', {});
    S.queue = U.safeJson(localStorage.getItem(QUEUE_KEY) || '[]', []);
    const chats = await Db.all('chats').catch(() => []);
    S.chats = (chats || []).sort(compareChats);
    if (!S.chats.length) {
      await createChat({ title: 'Новый чат', silent: true });
    }
    S.chatId = S.chats[0] ? S.chats[0].id : null;
    if (S.chatId) {
      await Db.messagesOfChat(S.chatId, (rows) => {
        S.messages.set(S.chatId, (rows || []).sort((a, b) => a.ts - b.ts));
      });
      if (!S.messages.has(S.chatId)) S.messages.set(S.chatId, []);
    }
    S.screen = 'list';
    S.booted = true;
    Bus.emit('state:ready', S);
  };

  const compareChats = (a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  };

  const persistChat = async (chat) => {
    const record = Object.assign({}, chat);
    await Db.put('chats', record);
    const idx = S.chats.findIndex((c) => c.id === chat.id);
    if (idx >= 0) S.chats[idx] = record;
    else S.chats.push(record);
    S.chats.sort(compareChats);
  };

  const createChat = async (options) => {
    const opts = options || {};
    const chat = {
      id: U.uid('c'),
      title: opts.title || 'Новый чат',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      archived: false,
      unread: 0,
      status: 'idle',
      preview: '',
      color: U.colorIndex(opts.title || String(Date.now())),
      folder: opts.folder || '',
      mode: opts.mode || 'agent',
      model: opts.model || '',
      provider: opts.provider || '',
      stepLimit: opts.stepLimit || S.settings.stepLimit,
      autoApprove: opts.autoApprove || 'ask',
      projectFolder: opts.projectFolder || '',
      tokens: 0,
      contextLimit: 0,
      draft: '',
    };
    S.messages.set(chat.id, []);
    await persistChat(chat);
    if (!opts.silent) {
      Bus.emit('chats:changed', S.chats);
      await openChat(chat.id);
    } else {
      Bus.emit('chats:changed', S.chats);
    }
    return chat;
  };

  const getChat = (id) => S.chats.find((c) => c.id === id) || null;

  const openChat = async (id, options) => {
    const opts = options || {};
    const chat = getChat(id);
    if (!chat) return;
    S.chatId = id;
    S.screen = 'chat';
    S.route = 'chats';
    if (!S.messages.has(id)) {
      await Db.messagesOfChat(id, (rows) => {
        const sorted = (rows || []).sort((a, b) => a.ts - b.ts);
        S.messages.set(id, sorted);
        S.stats.messages = sorted.length;
        Bus.emit('messages:loaded', { chatId: id, count: sorted.length });
      });
      if (!S.messages.has(id)) S.messages.set(id, []);
    }
    if (chat.unread) {
      chat.unread = 0;
      await persistChat(chat);
    }
    Bus.emit('chat:open', id);
    if (!opts.initial) Bus.emit('render');
  };

  const closeChat = () => {
    S.screen = 'list';
    S.chatId = null;
    Bus.emit('render');
  };

  const messages = (chatId) => S.messages.get(chatId) || [];

  const addMessage = async (chatId, message, options) => {
    const opts = options || {};
    const list = messages(chatId);
    const msg = Object.assign({
      id: U.uid('m'),
      chatId,
      ts: Date.now(),
      role: 'assistant',
      kind: 'text',
      text: '',
      status: 'done',
      attachments: [],
      tools: [],
      meta: {},
    }, message);
    list.push(msg);
    S.messages.set(chatId, list);
    if (!opts.defer) await Db.put('messages', msg);
    const chat = getChat(chatId);
    if (chat) {
      chat.updatedAt = msg.ts;
      chat.preview = previewOf(msg);
      if (msg.role === 'assistant' && S.chatId !== chatId) chat.unread = (chat.unread || 0) + 1;
      await persistChat(chat);
    }
    Bus.emit('messages:changed', { chatId, message: msg });
    if (!opts.silent) Bus.emit('render');
    return msg;
  };

  const updateMessage = async (chatId, messageId, patch, options) => {
    const opts = options || {};
    const list = messages(chatId);
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx < 0) return null;
    const msg = Object.assign({}, list[idx], patch);
    list[idx] = msg;
    S.messages.set(chatId, list);
    if (!opts.deferPersist) {
      await Db.put('messages', msg);
    }
    Bus.emit('message:updated', { chatId, message: msg });
    if (!opts.silent) Bus.emit('render');
    return msg;
  };

  const removeMessage = async (chatId, messageId) => {
    const list = messages(chatId).filter((m) => m.id !== messageId);
    S.messages.set(chatId, list);
    await Db.del('messages', messageId);
    Bus.emit('messages:changed', { chatId });
    Bus.emit('render');
  };

  const previewOf = (msg) => {
    if (msg.text) return U.truncate(msg.text.replace(/\s+/g, ' ').trim(), 90);
    if (msg.attachments && msg.attachments.length) {
      return msg.attachments.length + ' ' + U.plural(msg.attachments.length, 'вложение', 'вложения', 'вложений');
    }
    if (msg.tools && msg.tools.length) return 'Инструмент: ' + msg.tools[0].name;
    return '';
  };

  const touchChat = async (chatId, patch) => {
    const chat = getChat(chatId);
    if (!chat) return null;
    Object.assign(chat, patch, { updatedAt: patch && patch.updatedAt ? patch.updatedAt : Date.now() });
    await persistChat(chat);
    Bus.emit('chats:changed', S.chats);
    return chat;
  };

  const setDraft = (chatId, text) => {
    S.drafts[chatId] = text;
    const chat = getChat(chatId);
    if (chat) chat.draft = text;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(S.drafts));
  };

  const togglePin = async (chatId) => {
    const chat = getChat(chatId);
    if (!chat) return;
    chat.pinned = !chat.pinned;
    await persistChat(chat);
    Bus.emit('chats:changed', S.chats);
    Bus.emit('render');
  };

  const toggleArchive = async (chatId) => {
    const chat = getChat(chatId);
    if (!chat) return;
    chat.archived = !chat.archived;
    await persistChat(chat);
    Bus.emit('chats:changed', S.chats);
    Bus.emit('render');
  };

  const deleteChat = async (chatId) => {
    S.chats = S.chats.filter((c) => c.id !== chatId);
    S.messages.delete(chatId);
    delete S.drafts[chatId];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(S.drafts));
    await Db.del('chats', chatId);
    await Db.clearChat(chatId);
    if (S.chatId === chatId) {
      S.screen = 'list';
      S.chatId = S.chats[0] ? S.chats[0].id : null;
      if (S.chatId) await openChat(S.chatId, { initial: true });
    }
    Bus.emit('chats:changed', S.chats);
    Bus.emit('render');
  };

  const enqueue = (chatId, payload) => {
    S.queue.push({
      id: U.uid('q'),
      chatId,
      payload,
      ts: Date.now(),
      attempts: 0,
    });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(S.queue));
    Bus.emit('queue:changed', S.queue);
  };

  const dequeue = (id) => {
    S.queue = S.queue.filter((q) => q.id !== id);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(S.queue));
    Bus.emit('queue:changed', S.queue);
  };

  const search = (query) => {
    const q = String(query || '').trim().toLowerCase();
    const results = [];
    if (!q) {
      S.search = { query: '', results: [], scope: 'all' };
      return results;
    }
    for (const chat of S.chats) {
      if (chat.archived) continue;
      const titleHit = chat.title.toLowerCase().includes(q);
      const list = messages(chat.id);
      let count = 0;
      for (const msg of list) {
        if ((msg.text || '').toLowerCase().includes(q)) count += 1;
      }
      if (titleHit || count > 0) {
        results.push({ chat, count, titleHit });
      }
    }
    results.sort((a, b) => (b.count + (b.titleHit ? 1 : 0)) - (a.count + (a.titleHit ? 1 : 0)));
    S.search = { query: q, results, scope: 'all' };
    Bus.emit('search:changed', S.search);
    return results;
  };

  const messageHits = (chatId, query) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return messages(chatId).filter((m) => (m.text || '').toLowerCase().includes(q));
  };

  const setSetting = (key, value) => {
    S.settings[key] = value;
    Settings.write(S.settings);
    Bus.emit('settings:changed', { key, value });
    Bus.emit('render');
  };

  const setAgent = (patch) => {
    Object.assign(S.agent, patch);
    Bus.emit('agent:changed', S.agent);
    Bus.emit('render');
  };

  const setChatModel = async (chatId, providerId, modelId) => {
    const chat = getChat(chatId);
    if (!chat) return;
    chat.provider = providerId;
    chat.model = modelId;
    await persistChat(chat);
    Bus.emit('chats:changed', S.chats);
    Bus.emit('render');
  };

  const publishState = () => {
    const active = getChat(S.chatId);
    Native.call('state', {
      activeChatId: S.chatId || '',
      agentRunning: !!(S.agent && S.agent.running),
      pendingPermission: !!S.pending,
      step: S.agent ? S.agent.step : 0,
      title: active ? active.title : 'botCHAT',
      online: S.online,
    });
  };

  const setOnline = (online) => {
    if (S.online === online) return;
    S.online = online;
    Bus.emit('network:changed', online);
    Bus.emit('render');
    if (online) Bus.emit('queue:flush');
  };

  const ready = () => S.booted;

  return {
    load,
    createChat,
    getChat,
    openChat,
    closeChat,
    messages,
    addMessage,
    updateMessage,
    removeMessage,
    touchChat,
    setDraft,
    togglePin,
    toggleArchive,
    deleteChat,
    enqueue,
    dequeue,
    search,
    messageHits,
    setSetting,
    setAgent,
    setChatModel,
    publishState,
    setOnline,
    persistChat,
    ready,
  };
})();

window.Bus = Bus;
window.S = S;
window.Db = Db;
window.Store = Store;
window.Settings = Settings;