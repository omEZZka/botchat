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
    const status = provider.hasKey ? 'ключ есть' : (provider.needsKey ? 'ключа нет' : 'без ключа');
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
    const res = await Native.api('providers.health', { providerId: provider.id });
    if (button) button.disabled = false;
    if (res && res.ok) {
      provider.healthy = res.healthy;
      provider.modelCount = res.modelCount || provider.modelCount;
      Render.toast(res.healthy ? 'Подключение работает' : 'Подключение не удалось');
      Bus.emit('render');
    } else {
      Render.toast((res && res.error) || 'Проверка не удалась');
    }
  };

  const disableProvider = async (provider) => {
    await Native.api('keys.wipe', { providerId: provider.id });
    await load();
    Render.toast('Провайдер отключён');
  };

  const openAddProvider = () => {
    const fields = {};
    const mk = (name, placeholder, type) => {
      const input = U.el('input', {
        class: 'field', type: type || 'text', placeholder: placeholder || '',
        autocomplete: 'off', spellcheck: 'false',
      });
      fields[name] = input;
      return U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: name }), input]);
    };
    const typeSelect = U.el('select', { class: 'field' }, [
      U.el('option', { value: 'openai-compatible', text: 'openai-compatible' }),
      U.el('option', { value: 'anthropic', text: 'anthropic' }),
      U.el('option', { value: 'gemini', text: 'gemini' }),
    ]);
    const probe = U.el('div', { class: 'probe-models' });
    const headersGroup = U.el('label', { class: 'field-group' }, [
      U.el('span', { class: 'field-label', text: 'Доп. заголовки (JSON)' }),
      U.el('textarea', { class: 'field textarea', rows: 3, placeholder: '{"X-Title":"botCHAT"}' }),
    ]);
    const headersInput = headersGroup.querySelector('textarea');
    const content = U.el('div', { class: 'add-provider' }, [
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'ID (латиница)' }), fields.id = U.el('input', { class: 'field', placeholder: 'my-provider' })]),
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Отображаемое имя' }), fields.name = U.el('input', { class: 'field', placeholder: 'Мой провайдер' })]),
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Base URL' }), fields.baseUrl = U.el('input', { class: 'field', placeholder: 'https://api.example.com/v1' })]),
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'Тип API' }), typeSelect]),
      headersGroup,
      U.el('label', { class: 'field-group' }, [U.el('span', { class: 'field-label', text: 'API-ключ' }), fields.key = U.el('input', { class: 'field', type: 'password', placeholder: 'sk-…' })]),
      U.el('button', {
        class: 'btn', text: 'Прозвонить',
        onclick: async () => {
          U.clear(probe);
          probe.appendChild(U.el('div', { class: 'probe-row' }, [U.el('span', { class: 'spinner tiny' }), U.el('span', { text: 'Запрашиваю модели…' })]));
          const res = await Native.api('providers.probe', {
            baseUrl: fields.baseUrl.value.trim(),
            apiType: typeSelect.value,
            key: fields.key.value.trim(),
            headers: U.safeJson(headersInput.value || '{}', {}),
          });
          U.clear(probe);
          if (!res || !res.ok) {
            probe.appendChild(U.el('p', { class: 'muted small', text: (res && res.error) || 'Не удалось получить список' }));
            return;
          }
          const models = res.models || [];
          if (!models.length) {
            probe.appendChild(U.el('p', { class: 'muted small', text: 'Моделей не найдено' }));
            return;
          }
          probe.appendChild(U.el('p', { class: 'muted small', text: 'Найдено: ' + models.length }));
          models.forEach((model) => {
            const cb = U.el('input', { type: 'checkbox', checked: 'checked' });
            const row = U.el('label', { class: 'probe-model' }, [cb, U.el('span', { text: model.id })]);
            row.dataset.model = model.id;
            probe.appendChild(row);
          });
        },
      }),
      U.el('button', {
        class: 'btn primary', text: 'Сохранить и подключить',
        onclick: async () => {
          const id = fields.id.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
          const name = fields.name.value.trim() || id;
          const baseUrl = fields.baseUrl.value.trim();
          if (!id || !baseUrl) {
            Render.toast('Заполните ID и Base URL');
            return;
          }
          const picked = U.$$('.probe-model input:checked', probe).map((cb) => cb.parentElement.dataset.model);
          const res = await Native.api('providers.add', {
            id, name, baseUrl,
            apiType: typeSelect.value,
            headers: U.safeJson(headersInput.value || '{}', {}),
            key: fields.key.value.trim(),
            models: picked,
          });
          if (res && res.ok) {
            Render.closeSheet();
            await load();
            Render.toast('Провайдер подключён');
          } else {
            Render.toast((res && res.error) || 'Не удалось сохранить');
          }
        },
      }),
    ]);
    Render.openSheet({ title: 'Добавить провайдера', content });
  };

  const openProvidersScreen = () => {
    const content = U.el('div', { class: 'providers-screen' });
    const connected = S.providers.filter((p) => p.hasKey || !p.needsKey);
    const others = S.providers.filter((p) => !p.hasKey && p.needsKey);
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
    const search = U.el('input', { class: 'field', type: 'search', placeholder: 'Поиск модели' });
    const list = U.el('div', { class: 'model-list' });
    const renderList = (query) => {
      U.clear(list);
      const q = String(query || '').toLowerCase();
      const grouped = new Map();
      (S.models || []).forEach((model) => {
        if (q && !(model.id + ' ' + (model.name || '')).toLowerCase().includes(q)) return;
        const providerId = model.provider || '';
        if (!grouped.has(providerId)) grouped.set(providerId, []);
        grouped.get(providerId).push(model);
      });
      if (!grouped.size) {
        list.appendChild(U.el('p', { class: 'muted small', text: 'Модели не загружены. Проверьте провайдера в настройках.' }));
        return;
      }
      grouped.forEach((models, providerId) => {
        const provider = S.providers.find((p) => p.id === providerId);
        list.appendChild(U.el('div', { class: 'model-group-label', text: provider ? provider.name : providerId }));
        models.forEach((model) => {
          const active = chat && chat.model === model.id && (chat.provider || S.settings.activeProvider) === providerId;
          const row = U.el('button', {
            class: 'model-row' + (active ? ' active' : ''), type: 'button',
            onclick: async () => {
              await Store.setChatModel(S.chatId, providerId, model.id);
              S.settings.activeProvider = providerId;
              S.settings.activeModel = model.id;
              Settings.write(S.settings);
              Render.closeSheet();
              Bus.emit('render');
            },
          }, [
            Icons.make(active ? 'check' : 'model', 16),
            U.el('span', { class: 'model-name', text: model.name || model.id }),
            U.el('span', { class: 'model-meta', text: (model.context ? Math.round(model.context / 1000) + 'k' : '') + (model.reasoning ? ' · reasoning' : '') }),
          ]);
          list.appendChild(row);
        });
      });
    };
    search.addEventListener('input', () => renderList(search.value));
    content.appendChild(search);
    content.appendChild(list);
    content.appendChild(U.el('div', { class: 'model-footer' }, [
      U.el('button', {
        class: 'btn small', text: 'Профили',
        onclick: () => { Render.closeSheet(); openProfiles(); },
      }),
      U.el('button', {
        class: 'btn small', text: 'Провайдеры',
        onclick: () => { Render.closeSheet(); openProvidersScreen(); },
      }),
      U.el('button', {
        class: 'btn small', text: 'Резерв',
        onclick: () => { Render.closeSheet(); openFallback(); },
      }),
      U.el('button', { class: 'btn small', text: 'Обновить', onclick: () => refreshModels(search.value) }),
    ]));
    const refreshModels = async (query) => {
      const res = await Native.api('models.refresh');
      if (res && res.ok) {
        S.models = res.models || S.models;
        renderList(query);
        Render.toast('Список моделей обновлён');
      } else {
        Render.toast((res && res.error) || 'Не удалось обновить');
      }
    };
    renderList('');
    Render.openSheet({ title: 'Модель', content });
    if (!(S.models || []).length) refreshModels('');
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
    openFallback, providerCard,
  };
})();

window.ProvidersUI = ProvidersUI;