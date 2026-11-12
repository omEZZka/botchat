'use strict';

/**
 * Шторки выбора: модель, провайдер, настройки чата, приложения, экспорт.
 */
const Pickers = (() => {
  const chatSettings = () => {
    const chat = Store.getChat(S.chatId);
    if (!chat) return;
    const folderInput = U.el('input', { class: 'field', value: chat.projectFolder || '', placeholder: 'projects/my-app' });
    const limitInput = U.el('input', { class: 'field', type: 'number', min: '1', max: '200', value: String(chat.stepLimit || S.settings.stepLimit) });
    const modeSelect = U.el('select', { class: 'field' }, ['chat', 'agent', 'plan'].map((m) => U.el('option', {
      value: m,
      text: { chat: 'Чат (без инструментов)', agent: 'Агент (полный цикл)', plan: 'План' }[m],
      selected: (chat.mode || 'agent') === m ? 'selected' : null,
    })));
    U.$$('option[selected]', modeSelect).forEach((o) => { modeSelect.value = o.value; });
    const approveSelect = U.el('select', { class: 'field' }, ['ask', 'always'].map((m) => U.el('option', {
      value: m,
      text: m === 'ask' ? 'Спрашивать' : 'Доверять агенту в этом чате',
      selected: (chat.autoApprove || 'ask') === m ? 'selected' : null,
    })));
    U.$$('option[selected]', approveSelect).forEach((o) => { approveSelect.value = o.value; });
    const content = U.el('div', { class: 'chat-settings' }, [
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Название' }), U.el('input', { class: 'field', id: 'chat-title-input', value: chat.title })]),
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Папка проекта' }), folderInput]),
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Режим' }), modeSelect]),
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Лимит шагов' }), limitInput]),
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Разрешения' }), approveSelect]),
      U.el('button', {
        class: 'btn primary', text: 'Сохранить',
        onclick: async () => {
          const titleInput = U.$('#chat-title-input');
          await Store.touchChat(chat.id, {
            title: (titleInput && titleInput.value.trim()) || chat.title,
            projectFolder: folderInput.value.trim(),
            mode: modeSelect.value,
            stepLimit: U.clamp(parseInt(limitInput.value, 10) || 30, 1, 200),
            autoApprove: approveSelect.value,
          });
          Render.closeSheet();
          Bus.emit('render');
        },
      }),
      U.el('button', {
        class: 'btn', text: 'Файлы проекта',
        onclick: () => { Render.closeSheet(); FilesUI.openPanel(); },
      }),
      U.el('button', {
        class: 'btn', text: 'Чекпоинты',
        onclick: () => { Render.closeSheet(); openCheckpoints(chat); },
      }),
    ]);
    Render.openSheet({ title: t('chat.settings', 'Настройки чата'), content });
  };

  const openCheckpoints = async (chat) => {
    const res = await Native.api('checkpoints.list', { chatId: chat.id });
    const content = U.el('div', { class: 'checkpoints' });
    if (!res || !res.ok || !(res.items || []).length) {
      content.appendChild(U.el('p', { class: 'muted small', text: 'Чекпоинтов пока нет. Они создаются перед первым изменением файлов.' }));
    } else {
      (res.items || []).forEach((item) => {
        content.appendChild(U.el('div', { class: 'checkpoint-row' }, [
          Icons.make('checkpoint', 16),
          U.el('span', { class: 'checkpoint-main', text: U.formatRelative(item.ts) + ' · ' + (item.reason || 'снимок') }),
          U.el('button', {
            class: 'link-btn', text: 'Откатить',
            onclick: () => Render.confirm({
              title: 'Откат файлов', danger: true,
              text: 'Файлы проекта вернутся к состоянию ' + U.formatRelative(item.ts) + '.',
              okText: 'Откатить',
              onOk: async () => {
                const r = await Native.api('checkpoints.restore', { chatId: chat.id, id: item.id });
                Render.toast(r && r.ok ? 'Файлы восстановлены' : 'Не удалось откатить');
              },
            }),
          }),
        ]));
      });
    }
    Render.openSheet({ title: 'Чекпоинты', content });
  };

  const appSettings = () => {
    const content = U.el('div', { class: 'app-settings' });
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Внешний вид' }));
    const themes = [
      { id: 'dark', label: 'Тёмная' },
      { id: 'light', label: 'Светлая' },
    ];
    const themeRow = U.el('div', { class: 'seg' });
    themes.forEach((t) => {
      themeRow.appendChild(U.el('button', {
        class: 'seg-item' + (S.settings.theme === t.id ? ' active' : ''),
        type: 'button', text: t.label,
        onclick: () => {
          Store.setSetting('theme', t.id);
          Render.closeSheet();
          appSettings();
        },
      }));
    });
    content.appendChild(themeRow);
    const accents = [
      { id: 'blue', label: 'Синий', color: '#5b8cff' },
      { id: 'green', label: 'Зелёный', color: '#3fbf6f' },
      { id: 'violet', label: 'Фиолетовый', color: '#a06bff' },
    ];
    const accentRow = U.el('div', { class: 'accent-row' });
    accents.forEach((a) => {
      accentRow.appendChild(U.el('button', {
        class: 'accent-dot' + (S.settings.accent === a.id ? ' active' : ''),
        type: 'button', title: a.label, style: 'background:' + a.color,
        'aria-label': a.label,
        onclick: () => { Store.setSetting('accent', a.id); Render.closeSheet(); appSettings(); },
      }));
    });
    content.appendChild(accentRow);

    content.appendChild(U.el('h3', { class: 'section-title', text: 'Язык / Language' }));
    const langRow = U.el('div', { class: 'seg' });
    [{ id: 'ru', label: 'RU' }, { id: 'en', label: 'EN' }].forEach((lang) => {
      langRow.appendChild(U.el('button', {
        class: 'seg-item' + (S.settings.language === lang.id ? ' active' : ''),
        type: 'button', text: lang.label,
        'aria-label': lang.id === 'ru' ? 'Русский' : 'English',
        onclick: () => {
          Store.setSetting('language', lang.id);
          Render.closeSheet();
          Render.render();
          appSettings();
        },
      }));
    });
    content.appendChild(langRow);

    content.appendChild(U.el('h3', { class: 'section-title', text: 'Агент' }));
    content.appendChild(numberRow('Лимит шагов', S.settings.stepLimit, (v) => Store.setSetting('stepLimit', v)));
    content.appendChild(toggleRow('Отправка по Enter', S.settings.sendOnEnter, (v) => Store.setSetting('sendOnEnter', v)));
    content.appendChild(toggleRow('Уведомления', S.settings.notifications, (v) => Store.setSetting('notifications', v)));
    content.appendChild(toggleRow('Звуки', S.settings.sounds, (v) => Store.setSetting('sounds', v)));
    content.appendChild(toggleRow('Продолжать на бесплатных моделях', S.settings.autoFree !== false, (v) => {
      Store.setSetting('autoFree', v);
    }));
    content.appendChild(toggleRow('Плавающий индикатор', S.settings.overlay, async (v) => {
      const res = await Native.api(v ? 'overlay.show' : 'overlay.hide');
      if (res && res.ok) {
        Store.setSetting('overlay', v);
      } else {
        Render.toast((res && res.error) || 'Не удалось включить индикатор');
        if (res && res.settings) Native.call('settings.overlay', {});
      }
    }));
    content.appendChild(toggleRow('Меньше анимаций', S.settings.reduceMotion, (v) => {
      Store.setSetting('reduceMotion', v);
      document.documentElement.dataset.motion = v ? 'reduced' : '';
    }));

    content.appendChild(U.el('h3', { class: 'section-title', text: 'Данные' }));
    content.appendChild(U.el('button', {
      class: 'btn full', text: 'Экспорт и бэкап',
      onclick: () => { Render.closeSheet(); exportSheet(); },
    }));

    Render.openSheet({ title: t('settings.title'), content });
  };

  const numberRow = (label, value, onChange) => {
    const input = U.el('input', {
      class: 'field inline', type: 'number', min: '1', max: '200', value: String(value),
    });
    input.addEventListener('change', () => onChange(U.clamp(parseInt(input.value, 10) || 30, 1, 200)));
    return U.el('label', { class: 'setting-row' }, [U.el('span', { text: label }), input]);
  };

  const toggleRow = (label, value, onChange) => {
    const input = U.el('input', { type: 'checkbox', class: 'switch' });
    input.checked = !!value;
    input.addEventListener('change', () => onChange(input.checked));
    return U.el('label', { class: 'setting-row' }, [U.el('span', { text: label }), input]);
  };

  const exportSheet = () => {
    const content = U.el('div', { class: 'export-sheet' }, [
      U.el('button', {
        class: 'btn full', text: 'Экспорт чата в Markdown',
        onclick: () => exportChat('md'),
      }),
      U.el('button', {
        class: 'btn full', text: 'Экспорт чата в JSON',
        onclick: () => exportChat('json'),
      }),
      U.el('button', {
        class: 'btn full', text: 'Отчёт агента (Markdown)',
        onclick: () => exportReport('md'),
      }),
      U.el('button', {
        class: 'btn full', text: 'Отчёт агента (JSON)',
        onclick: () => exportReport('json'),
      }),
      U.el('button', {
        class: 'btn full', text: 'Экспорт настроек (без ключей)',
        onclick: () => exportData('settings'),
      }),
      U.el('button', {
        class: 'btn full', text: 'Экспорт всех чатов',
        onclick: () => exportData('chats'),
      }),
      U.el('button', {
        class: 'btn full', text: 'Шифрованный бэкап',
        onclick: () => { Render.closeSheet(); encryptedBackup(); },
      }),
      U.el('button', {
        class: 'btn full', text: 'Восстановить из бэкапа',
        onclick: () => { Render.closeSheet(); restoreBackup(); },
      }),
      U.el('p', { class: 'muted small', text: 'Ключи API никогда не попадают в экспорт и бэкап.' }),
    ]);
    Render.openSheet({ title: t('settings.backup'), content });
  };

  const profilesSheet = async () => {
    const res = await Native.api('profiles.list');
    const content = U.el('div', { class: 'profiles-sheet' });
    const list = U.el('div', { class: 'profile-list' });
    const renderList = (activeId, profiles) => {
      U.clear(list);
      (profiles || []).forEach((profile) => {
        const active = profile.id === activeId;
        list.appendChild(U.el('div', { class: 'profile-row' + (active ? ' active' : '') }, [
          Render.avatar(profile.name || profile.id, 3, 2),
          U.el('span', { class: 'profile-row-name', text: profile.name || profile.id }),
          active
            ? U.el('span', { class: 'profile-row-badge', text: 'активен' })
            : U.el('button', {
              class: 'link-btn', text: 'выбрать',
              onclick: async () => {
                const r = await Native.api('profiles.active', { id: profile.id });
                if (r && r.ok) {
                  Render.toast('Профиль: ' + (profile.name || profile.id));
                  Render.closeSheet();
                  window.location.reload();
                }
              },
            }),
        ]));
      });
    };
    renderList(res?.active, res?.profiles);
    content.appendChild(U.el('p', { class: 'muted small', text: 'Профиль изолирует рабочую папку чатов: файлы, чекпоинты и проекты не пересекаются.' }));
    content.appendChild(list);
    const nameInput = U.el('input', { class: 'field', placeholder: 'Название профиля' });
    content.appendChild(U.el('div', { class: 'profile-add' }, [
      nameInput,
      U.el('button', {
        class: 'btn small', text: 'Создать',
        onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) return;
          const id = 'p' + Date.now().toString(36);
          const r = await Native.api('profiles.add', { id, name });
          if (r && r.ok) {
            const refreshed = await Native.api('profiles.list');
            renderList(refreshed?.active, refreshed?.profiles);
            nameInput.value = '';
            Render.toast('Профиль создан');
          } else {
            Render.toast((r && r.error) || 'Не удалось создать профиль');
          }
        },
      }),
    ]));
    Render.openSheet({ title: t('settings.profiles'), content });
  };

  const exportChat = async (format) => {
    const chat = Store.getChat(S.chatId);
    if (!chat) return;
    if (format === 'md') {
      const text = ChatExport.markdown(chat);
      const res = await Native.call('export.text', { name: chat.title + '.md', text });
      Render.toast(res && res.ok ? 'Файл сохранён' : 'Не удалось сохранить');
    } else {
      const text = JSON.stringify(ChatExport.json(chat), null, 2);
      const res = await Native.call('export.text', { name: chat.title + '.json', text });
      Render.toast(res && res.ok ? 'Файл сохранён' : 'Не удалось сохранить');
    }
    Render.closeSheet();
  };

  const exportReport = async (format) => {
    const chat = Store.getChat(S.chatId);
    if (!chat) return;
    const res = await Native.api('agent.report', { chatId: chat.id });
    if (!res || !res.ok) {
      Render.toast('Отчёт недоступен');
      return;
    }
    const report = res.report || {};
    let text;
    if (format === 'md') {
      const lines = ['# Отчёт агента: ' + chat.title, '', 'Событий: ' + (report.steps || 0), ''];
      (report.events || []).forEach((event) => {
        const ts = new Date(event.ts).toLocaleString('ru-RU');
        if (event.type === 'tool') {
          lines.push('## [' + ts + '] Шаг ' + (event.step || '') + ': ' + (event.name || ''));
          lines.push('');
          lines.push('```json');
          lines.push(JSON.stringify(event.input || {}, null, 2));
          lines.push('```');
          if (event.output) {
            lines.push('');
            lines.push('```');
            lines.push(String(event.output).slice(0, 2000));
            lines.push('```');
          }
          lines.push('');
        } else {
          lines.push('- [' + ts + '] ' + event.type + ' ' + (event.reason || event.label || ''));
        }
      });
      text = lines.join('\n');
    } else {
      text = JSON.stringify(report, null, 2);
    }
    const saved = await Native.call('export.text', {
      name: chat.title + '-report.' + format,
      text,
    });
    Render.toast(saved && saved.ok ? 'Отчёт сохранён' : 'Не удалось сохранить отчёт');
    Render.closeSheet();
  };

  const encryptedBackup = () => {
    const password = U.el('input', { class: 'field', type: 'password', placeholder: 'пароль (мин. 6 символов)' });
    const repeat = U.el('input', { class: 'field', type: 'password', placeholder: 'повторите пароль' });
    const content = U.el('div', { class: 'confirm' }, [
      U.el('p', { class: 'muted small', text: 'Бэкап шифруется AES-GCM (PBKDF2). Пароль не сохраняется: без него архив не восстановить.' }),
      password,
      repeat,
      U.el('button', {
        class: 'btn primary', text: 'Создать архив',
        onclick: async () => {
          if (password.value.length < 6) { Render.toast('Пароль минимум 6 символов'); return; }
          if (password.value !== repeat.value) { Render.toast('Пароли не совпадают'); return; }
          const payload = {
            password: password.value,
            chats: collectChats(),
          };
          const res = await Native.api('backup.export', payload);
          Render.closeSheet();
          Render.toast(res && res.ok ? 'Бэкап сохранён' : 'Не удалось сохранить');
        },
      }),
    ]);
    Render.openSheet({ title: 'Шифрованный бэкап', content });
  };

  const restoreBackup = () => {
    const text = U.el('textarea', { class: 'field textarea', rows: 6, placeholder: 'вставьте содержимое архива' });
    const password = U.el('input', { class: 'field', type: 'password', placeholder: 'пароль (если архив шифрован)' });
    const content = U.el('div', { class: 'confirm' }, [
      U.el('p', { class: 'muted small', text: 'Импорт настроек. Повреждённый архив не изменит профиль.' }),
      text,
      password,
      U.el('button', {
        class: 'btn primary', text: 'Восстановить',
        onclick: async () => {
          const res = await Native.api('backup.import', { text: text.value, password: password.value });
          Render.closeSheet();
          if (res && res.ok) {
            S.settings = Settings.read();
            Render.toast('Профиль восстановлен');
            Bus.emit('render');
          } else {
            Render.toast((res && res.error) || 'Не удалось восстановить');
          }
        },
      }),
    ]);
    Render.openSheet({ title: 'Восстановление', content });
  };

  const collectChats = () => {
    return S.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      mode: chat.mode,
      model: chat.model,
      provider: chat.provider,
      messages: (S.messages.get(chat.id) || []).map((m) => ({
        role: m.role, ts: m.ts, text: m.text, kind: m.kind,
      })),
    }));
  };

  const exportData = async (kind) => {
    const res = await Native.api('export.data', { kind });
    Render.toast(res && res.ok ? 'Экспорт готов: ' + res.path : 'Не удалось экспортировать');
    Render.closeSheet();
  };

  const appMenu = () => {
    const content = U.el('div', { class: 'app-menu' }, [
      menuButton('pin', 'Провайдеры', () => { Render.closeSheet(); ProvidersUI.openProvidersScreen(); }),
      menuButton('model', 'Модели и профили', () => { Render.closeSheet(); ProvidersUI.openModelSheet(); }),
      menuButton('shield', 'Настройки агента', () => { Render.closeSheet(); appSettings(); }),
      menuButton('article', 'Экспорт и бэкап', () => { Render.closeSheet(); exportSheet(); }),
      menuButton('info', 'О приложении', () => { Render.closeSheet(); aboutSheet(); }),
    ]);
    Render.openSheet({ title: 'Меню', content });
  };

  const menuButton = (icon, label, handler) => U.el('button', {
    class: 'menu-item', type: 'button', onclick: handler,
  }, [Icons.make(icon, 18), U.el('span', { text: label })]);

  const aboutSheet = () => {
    const env = S.env || {};
    const content = U.el('div', { class: 'about' }, [
      U.el('div', { class: 'about-logo', html: Icons.html('sparkle', 40) }),
      U.el('h3', { text: 'botCHAT ' + (env.versionName || '') }),
      U.el('p', { class: 'muted small', text: 'Мессенджер с ИИ-собеседниками, которые читают и правят файлы, запускают команды и делегируют подзадачи.' }),
      U.el('p', { class: 'muted small', text: 'Устройство: ' + (env.device || 'Android') }),
      U.el('p', { class: 'muted small', text: 'rootfs: ' + (env.rootfs ? 'установлен' : 'не установлен') }),
      U.el('p', { class: 'muted small', text: 'Без телеметрии. Ключи только на устройстве.' }),
    ]);
    Render.openSheet({ title: 'О приложении', content });
  };

  const taskGraph = async () => {
    const res = await Native.api('tasks.list');
    const tasks = (res && res.ok && res.tasks) || S.agent.tasks || [];
    const content = U.el('div', { class: 'task-graph' });
    const canvas = U.el('svg', { class: 'graph-canvas', viewBox: '0 0 320 200' });
    const nodes = tasks.length ? tasks : [{ role: 'main', status: 'running', description: 'Основной агент' }];
    nodes.forEach((task, i) => {
      const x = 40 + (i % 4) * 76;
      const y = 40 + Math.floor(i / 4) * 70;
      const cls = 'graph-node ' + (task.status || 'queued');
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', cls);
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(x + 26));
      circle.setAttribute('cy', String(y));
      circle.setAttribute('r', '18');
      g.appendChild(circle);
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(x + 26));
      label.setAttribute('y', String(y + 34));
      label.setAttribute('text-anchor', 'middle');
      label.textContent = U.truncate(task.role || 'task', 12);
      g.appendChild(label);
      canvas.appendChild(g);
    });
    content.appendChild(canvas);
    if (!tasks.length) content.appendChild(U.el('p', { class: 'muted small', text: 'Субагенты ещё не запускались.' }));
    tasks.forEach((task) => {
      content.appendChild(U.el('div', { class: 'task-row' }, [
        U.el('span', { class: 'task-role', text: task.role || 'task' }),
        U.el('span', { class: 'task-status ' + (task.status || 'queued'), text: Render.statusText(task.status || 'queued') }),
        U.el('span', { class: 'muted small', text: U.truncate(task.description || '', 60) }),
      ]));
    });
    Render.openSheet({ title: t('agent.graph'), content });
  };

  return {
    chatSettings, appSettings, appMenu, exportSheet, exportChat, exportData,
    aboutSheet, taskGraph, openCheckpoints, toggleRow, numberRow, profilesSheet,
  };
})();

window.Pickers = Pickers;