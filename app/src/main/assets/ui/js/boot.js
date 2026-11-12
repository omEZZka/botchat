'use strict';

/**
 * Загрузка: онбординг, восстановление состояния, сеть, очередь, интенты.
 */
const Boot = (() => {
  const stage = (text, progress) => {
    try {
      Native.call('boot', { stage: text, progress });
      const node = document.getElementById('boot-stage');
      if (node) node.textContent = text + ' · ' + progress + '%';
      const bar = document.getElementById('boot-bar');
      if (bar) bar.style.width = progress + '%';
    } catch (_) {
      /* индикатор не критичен для работы */
    }
  };

  const withTimeout = (promise, ms, fallback) => Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);

  const logError = (where, err) => {
    try {
      Native.call('log', {
        level: 'error',
        message: where + ': ' + (err && err.message ? err.message : String(err)),
        source: 'boot.js',
        line: 0,
      });
    } catch (_) {
      /* логирование не должно ломать запуск */
    }
  };

  const start = async () => {
    document.documentElement.dataset.theme = S.settings.theme || 'dark';
    Accent.apply();
    stage('Настройки', 8);
    S.env = await withTimeout(Native.env(), 4000, { versionName: '—', rootfs: false });
    Prefs.apply();

    Bus.on('network:changed', (online) => {
      S.online = online;
      Render.render();
    });
    window.addEventListener('online', () => Store.setOnline(true));
    window.addEventListener('offline', () => Store.setOnline(false));
    Native.on('net.changed', (payload) => Store.setOnline(!!(payload && payload.online)));

    Native.on('agent.status', (payload) => {
      if (!payload) return;
      if (payload.chatId && payload.chatId === S.chatId) {
        Store.setAgent({
          running: !!payload.running,
          step: payload.step || 0,
          total: payload.total || 0,
          label: payload.label || '',
        });
      }
      if (payload.finished && S.settings.notifications) {
        const chat = Store.getChat(payload.chatId);
        Native.notify({
          chatId: payload.chatId,
          title: chat ? chat.title : 'botCHAT',
          text: payload.text || 'Агент завершил работу',
          running: false,
        });
      }
    });

    Native.on('picked', (payload) => {
      Bus.emit('native:picked', payload);
    });

    stage('Провайдеры', 26);
    try {
      await withTimeout(ProvidersUI.load(), 6000, null);
    } catch (err) {
      logError('providers', err);
    }
    stage('История чатов', 48);
    try {
      await withTimeout(Store.load(), 12000, null);
    } catch (err) {
      logError('history', err);
    }
    stage('Восстановление состояния', 72);
    try {
      await withTimeout(restoreAgentState(), 5000, null);
    } catch (err) {
      logError('restore', err);
    }
    Bus.emit('queue:flush');

    if (!S.booted) {
      S.booted = true;
      if (!S.chats.length) {
        S.screen = 'list';
      }
    }
    stage('Интерфейс', 88);
    Render.bind();
    Render.render();
    stage('Готово', 100);
    Native.call('ready', {});

    if (!S.settings.onboarded) {
      try {
        Onboarding.open();
      } catch (err) {
        console.error('onboarding failed', err);
        S.settings.onboarded = true;
        Settings.write(S.settings);
      }
    }

    const chatId = new URLSearchParams(location.search).get('chat');
    if (chatId && Store.getChat(chatId)) await Store.openChat(chatId);

    setInterval(() => {
      Store.publishState();
    }, 15000);
    Store.publishState();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        Store.setOnline(navigator.onLine !== false);
        Bus.emit('queue:flush');
        ProvidersUI.load().then(() => Render.render());
      }
    });

    Bus.on('queue:flush', () => {
      if (S.online) Agent.flushQueue();
    });

    S.booted = true;
  };

  const restoreAgentState = async () => {
    if (!S.chatId) return;
    const res = await Native.api('agent.state', { chatId: S.chatId });
    if (!res || !res.ok) return;
    if (res.phase && res.phase !== 'idle' && res.phase !== 'done') {
      Store.setAgent({
        running: true,
        chatId: S.chatId,
        step: res.step || 0,
        total: res.limit || S.settings.stepLimit,
        label: 'Восстановлено: ' + (res.label || 'шаг'),
        paused: !!res.paused,
      });
    }
    const report = await Native.api('agent.report', { chatId: S.chatId });
    if (report && report.ok && report.report) {
      S.agent.report = report.report;
    }
  };

  return { start, restoreAgentState };
})();

/**
 * Онбординг: приветствие и выбор провайдера. Без ключа доступен OpenCode Zen.
 */
