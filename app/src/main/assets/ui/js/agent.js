'use strict';

/**
 * Движок агентского цикла: plan → tool_call → result → continue.
 * Шаги сериализуются в steps.jsonl, состояние переживает перезапуск.
 * Сеть — только через Native.api (Kotlin), инструменты — через Native.tool.
 */
const Agent = (() => {
  let active = null;
  let paused = false;
  let pauseWaiter = null;

  const newRun = (chatId) => ({
    id: U.uid('run'),
    chatId,
    phase: 'plan',
    step: 0,
    limit: 30,
    messages: [],
    todos: [],
    tasks: [],
    context: [],
    checkpointed: false,
    checkpointId: '',
    startedAt: Date.now(),
  });

  const send = async (chatId, payload) => {
    const chat = Store.getChat(chatId);
    if (!chat) return;
    const offline = !S.online || !navigator.onLine;
    if (offline) {
      await Store.addMessage(chatId, {
        role: 'user', kind: 'text', text: payload.text || '',
        attachments: payload.attachments || [], status: 'queued',
        replyTo: payload.replyTo || null,
      });
      Store.enqueue(chatId, payload);
      await Store.touchChat(chatId, { status: 'queued' });
      Render.toast(t('offline.queued'));
      Store.publishState();
      return;
    }
    // Активная рабочая папка нужна и промпту, и инструментам.
    const st = await Native.api('storage.info', { chatId });
    if (st && st.ok) S.storageActive = st.active || '';
    const userMsg = await Store.addMessage(chatId, {
      role: 'user', kind: 'text', text: payload.text || '',
      attachments: payload.attachments || [], status: 'sending',
      replyTo: payload.replyTo || null,
    });
    await Store.touchChat(chatId, { status: 'running', awaitingAnswer: false });
    if (S.agent.running) {
      await Store.updateMessage(chatId, userMsg.id, { status: 'queued' });
      Store.enqueue(chatId, payload);
      return;
    }
    await Store.updateMessage(chatId, userMsg.id, { status: 'delivered' }, { silent: true });
    await run(chatId);
  };

  const flushQueue = async () => {
    if (!S.online || !S.queue.length) return;
    const items = S.queue.slice();
    for (const item of items) {
      if (!S.online) break;
      Store.dequeue(item.id);
      const list = Store.messages(item.chatId);
      const last = list.filter((m) => m.role === 'user' && m.status === 'queued').pop();
      if (last) {
        await Store.updateMessage(item.chatId, last.id, { status: 'delivered' }, { silent: true });
        await Store.touchChat(item.chatId, { status: 'running' });
      }
      if (!S.agent.running) await run(item.chatId);
    }
    Bus.emit('render');
  };

  const run = async (chatId) => {
    if (active) return;
    const chat = Store.getChat(chatId);
    if (!chat) return;
    const mode = chat.mode || S.settings.agentMode || 'agent';
    active = newRun(chatId);
    active.limit = chat.stepLimit || S.settings.stepLimit || 30;
    paused = false;
    AgentServiceKeepAlive(true, chatId);
    const warning = warnContext(chatId);
    Store.setAgent({
      running: true, chatId, phase: 'plan', step: 0,
      total: active.limit, label: 'Подготовка', paused: false, tasks: [],
      contextWarning: warning ? warning.text : '',
      contextLevel: warning ? warning.level : '',
    });
    if (warning && warning.level === 'critical') {
      Render.toast(warning.text);
    }
    await Store.touchChat(chatId, { status: 'running' });
    const assistantMsg = await Store.addMessage(chatId, {
      role: 'assistant', kind: 'text', text: '', status: 'streaming',
      streaming: true, tools: [],
    });
    try {
      const lastUser = (Store.messages(chatId) || []).filter((m) => m.role === 'user').pop();
      const plainTalk = lastUser ? !needsTools(lastUser.text) : false;
      if (mode === 'chat' || plainTalk) {
        // Простая реплика — обычный ответ без инструментов и без «плана».
        await streamOnce(chatId, assistantMsg, {
          tools: false,
          attachments: latestAttachments(chatId),
          smallTalk: plainTalk,
        });
      } else if (mode === 'plan') {
        await streamOnce(chatId, assistantMsg, {
          tools: false, planOnly: true, attachments: latestAttachments(chatId),
        });
      } else {
        await agentLoop(chatId, assistantMsg);
      }
    } catch (err) {
      await fail(chatId, assistantMsg, err);
    } finally {
      const finishedChat = Store.getChat(chatId);
      if (S.settings.notifications) {
        Native.notify({
          chatId,
          title: finishedChat ? finishedChat.title : 'botCHAT',
          text: lastAssistantText(chatId) || 'Агент завершил работу',
          running: false,
        });
      }
      active = null;
      paused = false;
      Store.setAgent({ running: false, phase: 'idle', label: '', paused: false });
      await Store.updateMessage(chatId, assistantMsg.id, { streaming: false, status: 'done' }, { silent: true });
      await Store.touchChat(chatId, { status: 'idle' });
      await clearPending(chatId);
      await autoTitle(chatId);
      AgentServiceKeepAlive(false, chatId);
      Bus.emit('render');
    }
  };

  const buildFallback = (providerId, modelId) => {
    const chain = (S.settings.fallbackChain || [])
      .map((key) => {
        const idx = key.indexOf('|');
        if (idx < 0) return null;
        return { provider: key.slice(0, idx), id: key.slice(idx + 1) };
      })
      .filter(Boolean);
    for (const profile of ['fast', 'quality', 'cheap']) {
      const value = (S.settings.modelProfiles || {})[profile];
      if (!value) continue;
      const idx = value.indexOf('|');
      if (idx < 0) continue;
      const item = { provider: value.slice(0, idx), id: value.slice(idx + 1) };
      if (!chain.some((c) => c.provider === item.provider && c.id === item.id)) chain.push(item);
    }
    return chain.filter((c) => !(c.provider === providerId && c.id === modelId));
  };

  /**
   * Автоназвание сессии: если чат ещё «Новый чат», берём смысл первого
   * сообщения пользователя и имя модели. Название не перезаписывается,
   * если пользователь задал своё.
   */
  const autoTitle = async (chatId) => {
    const chat = Store.getChat(chatId);
    if (!chat) return;
    const generic = !chat.title || chat.title === 'Новый чат' || chat.title.trim() === '';
    if (!generic || chat.titleLocked) return;
    const list = Store.messages(chatId) || [];
    const firstUser = list.find((m) => m.role === 'user' && (m.text || '').trim());
    if (!firstUser) return;
    const model = chat.model || S.settings.activeModel || '';
    const raw = String(firstUser.text).replace(/\s+/g, ' ').trim();
    const words = raw.split(' ').slice(0, 6).join(' ');
    const short = words.length > 42 ? words.slice(0, 42).trim() + '…' : words;
    const provider = (S.providers || []).find((p) => p.id === (chat.provider || S.settings.activeProvider));
    const modelShort = model ? (model.length > 18 ? model.slice(0, 18) + '…' : model) : '';
    let title = short ? short.charAt(0).toUpperCase() + short.slice(1) : '';
    // Совсем короткие реплики («привет») плохо годятся в название — добавляем модель.
    if (!title || title.split(' ').length < 2) {
      const base = title || (provider ? provider.name : 'Чат');
      title = base + (modelShort ? ' · ' + modelShort : '');
    }
    await Store.touchChat(chatId, { title });
    Bus.emit('chats:changed', S.chats);
    Bus.emit('render');
  };

  const lastAssistantText = (chatId) => {
    const list = Store.messages(chatId);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === 'assistant' && (list[i].text || '').trim()) {
        return U.truncate(list[i].text.replace(/\s+/g, ' ').trim(), 140);
      }
    }
    return '';
  };

  const AgentServiceKeepAlive = (on, chatId) => {
    Native.api(on ? 'agent.start' : 'agent.stop', { chatId });
  };

  const agentLoop = async (chatId, message) => {
    let steps = 0;
    while (steps < active.limit) {
      if (active.cancelled) {
        await appendNote(chatId, message, 'Остановлено пользователем');
        return;
      }
      await waitIfPaused();
      if (active.cancelled) return;
      steps += 1;
      active.step = steps;
      Store.setAgent({ step: steps, total: active.limit, phase: 'tool', label: 'Запрос к модели' });
      const outcome = await streamOnce(chatId, message, { tools: true, toolStep: steps });
      if (!outcome || !outcome.toolCalls || !outcome.toolCalls.length) {
        await appendNote(chatId, message, null);
        return;
      }
      active.context.push({
        role: 'assistant',
        content: outcome.text || '',
        toolCalls: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args || {} })),
      });
      const seenCalls = active.seenCalls || new Set();
      active.seenCalls = seenCalls;
      for (const call of outcome.toolCalls) {
        if (active.cancelled) return;
        await waitIfPaused();
        const signature = call.name + ':' + JSON.stringify(call.args || {});
        if (seenCalls.has(signature)) {
          // Модель повторяет тот же вызов — не зацикливаемся.
          await appendNote(chatId, message, 'Остановка: повторяющийся вызов ' + call.name);
          return;
        }
        seenCalls.add(signature);
        const tool = await addToolCard(chatId, message, call);
        Store.setAgent({ phase: 'tool', label: call.name + ': ' + summaryOf(call), step: steps, total: active.limit });
        const result = await executeTool(chatId, message, call, tool);
        if (result && result.checkpoint) {
          await Store.updateMessage(chatId, message.id, { checkpoint: result.checkpoint }, { silent: true });
        }
        active.context.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: (result && (result.output || result.error)) || '',
        });
      }
    }
    await appendNote(chatId, message, 'Достигнут лимит шагов (' + active.limit + ')');
    await Store.touchChat(chatId, { status: 'idle' });
  };

  const waitIfPaused = async () => {
    if (!paused) return;
    Store.setAgent({ paused: true, label: 'Пауза' });
    await new Promise((resolve) => {
      pauseWaiter = resolve;
    });
    pauseWaiter = null;
    Store.setAgent({ paused: false });
  };

  const togglePause = () => {
    if (!active) return;
    paused = !paused;
    Native.api(paused ? 'agent.pause' : 'agent.resume', { chatId: active.chatId });
    if (!paused && pauseWaiter) pauseWaiter();
    Store.setAgent({ paused });
  };

  const stop = () => {
    if (active) {
      active.cancelled = true;
      Native.api('agent.stop', { chatId: active.chatId });
    }
    if (pauseWaiter) pauseWaiter();
    Native.api('chat.cancel', { chatId: S.chatId });
    Store.setAgent({ running: false, phase: 'idle', label: '' });
    Store.touchChat(S.chatId, { status: 'idle' });
  };

  const fail = async (chatId, message, err) => {
    const text = String(err && err.message ? err.message : err || 'Ошибка');
    const lastUser = (Store.messages(chatId) || []).filter((m) => m.role === 'user').pop();
    if (lastUser && lastUser.text) await rememberPending(chatId, lastUser.text);
    await Store.updateMessage(chatId, message.id, {
      streaming: false, error: text, status: 'error',
      text: (message.text || '') + '\n\n' + 'Не удалось получить ответ: ' + text,
    });
    Store.setAgent({ running: false, phase: 'error', label: '' });
  };

  const appendNote = async (chatId, message, note) => {
    if (note) {
      await Store.updateMessage(chatId, message.id, {
        text: (message.text || '') + (message.text ? '\n\n' : '') + '— ' + note,
      }, { silent: true });
    }
  };

  const latestAttachments = (chatId) => {
    const list = Store.messages(chatId);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].role === 'user') return list[i].attachments || [];
    }
    return [];
  };

  const contextUsage = (chatId) => {
    const chat = Store.getChat(chatId);
    const list = Store.messages(chatId);
    const estimate = list.reduce((sum, m) => sum + Math.ceil((m.text || '').length / 4), 0);
    const model = (S.models || []).find((m) => m.id === (chat && (chat.model || S.settings.activeModel)));
    const limit = (model && model.context) || 128000;
    return { tokens: estimate, limit, ratio: estimate / limit };
  };

  const warnContext = (chatId) => {
    const usage = contextUsage(chatId);
    if (usage.ratio >= 0.95) {
      return { level: 'critical', text: 'Контекст почти исчерпан (' + Math.round(usage.ratio * 100) + '%). Сожмите сессию.' };
    }
    if (usage.ratio >= 0.8) {
      return { level: 'warn', text: 'Контекст заполнен на ' + Math.round(usage.ratio * 100) + '%.' };
    }
    return null;
  };

  /** Запоминает незавершённое действие, чтобы следующий запрос его продолжил. */
  const rememberPending = async (chatId, text) => {
    const chat = Store.getChat(chatId);
    if (!chat) return;
    await Store.touchChat(chatId, { pendingTask: (text || '').slice(0, 300) });
  };

  const clearPending = async (chatId) => {
    await Store.touchChat(chatId, { pendingTask: '' });
  };

  const pendingTask = (chatId) => {
    const chat = Store.getChat(chatId);
    return (chat && chat.pendingTask) || '';
  };

  const buildContext = (chatId, options) => {
    const chat = Store.getChat(chatId);
    if (options && options.storage == null) {
      options.storage = { active: S.storageActive || '' };
    }
    if (options && options.pendingTask == null) {
      options.pendingTask = pendingTask(chatId);
    }
    if (active && active.context && active.context.length > 0) {
      // Внутри агентского цикла контекст уже собран с tool_calls — берём его как есть.
      const system = systemPrompt(chat, options || {});
      return { system, history: active.context.slice(), chat };
    }
    const list = Store.messages(chatId);
    const keep = (options && options.keep) || S.compactKeep || 40;
    const history = list
      .filter((m) => m.kind === 'text' && m.role !== 'system' && (m.text || '').trim())
      .slice(-keep)
      .map((m) => ({ role: m.role, content: m.text }));
    const system = systemPrompt(chat, options || {});
    return { system, history, chat };
  };

  /**
   * Системная инструкция. Приоритет — обычный разговор.
   * Инструменты упоминаются как возможность, а не как обязательный сценарий:
   * иначе модель на «привет» отвечает «дай задание» и начинает «план».
   */
  /**
   * Системная инструкция.
   *
   * Три принципа:
   *  1) обычный разговор — приоритет; инструменты не навязываются;
   *  2) инструменты вызываются только когда без них задачу не выполнить;
   *  3) факты о проекте берутся из инструментов, а не из памяти модели.
   */
  /**
   * Системная инструкция собирается из независимых блоков:
   * роль → разговор → проект (только если инструменты доступны) → ограничения → режим.
   * Так в обычном чате нет упоминания инструментов, а в агентском режиме
   * есть чёткое правило «сначала прочитай, потом меняй».
   */
  /**
   * Системная инструкция.
   *
   * Ключевые правила (по итогам реальных сбоев):
   *  1) действие выполняется инструментом, а не описывается словами;
   *  2) в ответе один достоверный статус: выполнено / не выполнено / ждёт подтверждения;
   *  3) результат инструмента важнее догадок;
   *  4) при сбое — «что просили → что помешало → что нужно от пользователя».
   */
  const systemPrompt = (chat, options) => {
    const toolsAvailable = options.tools !== false && !options.planOnly;
    const folder = chat.projectFolder || (options.storage && options.storage.active) || '';
    const parts = [];

    parts.push(
      'Ты — botCHAT, помощник в мессенджере на телефоне. ' +
      'С тобой можно просто поговорить или поручить работу с файлами.'
    );

    parts.push([
      'Разговор:',
      '— отвечай на заданный вопрос, без вступлений и без списка «чем я могу помочь»;',
      '— приветствие, вопрос о тебе, объяснение, мнение — обычный ответ, инструменты не нужны;',
      '— пиши кратко, на языке пользователя; код — блоками с языком.',
    ].join('\n'));

    if (toolsAvailable) {
      parts.push([
        'Работа с файлами:',
        folder ? '— рабочая папка: ' + folder + ';' : '— рабочая папка чата;',
        '— инструменты: list, read, write, edit, grep, glob, bash, webfetch, todo, task;',
        '',
        'Главное правило: если просят сделать действие — ВЫПОЛНИ ЕГО ИНСТРУМЕНТОМ.',
        'Нельзя отвечать «файл создан» или «папка содержит…», если инструмент не вызывался.',
        'Если инструмент вернул ошибку — не выдумывай результат и не подменяй его рассказом.',
        '',
        'Порядок работы:',
        '1. Неясный путь — сначала list нужной папки, потом действие.',
        '2. write: передай полный путь и содержимое. После записи проверь размер в ответе инструмента.',
        '3. edit: сначала read, затем точный oldString из прочитанного текста.',
        '4. Никогда не угадывай содержимое файла — читай его.',
        '5. Результат инструмента важнее любых ожиданий: опирайся на поле output.',
      ].join('\n'));

      parts.push([
        'Статус в ответе (обязательно одно из трёх):',
        '— «Готово: …» + путь и размер, если инструмент вернул ok;',
        '— «Ждёт подтверждения: …» если действие требует разрешения и пользователь ещё не ответил;',
        '— «Не выполнено: …» если инструмент вернул ошибку.',
        'Не смешивай статусы в одном ответе. Один ответ — один статус.',
      ].join('\n'));

      parts.push([
        'Если действие невозможно, ответь по схеме:',
        '1) Что просили (одна строка).',
        '2) Что помешало (точная причина из инструмента).',
        '3) Что нужно от пользователя (одно конкретное действие).',
      ].join('\n'));

      parts.push([
        'Пути:',
        '— «Downloads» / «Загрузки» = /storage/emulated/0/Download;',
        '— «~» = корень памяти устройства;',
        '— относительный путь считается от рабочей папки;',
        '— если папка вне доступа, скажи об этом и подскажи открыть карточку чата → Рабочая папка.',
      ].join('\n'));
    }

    parts.push([
      'Ограничения:',
      '— не выдумывай пути, имена файлов, команды и их вывод;',
      '— не пиши «сделал», если действие не выполнено;',
      '— после ошибки не повторяй тот же вызов без изменений;',
      toolsAvailable
        ? '— запись, bash и сеть выполняй только после подтверждения пользователя.'
        : '— если нужен доступ к файлам, скажи об этом прямо.',
    ].join('\n'));

    if (options.pendingTask) {
      parts.push(
        'Незавершённая задача из прошлого запроса: ' + options.pendingTask +
        '. Если пользователь повторяет просьбу — продолжай её, а не начинай заново.'
      );
    }

    if (options.planOnly) {
      parts.push('Режим планирования: опиши шаги словами, инструменты не вызывай.');
    }
    if (options.tools === false && !options.planOnly) {
      parts.push('Инструменты сейчас недоступны: ответь текстом, своими знаниями.');
    }
    if (options.smallTalk) {
      parts.push('Это обычная беседа: просто ответь на реплику.');
    }
    return parts.join('\n\n');
  };

  /**
   * Нужны ли инструменты для этой реплики.
   * Логика обратная: инструменты включаются только когда в тексте есть
   * явная работа с проектом/командами. Всё остальное — обычный разговор.
   */
  const needsTools = (text) => {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return false;
    if (t.length > 400) return true;
    const taskWords = [
      'файл', 'папк', 'проект', 'репозитор', 'код', 'скрипт', 'конфиг',
      'исправ', 'сделай', 'добав', 'удали', 'переимен', 'перемест',
      'запусти', 'выполни', 'терминал', 'команд', 'bash', 'shell',
      'git ', 'коммит', 'ветк', 'тест', 'рефактор', 'найди в', 'поиск по',
      'создай', 'сгенерируй', 'проверь сборк', 'собери', 'установи', 'прочитай',
      'открой файл', 'покажи файл', 'посмотри файл', 'проверь код',
      'file', 'folder', 'project', 'code', 'fix', 'refactor', 'grep',
      'run tests', 'build', 'install', 'read file', 'open file', '.js', '.ts',
      '.kt', '.py', '.json', '.md', '/src', 'src/',
    ];
    if (taskWords.some((w) => t.includes(w))) return true;
    // Явная просьба что-то сделать с проектом.
    if (/\b(сделай|создай|измени|обнови|поправь|почини)\b/.test(t)) return true;
    return false;
  };

  /** Совместимость с прежним именем: «просто разговор» = инструменты не нужны. */
  const isSmallTalk = (text) => !needsTools(text);
  const streamOnce = async (chatId, message, options) => {
    const ctx = buildContext(chatId, options);
    const chat = ctx.chat;
    const providerId = chat.provider || S.settings.activeProvider;
    const modelId = chat.model || S.settings.activeModel;
    const images = [];
    if (options.attachments && options.attachments.length) {
      options.attachments.forEach((att) => {
        if ((att.mime || '').startsWith('image/') && att.dataUrl) {
          images.push({ mime: att.mime, dataUrl: att.dataUrl });
        }
      });
    }
    const requestId = U.uid('req');
    const fallback = buildFallback(providerId, modelId);
    let buffer = '';
    let toolCalls = [];
    let finished = false;

    if (!modelId) {
      throw new Error('Модель не выбрана. Откройте «Модель» и выберите провайдера.');
    }

    if (images.length) {
      const last = ctx.history[ctx.history.length - 1];
      if (last) last.images = images;
    }

    let sawDelta = false;
    let lastActivityAt = Date.now();
    const offDelta = Native.on('llm.delta', (payload) => {
      if (!payload || payload.requestId !== requestId) return;
      sawDelta = true;
      lastActivityAt = Date.now();
      buffer += payload.text || '';
      ChatStream.update(chatId, message.id, buffer);
    });
    const offTool = Native.on('llm.tool', (payload) => {
      if (!payload || payload.requestId !== requestId) return;
      toolCalls = payload.calls || [];
    });
    const offDone = Native.on('llm.done', (payload) => {
      if (!payload || payload.requestId !== requestId) return;
      finished = true;
    });
    const offStop = Native.on('llm.stop', (payload) => {
      if (!payload || payload.requestId !== requestId) return;
      finished = true;
    });
    const offError = Native.on('llm.error', (payload) => {
      if (!payload || payload.requestId !== requestId) return;
      finished = true;
      lastError = payload.message || 'Провайдер недоступен';
    });
    const offNotice = Native.on('llm.notice', (payload) => {
      if (!payload || payload.requestId !== requestId) return;
      ChatStream.notice(chatId, message.id, payload.message || '');
    });
    const offModel = Native.on('llm.model', (payload) => {
      if (!payload || payload.requestId !== requestId) return;
      if (payload.provider === providerId && payload.model === modelId) return;
      const provider = (S.providers || []).find((p) => p.id === payload.provider);
      const label = (provider ? provider.name + ' · ' : '') + payload.model;
      ChatStream.switched(chatId, message.id, label);
    });

    let lastError = null;
    ChatStream.status(chatId, message.id, 'Думает…');
    const stalledTimer = setInterval(() => {
      if (finished) return;
      const idle = Date.now() - lastActivityAt;
      if (idle > 20000) {
        ChatStream.status(chatId, message.id, 'Долго не отвечает (' + Math.round(idle / 1000) + ' с)…');
      } else if (sawDelta) {
        ChatStream.status(chatId, message.id, 'Отвечает…');
      }
    }, 1000);

    const res = await Native.api('chat.start', {
      requestId,
      chatId,
      providerId,
      modelId,
      system: ctx.system,
      messages: ctx.history,
      tools: options.tools !== false,
      planOnly: !!options.planOnly,
      maxSteps: active ? active.limit : 1,
      step: options.toolStep || 0,
      fallbackModels: fallback,
      images: options.images || [],
    });
    if (!res || !res.ok) {
      offDelta(); offTool(); offDone(); offError();
      throw new Error((res && res.error) || 'Не удалось начать запрос');
    }

    const deadline = Date.now() + 300000;
    while (!finished && Date.now() < deadline) {
      if (active && active.cancelled) {
        Native.api('chat.cancel', { chatId });
        break;
      }
      await U.sleep(120);
    }
    clearInterval(stalledTimer);
    ChatStream.status(chatId, message.id, '');
    offDelta(); offTool(); offDone(); offError(); offNotice(); offModel(); offStop();

    ChatStream.status(chatId, message.id, '');
    if (buffer.trim()) {
      ChatStream.finish(message.id, buffer.trim());
    }
    if (lastError && !buffer.trim() && !toolCalls.length) throw new Error(lastError);
    if (buffer.trim() || toolCalls.length) {
      await Store.updateMessage(chatId, message.id, { text: buffer.trim(), streaming: false }, { silent: true });
    }
    if (toolCalls.length) {
      return { text: buffer, toolCalls };
    }
    if (!buffer.trim()) {
      await Store.updateMessage(chatId, message.id, {
        text: 'Модель вернула пустой ответ. Попробуйте другую модель.',
      }, { silent: true });
    }
    return { text: buffer, toolCalls: [] };
  };

  const addToolCard = async (chatId, message, call) => {
    let baseId = call.id || U.uid('tool');
    const used = new Set((message.tools || []).map((t) => t.id));
    let toolId = baseId;
    let suffix = 1;
    while (used.has(toolId)) {
      toolId = baseId + '_' + suffix;
      suffix += 1;
    }
    const tool = {
      id: toolId,
      name: call.name,
      input: call.args || {},
      output: '',
      metadata: {},
      state: { status: 'pending', error: null },
      startedAt: Date.now(),
    };
    if (!message.tools) message.tools = [];
    message.tools.push(tool);
    await Store.updateMessage(chatId, message.id, { tools: message.tools.slice() }, { silent: true });
    Bus.emit('render');
    return tool;
  };

  const findToolHost = (chatId, tool) => {
    const list = Store.messages(chatId);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const msg = list[i];
      if (msg.tools && msg.tools.some((t) => t.id === tool.id)) return msg;
    }
    return null;
  };

  const updateTool = async (chatId, message, tool, patch) => {
    Object.assign(tool, patch);
    const host = message || findToolHost(chatId, tool);
    if (!host) return;
    await Store.updateMessage(chatId, host.id, { tools: host.tools.slice() }, { silent: true });
    Bus.emit('render');
  };

  const summaryOf = (call) => {
    const args = call.args || {};
    return U.truncate(args.path || args.command || args.pattern || args.url || args.description || '', 50);
  };

  const executeTool = async (chatId, message, call, tool) => {
    await updateTool(chatId, null, tool, { state: { status: 'running', error: null } });
    const chat = Store.getChat(chatId);
    const needsPermission = ['bash', 'write', 'edit', 'webfetch'].includes(call.name);
    const trusted = chat && (chat.autoApprove === 'always' || (S.settings.trustChats || []).includes(chatId));
    if (needsPermission && !trusted) {
      const decision = await requestPermission(call, chatId);
      if (decision === 'deny') {
        await setToolDone(chatId, tool, {
          output: 'Отклонено пользователем',
          state: { status: 'error', error: 'denied' },
        });
        const lastUser = (Store.messages(chatId) || []).filter((m) => m.role === 'user').pop();
        if (lastUser && lastUser.text) await rememberPending(chatId, lastUser.text);
        return { denied: true, status: 'not_done' };
      }
      if (decision === 'always') {
        S.settings.trustChats = Array.from(new Set([...(S.settings.trustChats || []), chatId]));
        Settings.write(S.settings);
      }
    }
    if (['write', 'edit'].includes(call.name) && active && !active.checkpointed) {
      active.checkpointed = true;
      const snap = await Native.api('checkpoints.create', {
        chatId,
        reason: 'перед ' + call.name + ': ' + ((call.args || {}).path || ''),
      });
      if (snap && snap.id) {
        active.checkpointId = snap.id;
        await Store.updateMessage(chatId, message.id, { checkpoint: snap.id }, { silent: true });
      }
    }
    try {
      const res = await Native.tool(call.name, Object.assign({ chatId }, call.args || {}));
      if (!res || res.ok === false && res.error) {
        await setToolDone(chatId, tool, {
          output: (res && res.output) || '',
          state: { status: 'error', error: (res && res.error) || 'tool failed' },
          metadata: (res && res.metadata) || {},
        });
        return res;
      }
      await setToolDone(chatId, tool, {
        output: (res && res.output) || '',
        metadata: (res && res.metadata) || {},
        state: { status: 'completed', error: null },
      });
      if (res && res.todos) {
        active.todos = res.todos;
        Store.setAgent({ todos: res.todos });
      }
      if (res && res.task) {
        active.tasks.push(res.task);
        Store.setAgent({ tasks: active.tasks.slice() });
      }
      return res;
    } catch (err) {
      await setToolDone(chatId, tool, {
        state: { status: 'error', error: String(err && err.message ? err.message : err) },
      });
      return { ok: false };
    }
  };

  const setToolDone = async (chatId, tool, patch) => {
    Object.assign(tool, patch, { finishedAt: Date.now() });
    const chatIdSafe = chatId || S.chatId;
    const list = Store.messages(chatIdSafe);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const msg = list[i];
      if (msg.tools && msg.tools.some((t) => t.id === tool.id)) {
        await Store.updateMessage(chatIdSafe, msg.id, { tools: msg.tools.slice() }, { silent: true });
        break;
      }
    }
    Bus.emit('render');
  };

  const requestPermission = (call, chatId) => {
    return new Promise((resolve) => {
      S.pending = { type: 'permission', call, chatId };
      Store.publishState();
      Bus.emit('permission:changed', S.pending);
      Bus.emit('render');
      S.permissionResolver = (decision) => {
        S.pending = null;
        S.permissionResolver = null;
        Store.publishState();
        Bus.emit('permission:changed', null);
        resolve(decision);
      };
    });
  };

  const continueGeneration = async (chatId) => {
    if (S.agent.running) return;
    const list = Store.messages(chatId);
    const last = list[list.length - 1];
    if (last && last.role === 'assistant') {
      await Store.updateMessage(chatId, last.id, { text: (last.text || '') + '\n\n' + 'Продолжи с того места, где остановился.', streaming: false }, { silent: true });
    }
    await run(chatId);
  };

  const regenerate = async (chatId, messageId) => {
    const list = Store.messages(chatId);
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const target = list[idx];
    await Store.updateMessage(chatId, messageId, {
      text: '', tools: [], streaming: true, status: 'streaming', error: null,
    });
    Store.setAgent({ running: true, chatId, phase: 'plan', step: 0, total: 30, label: 'Перегенерация' });
    try {
      await streamOnce(chatId, target, { tools: (Store.getChat(chatId) || {}).mode !== 'chat' });
    } catch (err) {
      await fail(chatId, target, err);
    } finally {
      await Store.updateMessage(chatId, messageId, { streaming: false, status: 'done' }, { silent: true });
      Store.setAgent({ running: false, phase: 'idle', label: '' });
      Bus.emit('render');
    }
  };

  const cancelActive = () => {
    if (active) active.cancelled = true;
  };

  return {
    send, run, stop, togglePause, flushQueue, continueGeneration, regenerate,
    executeTool, cancelActive, contextUsage, isSmallTalk, needsTools, autoTitle,
    rememberPending, clearPending, pendingTask,
    systemPrompt, buildContext,
    get active() { return active; },
  };
})();

window.Agent = Agent;