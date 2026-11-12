'use strict';

/**
 * Движок агентского цикла: plan → tool_call → result → continue.
 * Шаги сериализуются в steps.jsonl, состояние переживает перезапуск.
 * Сеть — только через Native.api (Kotlin), инструменты — через Native.tool.
 */
const Agent = (() => {
  const MAX_STEPS = 200;
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
    startedAt: Date.now(),
  });

  const send = async (chatId, payload) => {
    const chat = Store.getChat(chatId);
    if (!chat) return;
    if (!S.online) {
      await Store.addMessage(chatId, {
        role: 'user', kind: 'text', text: payload.text || '',
        attachments: payload.attachments || [], status: 'queued',
        replyTo: payload.replyTo || null,
      });
      Store.enqueue(chatId, payload);
      await Store.touchChat(chatId, { status: 'queued' });
      Render.toast('Нет сети: сообщение в очереди');
      return;
    }
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
    const items = S.queue.slice();
    for (const item of items) {
      if (!S.online) break;
      Store.dequeue(item.id);
      const list = Store.messages(item.chatId);
      const last = list.filter((m) => m.role === 'user' && m.status === 'queued').pop();
      if (last) await Store.updateMessage(item.chatId, last.id, { status: 'delivered' }, { silent: true });
      if (!S.agent.running) await run(item.chatId);
    }
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
    Store.setAgent({
      running: true, chatId, phase: 'plan', step: 0,
      total: active.limit, label: 'Подготовка', paused: false, tasks: [],
    });
    await Store.touchChat(chatId, { status: 'running' });
    const assistantMsg = await Store.addMessage(chatId, {
      role: 'assistant', kind: 'text', text: '', status: 'streaming',
      streaming: true, tools: [],
    });
    try {
      if (mode === 'chat') {
        await streamOnce(chatId, assistantMsg, { tools: false });
      } else if (mode === 'plan') {
        await streamOnce(chatId, assistantMsg, { tools: false, planOnly: true });
      } else {
        await agentLoop(chatId, assistantMsg);
      }
    } catch (err) {
      await fail(chatId, assistantMsg, err);
    } finally {
      active = null;
      paused = false;
      Store.setAgent({ running: false, phase: 'idle', label: '', paused: false });
      await Store.updateMessage(chatId, assistantMsg.id, { streaming: false, status: 'done' }, { silent: true });
      await Store.touchChat(chatId, { status: 'idle' });
      AgentServiceKeepAlive(false, chatId);
      Bus.emit('render');
    }
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
      for (const call of outcome.toolCalls) {
        if (active.cancelled) return;
        await waitIfPaused();
        const tool = await addToolCard(chatId, message, call);
        Store.setAgent({ phase: 'tool', label: call.name + ': ' + summaryOf(call), step: steps, total: active.limit });
        const result = await executeTool(chatId, call, tool);
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

  const buildContext = (chatId, options) => {
    const chat = Store.getChat(chatId);
    if (active && active.context) {
      const system = systemPrompt(chat, options || {});
      return { system, history: active.context.slice(), chat };
    }
    const list = Store.messages(chatId);
    const keep = (options && options.keep) || 40;
    const history = list
      .filter((m) => m.kind === 'text' && m.role !== 'system' && (m.text || '').trim())
      .slice(-keep)
      .map((m) => ({ role: m.role, content: m.text }));
    const system = systemPrompt(chat, options || {});
    return { system, history, chat };
  };

  const systemPrompt = (chat, options) => {
    const folder = chat.projectFolder || 'папка чата';
    const lines = [
      'Ты — botCHAT, агент в мобильном мессенджере. Работаешь в песочнице проекта: ' + folder + '.',
      'Доступные инструменты: read, write, edit, bash, grep, glob, list, webfetch, todo, task.',
      'Правила: сначала составь короткий план, затем вызывай инструменты по одному. Не выдумывай содержимое файлов — читай их.',
      'Опасные действия (bash, запись/правка вне проекта, сеть) требуют подтверждения пользователя.',
      'Отвечай кратко и по делу на языке пользователя. Форматируй код в блоках с указанием языка.',
    ];
    if (options.planOnly) lines.push('Режим «план»: только план, без вызова инструментов.');
    if (options.tools === false) lines.push('Режим «чат»: инструменты недоступны, только ответ текстом.');
    return lines.join('\n');
  };

  const streamOnce = async (chatId, message, options) => {
    const ctx = buildContext(chatId, options);
    const chat = ctx.chat;
    const providerId = chat.provider || S.settings.activeProvider;
    const modelId = chat.model || S.settings.activeModel;
    const requestId = U.uid('req');
    let buffer = '';
    let toolCalls = [];
    let finished = false;

    if (!modelId) {
      throw new Error('Модель не выбрана. Откройте «Модель» и выберите провайдера.');
    }

    const offDelta = Native.on('llm.delta', (payload) => {
      if (!payload || payload.requestId !== requestId) return;
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
    const offError = Native.on('llm.error', (payload) => {
      if (!payload || payload.requestId !== requestId) return;
      finished = true;
      lastError = payload.message || 'Ошибка провайдера';
    });

    let lastError = null;
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
    });
    if (!res || !res.ok) {
      offDelta(); offTool(); offDone(); offError();
      throw new Error((res && res.error) || 'Не удалось начать запрос');
    }

    const deadline = Date.now() + 180000;
    while (!finished && Date.now() < deadline) {
      if (active && active.cancelled) {
        Native.api('chat.cancel', { chatId });
        break;
      }
      await U.sleep(120);
    }
    offDelta(); offTool(); offDone(); offError();

    if (lastError) throw new Error(lastError);
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
    const list = message.tools || [];
    list.push(tool);
    await Store.updateMessage(chatId, message.id, { tools: list }, { silent: true });
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
    await Store.updateMessage(chatId, host.id, { tools: host.tools }, { silent: true });
    Bus.emit('render');
  };

  const summaryOf = (call) => {
    const args = call.args || {};
    return U.truncate(args.path || args.command || args.pattern || args.url || args.description || '', 50);
  };

  const executeTool = async (chatId, call, tool) => {
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
        return { denied: true };
      }
      if (decision === 'always') {
        S.settings.trustChats = Array.from(new Set([...(S.settings.trustChats || []), chatId]));
        Settings.write(S.settings);
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
        await Store.updateMessage(chatIdSafe, msg.id, { tools: msg.tools }, { silent: true });
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
    executeTool, cancelActive, MAX_STEPS,
    get active() { return active; },
  };
})();

window.Agent = Agent;