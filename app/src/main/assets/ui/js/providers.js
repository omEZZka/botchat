'use strict';

/**
 * Провайдеры и модели: каталог, ключи, health, выбор модели.
 * Сеть — только через Native.api, ключи — только через Kotlin (Secrets).
 */
const ProvidersUI = (() => {
  const state = () => S;

  const load = async () => {
    const res = await Native.api('providers.list');
    if (res && res.ok) {
      S.providers = res.providers || [];
      S.models = res.models || S.models;
      S.customProviders = res.custom || [];
    }
    const quota = await Native.api('quota.info');
    S.quota = (quota && quota.ok && quota.limited) || {};
    const cat = await Native.api('providers.catalog');
    if (cat && cat.ok) S.providers = cat.providers || S.providers;
    ensureDefaultModel();
    Bus.emit('providers:changed', S.providers);

  };

  const ensureDefaultModel = () => {
    if (S.settings.activeModel) return;
    const models = S.models || [];
    if (!models.length) return;
    const preferred = models.find((m) => m.provider === (S.settings.activeProvider || 'opencode')) || models[0];
    if (!preferred) return;
    S.settings.activeProvider = preferred.provider || S.settings.activeProvider;
    S.settings.activeModel = preferred.id;
    Settings.write(S.settings);
  };

  const providerCard = (provider) => {
    const card = U.el('article', { class: 'provider-card', 'data-provider': provider.id });
    const status = provider.hasKey ? 'ключ есть' : (provider.needsKey ? 'ключа нет' : 'локальный сервер');
    card.appendChild(U.el('div', { class: 'provider-row' }, [
      U.el('span', { class: 'health-dot ' + (provider.hasKey || !provider.needsKey ? 'ok' : 'bad'), title: status }),
      U.el('div', { class: 'provider-main' }, [
        U.el('span', { class: 'provider-name', text: provider.name }),
        U.el('span', { class: 'provider-sub', text: provider.baseUrl + ' · ' + status }),
      ]),
      U.el('span', { class: 'provider-count', text: (provider.modelCount || 0) + ' мод.' }),
    ]));
    const actions = U.el('div', { class: 'provider-actions' }, [
      U.el('button', {
        class: 'btn small', text: provider.hasKey ? 'Ключи' : 'Ввести ключ',
        onclick: () => openKeySheet(provider),
      }),
      U.el('button', {
        class: 'btn small', text: 'Проверить',
        onclick: (ev) => checkHealth(provider, ev.currentTarget),
      }),
      provider.hasKey ? U.el('button', {
        class: 'btn small danger-ghost', text: 'Отключить',
        onclick: () => disableProvider(provider),
      }) : null,
      provider.custom ? U.el('button', {
        class: 'btn small danger-ghost', text: 'Удалить',
        onclick: () => Render.confirm({
          title: 'Удалить провайдера',
          text: 'Провайдер «' + provider.name + '» и его модели будут удалены с устройства.',
          okText: 'Удалить', danger: true,
          onOk: async () => {
            const res = await Native.api('providers.remove', { providerId: provider.id });
            if (res && res.ok) {
              S.models = (S.models || []).filter((m) => m.provider !== provider.id);
              await load();
              Render.closeSheet();
              openProvidersScreen();
              Render.toast('Провайдер удалён');
            } else {
              Render.toast((res && res.error) || 'Не удалось удалить');
            }
          },
        }),
      }) : null,
    ]);
    card.appendChild(actions);
    return card;
  };

  const openKeySheet = (provider) => {
    const keyInput = U.el('input', {
      class: 'field', type: 'password', placeholder: provider.id === 'opencode' ? 'необязательно' : 'sk-…',
      autocomplete: 'off', spellcheck: 'false',
    });
    const labelInput = U.el('input', { class: 'field', type: 'text', placeholder: 'метка (необязательно)' });
    const list = U.el('div', { class: 'key-list' });
    const refresh = async () => {
      U.clear(list);
      const res = await Native.api('keys.list', { providerId: provider.id });
      if (!res || !res.ok) return;
      (res.keys || []).forEach((item) => {
        list.appendChild(U.el('div', { class: 'key-row' }, [
          U.el('span', {
            class: 'key-dot ' + (item.active ? 'on' : ''),
            title: item.active ? 'активный' : 'резервный',
          }),
          U.el('span', { class: 'key-mask', text: item.mask }),
          item.label ? U.el('span', { class: 'key-label', text: item.label }) : null,
          U.el('button', {
            class: 'link-btn', text: item.active ? 'активен' : 'сделать активным',
            disabled: item.active,
            onclick: async () => {
              await Native.api('keys.active', { providerId: provider.id, keyId: item.id });
              await refresh();
            },
          }),
          U.el('button', {
            class: 'link-btn danger', text: 'удалить',
            onclick: async () => {
              await Native.api('keys.remove', { providerId: provider.id, keyId: item.id });
              await refresh();
            },
          }),
        ]));
      });
      if (!(res.keys || []).length) list.appendChild(U.el('p', { class: 'muted small', text: 'Ключей пока нет' }));
    };
    const content = U.el('div', { class: 'key-sheet' }, [
      U.el('p', { class: 'muted small', text: 'Ключи хранятся в Android Keystore (AES-GCM), не попадают в экспорт и бэкап. Можно хранить несколько ключей: активный и резервные для автоматической ротации при 429.' }),
      list,
      U.el('label', { class: 'field-label', text: 'Новый ключ' }),
      keyInput,
      labelInput,
      U.el('button', {
        class: 'btn primary', text: 'Сохранить ключ',
        onclick: async () => {
          const value = keyInput.value.trim();
          if (!value) {
            Render.toast('Введите ключ');
            return;
          }
          const res = await Native.api('keys.add', { providerId: provider.id, key: value, label: labelInput.value.trim() });
          if (res && res.ok) {
            keyInput.value = '';
            labelInput.value = '';
            await refresh();
            await load();
            Render.toast('Ключ сохранён');
          } else {
            Render.toast((res && res.error) || 'Не удалось сохранить ключ');
          }
        },
      }),
    ]);
    Render.openSheet({ title: provider.name, content });
    refresh();
  };

  const checkHealth = async (provider, button) => {
    if (button) button.disabled = true;
    if (button) button.textContent = 'Проверяю…';
    const res = await Native.api('providers.verify', { providerId: provider.id });
    if (button) {
      button.disabled = false;
      button.textContent = 'Проверить';
    }
    if (!res || !res.ok) {
      Render.toast((res && res.error) || 'Проверка не удалась');
      return;
    }
    const working = res.working || [];
    const rejected = res.rejected || [];
    S.models = res.models || S.models;
    await load();
    Render.closeSheet();
    openVerifyReport(provider, working, rejected, res.total || (working.length + rejected.length));
  };

  const reasonText = (reason, code) => {
    switch (reason) {
      case 'account_limit': return 'лимит аккаунта' + (code ? ' · HTTP ' + code : '');
      case 'rate_limit': return 'лимит запросов' + (code ? ' · HTTP ' + code : '');
      case 'no_access': return 'нет доступа' + (code ? ' · HTTP ' + code : '');
      case 'not_found': return 'не найдена';
      case 'network': return 'нет связи';
      case 'empty': return 'пустой ответ';
      default: return 'ошибка' + (code ? ' · HTTP ' + code : '');
    }
  };

  const openVerifyReport = (provider, working, rejected, total) => {
    const content = U.el('div', { class: 'verify-sheet' });
    content.appendChild(U.el('div', { class: 'verify-summary' }, [
      U.el('span', { class: 'verify-ok', text: working.length + ' работают' }),
      rejected.length ? U.el('span', { class: 'verify-bad', text: rejected.length + ' отклонены' }) : null,
      U.el('span', { class: 'muted small', text: 'из ' + total }),
    ]));
    if (working.length) {
      content.appendChild(U.el('div', { class: 'verify-title', text: 'Доступные' }));
      working.forEach((id) => content.appendChild(U.el('div', { class: 'probe-model ok' }, [
        U.el('span', { class: 'verify-dot ok' }),
        U.el('span', { class: 'probe-name', text: id }),
      ])));
    }
    if (rejected.length) {
      content.appendChild(U.el('div', { class: 'verify-title', text: 'Недоступные — в список не попали' }));
      rejected.forEach((item) => content.appendChild(U.el('div', { class: 'probe-model bad' }, [
        U.el('span', { class: 'verify-dot bad' }),
        U.el('span', { class: 'probe-name', text: item.id }),
        U.el('span', { class: 'probe-reason', text: reasonText(item.reason, item.code) }),
      ])));
    }
    content.appendChild(U.el('p', {
      class: 'muted small',
      text: 'Проверка — короткий реальный запрос к каждой модели. Лимит запоминается на несколько минут.',
    }));
    Render.openSheet({ title: provider.name, content });
  };

  const disableProvider = async (provider) => {
    await Native.api('keys.wipe', { providerId: provider.id });
    await load();
    Render.toast('Провайдер отключён');
  };

  const openAddProvider = () => {
    const fields = {};
    const group = (label, input, hint) => U.el('label', { class: 'field-group' }, [
      U.el('span', { class: 'field-label', text: label }),
      input,
      hint ? U.el('span', { class: 'field-hint', text: hint }) : null,
    ]);

    fields.id = U.el('input', {
      class: 'field', placeholder: 'my-provider', autocomplete: 'off', spellcheck: 'false',
    });
    fields.name = U.el('input', { class: 'field', placeholder: 'Мой провайдер' });
    fields.baseUrl = U.el('input', {
      class: 'field', type: 'url', placeholder: 'https://api.example.com/v1',
      autocomplete: 'off', spellcheck: 'false',
    });
    fields.key = U.el('input', {
      class: 'field', type: 'password', placeholder: 'sk-… (если требуется)',
      autocomplete: 'off', spellcheck: 'false',
    });
    fields.headers = U.el('textarea', {
      class: 'field textarea', rows: 2, placeholder: '{"X-Title": "botCHAT"}',
    });
    const typeSelect = U.el('select', { class: 'field' }, [
      U.el('option', { value: 'openai-compatible', text: 'openai-compatible' }),
      U.el('option', { value: 'anthropic', text: 'anthropic' }),
      U.el('option', { value: 'gemini', text: 'gemini' }),
    ]);

    const probe = U.el('div', { class: 'probe-models' });
    const picked = new Set();
    const reportByModel = new Map();
    let verified = false;

    const renderReport = (working, rejected, total) => {
      U.clear(probe);
      verified = true;
      picked.clear();
      reportByModel.clear();
      probe.appendChild(U.el('div', { class: 'verify-summary' }, [
        U.el('span', { class: 'verify-ok', text: working.length + ' работают' }),
        rejected.length
          ? U.el('span', { class: 'verify-bad', text: rejected.length + ' отклонены' })
          : null,
        U.el('span', { class: 'muted small', text: 'из ' + total }),
      ]));

      if (working.length) {
        probe.appendChild(U.el('div', { class: 'verify-title', text: 'Доступные' }));
        working.forEach((id) => {
          picked.add(id);
          reportByModel.set(id, { ok: true });
          probe.appendChild(U.el('label', { class: 'probe-model ok' }, [
            U.el('span', { class: 'verify-dot ok' }),
            U.el('span', { class: 'probe-name', text: id }),
          ]));
        });
      }
      if (rejected.length) {
        probe.appendChild(U.el('div', { class: 'verify-title', text: 'Недоступные — в список не попадут' }));
        rejected.forEach((item) => {
          reportByModel.set(item.id, item);
          probe.appendChild(U.el('div', { class: 'probe-model bad' }, [
            U.el('span', { class: 'verify-dot bad' }),
            U.el('span', { class: 'probe-name', text: item.id }),
            U.el('span', { class: 'probe-reason', text: reasonText(item.reason, item.code) }),
          ]));
        });
      }
    };

    const probeButton = U.el('button', {
      class: 'btn', text: 'Проверить модели',
      onclick: async () => {
        const baseUrl = fields.baseUrl.value.trim();
        if (!baseUrl) {
          Render.toast('Укажите Base URL');
          return;
        }
        const key = fields.key.value.trim();
        const id = fields.id.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!id) {
          Render.toast('Укажите ID провайдера');
          return;
        }
        probeButton.disabled = true;
        U.clear(probe);
        probe.appendChild(U.el('div', { class: 'probe-row' }, [
          U.el('span', { class: 'spinner tiny' }),
          U.el('span', { text: 'Проверяю модели коротким запросом…' }),
        ]));

        // Сохраняем провайдера во временном виде, чтобы проверка шла по реальным ключам/заголовкам.
        const saved = await Native.api('providers.add', {
          id, name: fields.name.value.trim() || id, baseUrl,
          apiType: typeSelect.value,
          headers: U.safeJson(fields.headers.value || '{}', {}),
          key,
          models: [],
        });
        if (!saved || !saved.ok) {
          probeButton.disabled = false;
          U.clear(probe);
          probe.appendChild(U.el('p', {
            class: 'muted small', text: (saved && saved.error) || 'Не удалось сохранить провайдера для проверки',
          }));
          return;
        }

        const list = await Native.api('providers.probe', {
          baseUrl, apiType: typeSelect.value, key,
          headers: U.safeJson(fields.headers.value || '{}', {}),
        });
        const ids = (list && list.ok && (list.models || []).map((m) => m.id)) || [];
        if (!ids.length) {
          probeButton.disabled = false;
          U.clear(probe);
          probe.appendChild(U.el('p', {
            class: 'muted small',
            text: 'Провайдер не вернул список моделей. Проверьте Base URL и ключ.',
          }));
          return;
        }

        const res = await Native.api('providers.verify', { providerId: id, models: ids });
        probeButton.disabled = false;
        if (!res || !res.ok) {
          U.clear(probe);
          probe.appendChild(U.el('p', {
            class: 'muted small', text: (res && res.error) || 'Проверка не удалась',
          }));
          return;
        }
        renderReport(res.working || [], res.rejected || [], res.total || ids.length);
        await load();
      },
    });

    const saveButton = U.el('button', {
      class: 'btn primary', text: 'Сохранить и подключить',
      onclick: async () => {
        const id = fields.id.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const name = fields.name.value.trim() || id;
        const baseUrl = fields.baseUrl.value.trim();
        if (!id) { Render.toast('Заполните ID'); return; }
        if (!/^https?:\/\//.test(baseUrl)) { Render.toast('Base URL должен начинаться с http:// или https://'); return; }
        if (!verified) {
          Render.toast('Сначала проверьте модели — в список попадут только доступные');
          return;
        }
        if (!picked.size) {
          Render.toast('Нет рабочих моделей: нечего подключать');
          return;
        }
        saveButton.disabled = true;
        saveButton.textContent = 'Сохраняю…';
        const res = await Native.api('providers.add', {
          id,
          name,
          baseUrl,
          apiType: typeSelect.value,
          headers: U.safeJson(fields.headers.value || '{}', {}),
          key: fields.key.value.trim(),
          models: Array.from(picked),
        });
        if (!res || !res.ok) {
          saveButton.disabled = false;
          saveButton.textContent = 'Сохранить и подключить';
          Render.toast((res && res.error) || 'Не удалось сохранить провайдера');
          return;
        }
        // В кеш попадают только проверенные рабочие модели.
        const refreshed = await Native.api('models.refresh');
        if (refreshed && refreshed.ok) S.models = refreshed.models || S.models;
        await load();
        Render.closeSheet();
        Render.toast('Провайдер «' + name + '» подключён');
        openProvidersScreen();
      },
    });

    const content = U.el('div', { class: 'add-provider' }, [
      group('ID (латиница)', fields.id, 'латиница, цифры, _ и -'),
      group('Отображаемое имя', fields.name),
      group('Base URL', fields.baseUrl, 'например https://api.openai.com/v1'),
      group('Тип API', typeSelect),
      group('Доп. заголовки (JSON)', fields.headers),
      group('API-ключ', fields.key),
      probeButton,
      probe,
      saveButton,
    ]);
    Render.openSheet({ title: 'Добавить провайдера', content, full: true });
  };

  const openProvidersScreen = () => {
    const content = U.el('div', { class: 'providers-screen' });
    const connected = S.providers.filter((p) => p.hasKey || !p.needsKey || p.custom);
    const others = S.providers.filter((p) => !p.hasKey && p.needsKey && !p.custom);
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Подключённые' }));
    if (!connected.length) content.appendChild(U.el('p', { class: 'muted small', text: 'Пока нет подключённых провайдеров' }));
    connected.forEach((p) => content.appendChild(providerCard(p)));
    content.appendChild(U.el('h3', { class: 'section-title', text: 'Все провайдеры' }));
    content.appendChild(U.el('button', {
      class: 'btn full', text: 'Добавить нового',
      onclick: () => { Render.closeSheet(); openAddProvider(); },
    }));
    others.forEach((p) => content.appendChild(providerCard(p)));
    Render.openSheet({ title: 'Провайдеры', content });
  };

  const openModelSheet = () => {
    const content = U.el('div', { class: 'model-sheet' });
    const chat = Store.getChat(S.chatId);
    const search = U.el('input', {
      class: 'field', type: 'search', placeholder: 'Поиск модели',
      oninput: () => renderList(search.value),
    });
    const list = U.el('div', { class: 'model-list' });
    const collapsed = () => S.settings.collapsedProviders || {};
    const folders = () => S.settings.modelFolders || {};

    const toggleGroup = (providerId) => {
      const next = Object.assign({}, collapsed());
      next[providerId] = !next[providerId];
      Store.setSetting('collapsedProviders', next);
      renderList(search.value);
    };

    const choose = async (providerId, model) => {
      await Store.setChatModel(S.chatId, providerId, model.id);
      S.settings.activeProvider = providerId;
      S.settings.activeModel = model.id;
      Settings.write(S.settings);
      Render.closeSheet();
      Bus.emit('render');
    };

    const modelRow = (providerId, model) => {
      const active = chat && chat.model === model.id &&
        (chat.provider || S.settings.activeProvider) === providerId;
      const key = providerId + '|' + model.id;
      const pinned = (S.settings.pinnedModels || []).includes(key);
      return U.el('div', { class: 'model-row' + (active ? ' active' : '') }, [
        U.el('button', {
          class: 'model-row-main', type: 'button', onclick: () => choose(providerId, model),
        }, [
          Icons.make(active ? 'check' : 'model', 16),
          U.el('span', { class: 'model-name', text: model.name || model.id }),
          U.el('span', {
            class: 'model-meta',
            text: (model.context ? Math.round(model.context / 1000) + 'k' : '') +
              (model.reasoning ? ' · reasoning' : '') +
              (model.vision ? ' · vision' : ''),
          }),
        ]),
        U.el('button', {
          class: 'model-pin' + (pinned ? ' on' : ''), type: 'button',
          'aria-label': pinned ? 'Открепить' : 'Закрепить',
          onclick: async (ev) => {
            ev.stopPropagation();
            const next = new Set(S.settings.pinnedModels || []);
            if (next.has(key)) next.delete(key); else next.add(key);
            Store.setSetting('pinnedModels', Array.from(next));
            renderList(search.value);
          },
        }, Icons.make('pin', 14)),
        U.el('button', {
          class: 'model-folder', type: 'button', 'aria-label': 'В папку',
          onclick: (ev) => {
            ev.stopPropagation();
            const all = Object.keys(folders());
            if (!all.length) {
              Render.toast('Сначала создайте папку');
              return;
            }
            Render.openSheet({
              title: 'В папку',
              content: U.el('div', { class: 'forward-list' }, all.map((name) => U.el('button', {
                class: 'forward-row', type: 'button', text: name,
                onclick: () => {
                  const next = Object.assign({}, folders());
                  next[name] = Array.from(new Set((next[name] || []).concat([key])));
                  Store.setSetting('modelFolders', next);
                  Render.closeSheet();
                  renderList(search.value);
                },
              }))),
            });
          },
        }, Icons.make('folder', 14)),
        U.el('button', {
          class: 'model-remove', type: 'button', 'aria-label': 'Удалить модель',
          onclick: async (ev) => {
            ev.stopPropagation();
            const res = await Native.api('models.hide', { providerId, modelId: model.id });
            if (res && res.ok) {
              S.models = (S.models || []).filter(
                (m) => !(m.provider === providerId && m.id === model.id)
              );
              renderList(search.value);
              Render.toast('Модель удалена из списка');
            } else {
              Render.toast('Не удалось удалить модель');
            }
          },
        }, Icons.make('trash', 14)),
      ]);
    };

    const folderSection = () => {
      const all = folders();
      const names = Object.keys(all);
      const box = U.el('div', { class: 'folders' });
      names.forEach((name) => {
        const ids = all[name] || [];
        const open = !(collapsed()['folder:' + name]);
        const head = U.el('button', {
          class: 'folder-head', type: 'button',
          onclick: () => {
            const next = Object.assign({}, collapsed());
            next['folder:' + name] = !next['folder:' + name];
            Store.setSetting('collapsedProviders', next);
            renderList(search.value);
          },
        }, [
          Icons.make(open ? 'folder' : 'folder', 16),
          U.el('span', { class: 'folder-name', text: name }),
          U.el('span', { class: 'folder-count', text: String(ids.length) }),
          Icons.make(open ? 'down' : 'back', 14),
        ]);
        head.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          const next = Object.assign({}, folders());
          delete next[name];
          Store.setSetting('modelFolders', next);
          renderList(search.value);
          Render.toast('Папка удалена');
        });
        box.appendChild(head);
        if (!open) return;
        ids.forEach((key) => {
          const idx = key.indexOf('|');
          const providerId = key.slice(0, idx);
          const modelId = key.slice(idx + 1);
          const model = (S.models || []).find(
            (m) => m.provider === providerId && m.id === modelId
          );
          if (!model) return;
          box.appendChild(modelRow(providerId, model));
        });
      });
      return box;
    };

    const renderList = (query) => {
      U.clear(list);
      const q = String(query || '').toLowerCase();
      const groups = new Map();
      (S.models || []).forEach((model) => {
        if (q && !((model.id || '') + ' ' + (model.name || '')).toLowerCase().includes(q)) return;
        const providerId = model.provider || '';
        if (!groups.has(providerId)) groups.set(providerId, []);
        groups.get(providerId).push(model);
      });
      if (!groups.size) {
        list.appendChild(U.el('div', { class: 'empty small' }, [
          Icons.make('model', 28),
          U.el('p', { text: 'Моделей нет. Подключите провайдера и нажмите «Обновить».' }),
        ]));
        return;
      }
      const providerRank = (id) => {
        const provider = (S.providers || []).find((p) => p.id === id);
        if (!provider) return 2;
        if ((S.quota || {})['@account|' + id]) return 3;
        return provider.hasKey ? 0 : 1;
      };
      Array.from(groups.entries())
        .sort((a, b) => providerRank(a[0]) - providerRank(b[0]) || a[0].localeCompare(b[0]))
        .forEach(([providerId, models]) => {
          const provider = (S.providers || []).find((p) => p.id === providerId);
          const isOpen = !collapsed()[providerId];
          const limited = (S.quota || {})['@account|' + providerId];
          const head = U.el('button', {
            class: 'provider-group', type: 'button',
            onclick: () => toggleGroup(providerId),
          }, [
            Icons.make(isOpen ? 'down' : 'back', 15),
            U.el('span', { class: 'provider-group-name', text: provider ? provider.name : providerId }),
            U.el('span', { class: 'provider-group-count', text: String(models.length) }),
            limited ? U.el('span', { class: 'quota-badge', text: 'лимит ' + Math.ceil(limited / 1000) + ' с' }) : null,
          ]);
          list.appendChild(head);
          if (!isOpen) return;
          models.forEach((model) => list.appendChild(modelRow(providerId, model)));
        });
    };

    const folderButton = U.el('div', { class: 'model-footer' }, [
      U.el('button', {
        class: 'btn small', text: 'Папка',
        onclick: () => Render.prompt({
          title: 'Новая папка моделей', label: 'Название', placeholder: 'Например, Работа',
          onOk: (name) => {
            if (!name) return;
            const next = Object.assign({}, folders());
            next[name] = next[name] || [];
            Store.setSetting('modelFolders', next);
            renderList(search.value);
            Render.toast('Папка создана');
          },
        }),
      }),
      U.el('button', {
        class: 'btn small', text: 'Профили',
        onclick: () => { Render.closeSheet(); openProfiles(); },
      }),
      U.el('button', {
        class: 'btn small', text: 'Провайдеры',
        onclick: () => { Render.closeSheet(); openProvidersScreen(); },
      }),
      U.el('button', {
        class: 'btn small', text: 'Обновить',
        onclick: () => refreshModels(search.value),
      }),
    ]);

    const refreshModels = async (query) => {
      Render.toast('Обновляю список моделей…');
      const res = await Native.api('models.refresh');
      if (res && res.ok) {
        S.models = res.models || S.models;
        renderList(query);
        const errors = res.errors || {};
        const failed = Object.keys(errors);
        Render.toast(failed.length
          ? 'Модели обновлены, ошибки: ' + failed.join(', ')
          : 'Список моделей обновлён');
      } else {
        Render.toast((res && res.error) || 'Не удалось обновить');
      }
    };

    content.appendChild(search);
    content.appendChild(folderSection());
    content.appendChild(list);
    content.appendChild(folderButton);
    renderList('');
    Render.openSheet({ title: 'Модели', content });
  };

  const openQuota = async () => {
    const res = await Native.api('quota.info');
    const content = U.el('div', { class: 'quota-sheet' });
    content.appendChild(U.el('p', {
      class: 'muted small',
      text: 'Если провайдер вернул 429, приложение ждёт подсказку и пробует резервные модели из цепочки. Здесь видно, кто на паузе.',
    }));
    const list = U.el('div', { class: 'quota-list' });
    const limited = (res && res.limited) || {};
    const keys = Object.keys(limited);
    if (!keys.length) {
      list.appendChild(U.el('p', { class: 'muted small', text: 'Все модели доступны' }));
    }
    keys.sort((a, b) => limited[a] - limited[b]).forEach((key) => {
      const split = key.indexOf('|');
      const providerId = split < 0 ? key : key.slice(0, split);
      const rawModel = split < 0 ? '' : key.slice(split + 1);
      const modelId = rawModel === '@account' ? '' : rawModel;
      const provider = (S.providers || []).find((p) => p.id === providerId);
      list.appendChild(U.el('div', { class: 'quota-row' }, [
        U.el('span', {
          class: 'quota-name',
          text: (provider ? provider.name : providerId) +
            (rawModel === '@account' ? ' · все модели' : modelId ? ' · ' + modelId : ''),
        }),
        U.el('span', { class: 'quota-wait', text: Math.ceil(limited[key] / 1000) + ' с' }),
        U.el('button', {
          class: 'link-btn', text: 'сбросить',
          onclick: async () => {
            await Native.api('quota.clear', { providerId, modelId: rawModel });
            Render.closeSheet();
            openQuota();
          },
        }),
      ]));
    });
    content.appendChild(list);

    Render.openSheet({ title: 'Квоты и лимиты', content });
  };

  const openFallback = () => {
    const content = U.el('div', { class: 'profiles' });
    const list = U.el('div', { class: 'fallback-list' });
    const chain = () => (S.settings.fallbackChain || []).slice();

    const renderChain = () => {
      U.clear(list);
      const items = chain();
      if (!items.length) {
        list.appendChild(U.el('p', { class: 'muted small', text: 'Резервные модели не заданы. При ошибке или квоте диалог прервётся.' }));
      }
      items.forEach((key, index) => {
        const idx = key.indexOf('|');
        const providerId = idx < 0 ? key : key.slice(0, idx);
        const modelId = idx < 0 ? '' : key.slice(idx + 1);
        const provider = S.providers.find((p) => p.id === providerId);
        list.appendChild(U.el('div', { class: 'fallback-row' }, [
          U.el('span', { class: 'fallback-index', text: String(index + 1) }),
          U.el('span', { class: 'fallback-name', text: (provider ? provider.name : providerId) + ' · ' + modelId }),
          U.el('button', {
            class: 'link-btn', text: 'выше',
            disabled: index === 0,
            onclick: () => {
              const next = chain();
              const [item] = next.splice(index, 1);
              next.splice(index - 1, 0, item);
              Store.setSetting('fallbackChain', next);
              renderChain();
            },
          }),
          U.el('button', {
            class: 'link-btn danger', text: 'убрать',
            onclick: () => {
              const next = chain();
              next.splice(index, 1);
              Store.setSetting('fallbackChain', next);
              renderChain();
            },
          }),
        ]));
      });
    };

    const select = U.el('select', { class: 'field' }, [
      U.el('option', { value: '', text: 'выберите модель' }),
      ...(S.models || []).map((m) => U.el('option', {
        value: (m.provider || '') + '|' + m.id,
        text: (m.provider ? m.provider + ' · ' : '') + (m.name || m.id),
      })),
    ]);

    content.appendChild(U.el('p', { class: 'muted small', text: 'Порядок важен: при ошибке или квоте сначала пробуется следующий ключ текущего провайдера, затем модели из этой цепочки сверху вниз.' }));
    content.appendChild(list);
    content.appendChild(U.el('div', { class: 'fallback-add' }, [
      select,
      U.el('button', {
        class: 'btn small', text: 'Добавить',
        onclick: () => {
          const value = select.value;
          if (!value) return;
          const next = chain();
          if (next.includes(value)) {
            Render.toast('Уже в цепочке');
            return;
          }
          next.push(value);
          Store.setSetting('fallbackChain', next);
          select.value = '';
          renderChain();
        },
      }),
    ]));
    renderChain();
    Render.openSheet({ title: 'Резервные модели', content });
  };

  const openProfiles = () => {
    const profiles = ['fast', 'quality', 'cheap'];
    const labels = { fast: 'Быстро', quality: 'Качество', cheap: 'Дёшево' };
    const content = U.el('div', { class: 'profiles' });
    profiles.forEach((key) => {
      const select = U.el('select', { class: 'field' }, [
        U.el('option', { value: '', text: 'не задан' }),
        ...(S.models || []).map((m) => U.el('option', {
          value: (m.provider || '') + '|' + m.id,
          text: (m.provider ? m.provider + ' · ' : '') + (m.name || m.id),
          selected: (S.settings.modelProfiles || {})[key] === ((m.provider || '') + '|' + m.id) ? 'selected' : null,
        })),
      ]);
      U.$$('option[selected]', select).forEach((o) => { select.value = o.value; });
      select.addEventListener('change', () => {
        S.settings.modelProfiles = S.settings.modelProfiles || {};
        S.settings.modelProfiles[key] = select.value;
        Settings.write(S.settings);
      });
      content.appendChild(U.el('label', { class: 'field-group' }, [
        U.el('span', { class: 'field-label', text: labels[key] }), select,
      ]));
    });
    content.appendChild(U.el('button', {
      class: 'btn primary', text: 'Готово',
      onclick: () => { Render.closeSheet(); Render.toast('Профили сохранены'); },
    }));
    Render.openSheet({ title: 'Профили моделей', content });
  };

  void state;
  return {
    load, openProvidersScreen, openModelSheet, openAddProvider, openProfiles,
    openFallback, openQuota, providerCard,
  };
})();

window.ProvidersUI = ProvidersUI;