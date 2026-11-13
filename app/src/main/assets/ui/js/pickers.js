'use strict';

/**
 * Шторки выбора: модель, провайдер, настройки чата, приложения, экспорт.
 */
const Pickers = (() => {
  /**
   * Карточка чата: то, что открывается тапом по аватарке в списке.
   * Название, модель именно этого чата, аватар, цвет и параметры агента.
   */
  const openChatCard = (chatId) => {
    const chat = Store.getChat(chatId || S.chatId);
    if (!chat) return;
    const draft = {
      title: chat.title,
      avatar: chat.avatar || '',
      avatarFilled: !!chat.avatarFilled,
      accent: chat.accent || '',
      provider: chat.provider || '',
      model: chat.model || '',
    };

    const content = U.el('div', { class: 'chat-card' });

    // --- превью ---
    const previewRow = U.el('div', { class: 'chat-card-head' });
    const renderPreview = () => {
      U.clear(previewRow);
      previewRow.appendChild(Render.avatar(draft.title, chat.color, 2, draft));
      const meta = U.el('div', { class: 'chat-card-meta' }, [
        U.el('span', { class: 'chat-card-title', text: draft.title }),
        U.el('span', {
          class: 'chat-card-sub',
          text: modelLabel(draft.provider, draft.model) || 'модель не выбрана',
        }),
      ]);
      previewRow.appendChild(meta);
    };
    content.appendChild(previewRow);

    // --- название ---
    const titleInput = U.el('input', {
      class: 'field',
      value: chat.title,
      placeholder: 'Название чата',
      oninput: () => { draft.title = titleInput.value; renderPreview(); },
    });
    content.appendChild(U.el('label', { class: 'field-group' }, [
      U.el('span', { class: 'field-label', text: 'Название' }),
      titleInput,
    ]));

    // --- модель этого чата ---
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Модель чата' }));
    const currentModel = U.el('div', { class: 'chat-card-current' }, [
      Icons.make('model', 16),
      U.el('span', { text: modelLabel(draft.provider, draft.model) || 'выбрать модель' }),
    ]);
    content.appendChild(currentModel);
    content.appendChild(U.el('button', {
      class: 'btn', text: 'Выбрать модель для этого чата',
      onclick: () => {
        Render.closeSheet();
        ProvidersUI.openModelSheet();
      },
    }));

    // --- аватар ---
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Аватар' }));
    const iconGrid = U.el('div', { class: 'icon-grid chat-icon-grid' });
    const resetCell = U.el('button', {
      class: 'icon-cell' + (!draft.avatar ? ' active' : ''), type: 'button',
      'aria-label': 'Инициалы',
      onclick: () => {
        draft.avatar = '';
        U.$$('.icon-cell', iconGrid).forEach((n) => n.classList.remove('active'));
        resetCell.classList.add('active');
        renderPreview();
      },
    }, U.el('span', { class: 'icon-cell-text', text: 'Аа' }));
    iconGrid.appendChild(resetCell);
    Avatars.ids.forEach((name) => {
      [false, true].forEach((filled) => {
        const cell = U.el('button', {
          class: 'icon-cell' + (draft.avatar === name && draft.avatarFilled === filled ? ' active' : ''),
          type: 'button',
          'aria-label': name + (filled ? ' заливка' : ' контур'),
          onclick: () => {
            draft.avatar = name;
            draft.avatarFilled = filled;
            U.$$('.icon-cell', iconGrid).forEach((n) => n.classList.remove('active'));
            cell.classList.add('active');
            renderPreview();
          },
        });
        cell.innerHTML = Avatars.svg(name, { size: 22, filled });
        iconGrid.appendChild(cell);
      });
    });
    content.appendChild(iconGrid);

    // --- цвет ---
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Цвет' }));
    const palette = U.el('div', { class: 'palette' });
    const resetColor = U.el('button', {
      class: 'palette-dot reset', type: 'button', title: 'Как у остальных',
      onclick: () => {
        draft.accent = '';
        U.$$('.palette-dot', palette).forEach((n) => n.classList.remove('active'));
        resetColor.classList.add('active');
        renderPreview();
      },
    });
    palette.appendChild(resetColor);
    Appearance.PRESETS.forEach((preset) => {
      const dot = U.el('button', {
        class: 'palette-dot' + (draft.accent === preset.acc ? ' active' : ''),
        type: 'button', title: preset.name,
        style: 'background:' + preset.acc,
        'aria-label': preset.name,
        onclick: () => {
          draft.accent = preset.acc;
          U.$$('.palette-dot', palette).forEach((n) => n.classList.remove('active'));
          dot.classList.add('active');
          renderPreview();
        },
      });
      palette.appendChild(dot);
    });
    content.appendChild(palette);

    const customColor = U.el('input', {
      class: 'field mono-input', type: 'text',
      value: draft.accent || '', placeholder: '#RRGGBB', spellcheck: 'false',
    });
    content.appendChild(U.el('div', { class: 'slider-row' }, [
      U.el('span', { class: 'slider-label', text: 'Свой цвет' }),
      customColor,
      U.el('button', {
        class: 'link-btn', text: 'Применить',
        onclick: () => {
          const hex = customColor.value.trim();
          if (!Appearance.parseHex(hex)) {
            Render.toast('Нужен формат #RRGGBB');
            return;
          }
          draft.accent = hex;
          U.$$('.palette-dot', palette).forEach((n) => n.classList.remove('active'));
          renderPreview();
        },
      }),
    ]));

    // --- рабочая папка ---
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Рабочая папка' }));
    const storageBox = U.el('div', { class: 'storage-box' });
    const customPathInput = U.el('input', {
      class: 'field', placeholder: '/storage/emulated/0/Documents/project',
    });
    const renderStorage = async () => {
      U.clear(storageBox);
      const st = await Native.api('storage.info', { chatId: chat.id });
      const scope = (st && st.scope) || 'sandbox';
      const allFiles = !!(st && st.allFiles);
      const choices = [
        { id: 'sandbox', title: 'Песочница чата', sub: 'Изолированно, безопасно', enabled: true },
        { id: 'device', title: 'Память устройства', sub: allFiles ? st.deviceRoot : 'Нужен доступ ко всем файлам', enabled: allFiles },
        { id: 'custom', title: 'Своя папка', sub: allFiles ? 'Указать путь вручную' : 'Нужен доступ ко всем файлам', enabled: allFiles },
      ];
      choices.forEach((item) => {
        const row = U.el('button', {
          class: 'storage-choice' + (scope === item.id ? ' active' : '') + (item.enabled ? '' : ' disabled'),
          type: 'button',
          onclick: async () => {
            if (!item.enabled) {
              const res = await Native.api('storage.requestAllFiles');
              if (res && res.opened) Render.toast('Разрешите доступ и вернитесь');
              return;
            }
            if (item.id === 'custom') {
              const path = customPathInput.value.trim();
              if (!path) {
                Render.toast('Укажите путь к папке');
                return;
              }
              const res = await Native.api('storage.set', { chatId: chat.id, scope: 'custom', path });
              if (!res || !res.ok) {
                Render.toast((res && res.error) || 'Папка недоступна');
                return;
              }
            } else {
              await Native.api('storage.set', { chatId: chat.id, scope: item.id });
            }
            const info = await Native.api('storage.info', { chatId: chat.id });
            if (info && info.ok) S.storageActive = info.active || '';
            renderStorage();
          },
        }, [
          U.el('span', { class: 'storage-title', text: item.title }),
          U.el('span', { class: 'storage-sub', text: item.sub }),
          scope === item.id ? Icons.make('check', 16) : null,
        ]);
        storageBox.appendChild(row);
      });
      customPathInput.value = (st && st.customPath) || '';
      if (allFiles) {
        storageBox.appendChild(customPathInput);
        storageBox.appendChild(U.el('p', {
          class: 'muted small',
          text: 'Сейчас: ' + ((st && st.active) || ''),
        }));
      } else {
        storageBox.appendChild(U.el('button', {
          class: 'btn small full', text: 'Разрешить доступ ко всем файлам',
          onclick: async () => {
            const res = await Native.api('storage.requestAllFiles');
            if (res && res.opened) Render.toast('Разрешите доступ и вернитесь');
          },
        }));
      }
    };
    content.appendChild(storageBox);

    // --- действия ---
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Действия' }));
    content.appendChild(U.el('div', { class: 'chat-card-actions' }, [
      U.el('button', {
        class: 'btn small', text: chat.pinned ? 'Открепить' : 'Закрепить',
        onclick: async () => {
          await Store.togglePin(chat.id);
          Render.closeSheet();
        },
      }),
      U.el('button', {
        class: 'btn small', text: chat.archived ? 'Вернуть из архива' : 'В архив',
        onclick: async () => {
          await Store.toggleArchive(chat.id);
          Render.closeSheet();
        },
      }),
      U.el('button', {
        class: 'btn small', text: 'Параметры',
        onclick: () => {
          Render.closeSheet();
          chatSettings(chat.id);
        },
      }),
      U.el('button', {
        class: 'btn small danger-ghost', text: 'Удалить',
        onclick: () => {
          Render.closeSheet();
          Actions.confirmDelete(chat.id);
        },
      }),
    ]));

    const save = U.el('button', {
      class: 'btn primary full', text: 'Сохранить',
      onclick: async () => {
        save.disabled = true;
        await Store.touchChat(chat.id, {
          title: draft.title.trim() || chat.title,
          avatar: draft.avatar,
          avatarFilled: draft.avatarFilled,
          accent: draft.accent,
          color: draft.accent ? chat.color : U.colorIndex(draft.title),
        });
        save.disabled = false;
        Render.closeSheet();
        Render.toast('Чат обновлён');
      },
    });
    content.appendChild(save);

    renderPreview();
    renderStorage();
    Render.openSheet({ title: 'Чат', content, full: true });

    // Если модель выбрали через шторку моделей, карточка открывается заново с новыми данными.
    const off = Bus.on('chat:open', () => off());
    return off;
  };

  const modelLabel = (providerId, modelId) => {
    if (!modelId) return '';
    const provider = (S.providers || []).find((p) => p.id === providerId);
    return (provider ? provider.name + ' · ' : '') + modelId;
  };

  const chatSettings = (chatId) => {
    const chat = Store.getChat(chatId || S.chatId);
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

    content.appendChild(U.el('h3', { class: 'section-title', text: 'Иконка и цвет' }));
    content.appendChild(U.el('button', {
      class: 'btn full', text: 'Иконка, фон и палитра',
      onclick: () => { Render.closeSheet(); appearanceSheet(); },
    }));

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

  const appearanceSheet = () => {
    const icon = Appearance.currentIcon();
    const content = U.el('div', { class: 'appearance-sheet' });

    // --- предпросмотр ---
    const preview = U.el('div', { class: 'icon-preview' });
    const renderPreview = () => {
      const cur = Appearance.currentIcon();
      U.clear(preview);
      preview.innerHTML = Avatars.svg(cur.name, { size: 58, filled: cur.filled });
    };
    content.appendChild(U.el('div', { class: 'icon-preview-wrap' }, [preview]));
    renderPreview();

    // --- иконка: 116 вариантов ---
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Иконка' }));
    const grid = U.el('div', { class: 'icon-grid' });
    Avatars.ids.forEach((name) => {
      [false, true].forEach((filled) => {
        const active = icon.name === name && icon.filled === filled;
        const cell = U.el('button', {
          class: 'icon-cell' + (active ? ' active' : ''),
          type: 'button',
          'aria-label': name + (filled ? ' (заливка)' : ' (контур)'),
          onclick: () => {
            Appearance.setIcon(name, filled);
            U.$$('.icon-cell', grid).forEach((n) => n.classList.remove('active'));
            cell.classList.add('active');
            renderPreview();
          },
        });
        cell.innerHTML = Avatars.svg(name, { size: 22, filled });
        grid.appendChild(cell);
      });
    });
    content.appendChild(grid);

    // --- 15 пресетов + свой цвет ---
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Акцентный цвет' }));
    const presets = U.el('div', { class: 'palette' });
    Appearance.PRESETS.forEach((preset) => {
      presets.appendChild(U.el('button', {
        class: 'palette-dot', type: 'button', title: preset.name,
        style: 'background:' + preset.acc,
        'aria-label': preset.name,
        onclick: () => {
          Appearance.setPreset(preset.id);
          renderPreview();
          renderSliders(preset.acc);
          Render.toast('Цвет: ' + preset.name);
        },
      }));
    });
    content.appendChild(presets);

    // --- свой цвет: ползунки + номер ---
    const sliders = U.el('div', { class: 'slider-group' });
    let hue = 220;
    let sat = 0.9;
    let val = 1;
    const hexInput = U.el('input', {
      class: 'field mono-input', type: 'text', value: Appearance.current().accent || '#4F86FF',
      placeholder: '#4F86FF', spellcheck: 'false',
    });
    const makeSlider = (label, min, max, value, onInput) => {
      const input = U.el('input', {
        class: 'range', type: 'range', min: String(min), max: String(max), value: String(value),
      });
      input.addEventListener('input', () => onInput(parseFloat(input.value)));
      return U.el('label', { class: 'slider-row' }, [
        U.el('span', { class: 'slider-label', text: label }),
        input,
      ]);
    };
    const applyHsv = () => {
      const hex = Appearance.hsvToHex(hue, sat, val);
      hexInput.value = hex;
      Appearance.setAccent(hex);
      renderPreview();
    };
    const renderSliders = (hex) => {
      U.clear(sliders);
      const rgb = Appearance.parseHex(hex) || { r: 79, g: 134, b: 255 };
      const r = rgb.r / 255;
      const g = rgb.g / 255;
      const b = rgb.b / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      val = max;
      sat = max === 0 ? 0 : (max - min) / max;
      let h = 0;
      if (max !== min) {
        if (max === r) h = ((g - b) / (max - min)) % 6;
        else if (max === g) h = (b - r) / (max - min) + 2;
        else h = (r - g) / (max - min) + 4;
        h = Math.round(h * 60);
        if (h < 0) h += 360;
      }
      hue = h;
      sliders.appendChild(makeSlider('Оттенок', 0, 360, hue, (v) => { hue = v; applyHsv(); }));
      sliders.appendChild(makeSlider('Насыщенность', 0, 100, Math.round(sat * 100), (v) => {
        sat = v / 100; applyHsv();
      }));
      sliders.appendChild(makeSlider('Яркость', 20, 100, Math.round(val * 100), (v) => {
        val = v / 100; applyHsv();
      }));
    };
    renderSliders(Appearance.current().accent || '#4F86FF');

    sliders.appendChild(U.el('label', { class: 'slider-row' }, [
      U.el('span', { class: 'slider-label', text: 'Код' }),
      hexInput,
      U.el('button', {
        class: 'link-btn', text: 'Применить',
        onclick: () => {
          const hex = hexInput.value.trim();
          if (!Appearance.parseHex(hex)) {
            Render.toast('Нужен формат #RRGGBB');
            return;
          }
          Appearance.setAccent(hex);
          renderSliders(hex);
          renderPreview();
        },
      }),
    ]));
    content.appendChild(sliders);

    // --- фон ---
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Фон приложения' }));
    const bgs = U.el('div', { class: 'palette' });
    Appearance.BG_PRESETS.forEach((hex) => {
      bgs.appendChild(U.el('button', {
        class: 'palette-dot', type: 'button', style: 'background:' + hex,
        'aria-label': 'Фон ' + hex,
        onclick: () => { Appearance.setBackground(hex); Render.toast('Фон: ' + hex); },
      }));
    });
    content.appendChild(bgs);
    const bgInput = U.el('input', {
      class: 'field mono-input', type: 'text',
      value: Appearance.current().bg || '#0B0F16', spellcheck: 'false',
    });
    content.appendChild(U.el('div', { class: 'slider-row' }, [
      U.el('span', { class: 'slider-label', text: 'Свой фон' }),
      bgInput,
      U.el('button', {
        class: 'link-btn', text: 'Применить',
        onclick: () => {
          const hex = bgInput.value.trim();
          if (!Appearance.parseHex(hex)) { Render.toast('Нужен формат #RRGGBB'); return; }
          Appearance.setBackground(hex);
        },
      }),
    ]));

    content.appendChild(U.el('p', {
      class: 'muted small',
      text: 'Иконка и цвета применяются сразу. Иконка в лаунчере Android меняется вместе с настройкой.',
    }));

    Render.openSheet({ title: 'Иконка и цвет', content, full: true });
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
    appearanceSheet, openChatCard,
  };
})();

window.Pickers = Pickers;