const Onboarding = (() => {
  const open = () => {
    const steps = [];
    let index = 0;
    const host = U.$('#sheet-host');
    const sheet = U.el('div', { class: 'onboarding' });
    const body = U.el('div', { class: 'onboarding-body' });
    sheet.appendChild(body);
    const backdrop = U.el('div', { class: 'sheet-backdrop open' });
    host.appendChild(backdrop);
    host.appendChild(sheet);

    const finish = () => {
      S.settings.onboarded = true;
      S.settings.onboardedAt = Date.now();
      Settings.write(S.settings);
      sheet.remove();
      backdrop.remove();
      Render.render();
    };

    const renderStep = () => {
      U.clear(body);
      const step = steps[index];
      body.appendChild(U.el('div', { class: 'onboarding-logo', html: Icons.html('sparkle', 44) }));
      body.appendChild(U.el('h2', { text: step.title }));
      step.lines.forEach((line) => body.appendChild(U.el('p', { class: 'onboarding-line', text: line })));
      if (step.render) step.render(body, next);
      body.appendChild(U.el('div', { class: 'onboarding-actions' }, [
        index > 0 ? U.el('button', { class: 'btn', text: 'Назад', onclick: prev }) : null,
        U.el('button', {
          class: 'btn primary', text: index === steps.length - 1 ? 'Начать' : 'Далее',
          onclick: () => (index === steps.length - 1 ? finish() : next()),
        }),
      ]));
    };

    const next = () => {
      index = Math.min(steps.length - 1, index + 1);
      renderStep();
    };
    const prev = () => {
      index = Math.max(0, index - 1);
      renderStep();
    };

    steps.push({
      title: 'botCHAT',
      lines: [
        'Мессенджер с ИИ-собеседниками, которые читают и правят файлы, запускают команды и ищут по коду.',
        'Интерфейс как в Telegram, поведение как у агента: план → инструмент → результат.',
      ],
    });

    steps.push({
      title: 'Провайдер и ключ',
      lines: [
        'Модели облачные: ключ хранится только на устройстве в Android Keystore.',
        'Без ключа доступен OpenCode Zen с бесплатными моделями.',
      ],
      render: (node, done) => {
        const select = U.el('select', { class: 'field' }, (S.providers || []).map((p) => U.el('option', {
          value: p.id,
          text: p.name + (p.needsKey ? '' : ' · без ключа'),
          selected: p.id === (S.settings.activeProvider || 'opencode') ? 'selected' : null,
        })));
        U.$$('option[selected]', select).forEach((o) => { select.value = o.value; });
        const key = U.el('input', { class: 'field', type: 'password', placeholder: 'API-ключ (можно пропустить для OpenCode Zen)' });
        const row = U.el('div', { class: 'onboarding-form' }, [
          U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Провайдер' }), select]),
          U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Ключ' }), key]),
          U.el('button', {
            class: 'btn', text: 'Сохранить ключ',
            onclick: async () => {
              const providerId = select.value;
              S.settings.activeProvider = providerId;
              Settings.write(S.settings);
              if (key.value.trim()) {
                const res = await Native.api('keys.add', { providerId, key: key.value.trim(), label: 'онбординг' });
                Render.toast(res && res.ok ? 'Ключ сохранён' : 'Ошибка сохранения ключа');
                await ProvidersUI.load();
                const models = await Native.api('models.refresh');
                if (models && models.ok) {
                  S.models = models.models || S.models;
                  const first = (S.models || [])[0];
                  if (first) {
                    S.settings.activeModel = first.id;
                    S.settings.activeProvider = first.provider || providerId;
                    Settings.write(S.settings);
                    Render.toast('Модель: ' + (first.name || first.id));
                  }
                }
              } else {
                Render.toast('Провайдер выбран');
              }
            },
          }),
        ]);
        node.appendChild(row);
      },
    });

    steps.push({
      title: 'Как это работает',
      lines: [
        'Каждый чат — отдельный проект со своей папкой и чекпоинтами.',
        'Опасные действия (команды, запись файлов, сеть) требуют разрешения.',
        'История и файлы доступны офлайн, новые ответы — при подключении.',
      ],
    });

    void next;
  };

  return { open };
})();

/**
 * Пользовательские предпочтения на уровне документа.
 */
const Prefs = (() => {
  const apply = () => {
    const root = document.documentElement;
    root.dataset.theme = S.settings.theme || 'dark';
    root.dataset.motion = S.settings.reduceMotion ? 'reduced' : '';
    root.dataset.accent = S.settings.accent || 'blue';
    if (S.settings.reduceMotion) {
      root.style.setProperty('--motion', '0ms');
    } else {
      root.style.removeProperty('--motion');
    }
  };
  return { apply };
})();

window.Boot = Boot;
window.Onboarding = Onboarding;
window.Prefs = Prefs;