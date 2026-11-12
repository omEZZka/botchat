'use strict';

/**
 * Рендер: список чатов, экран чата, шторки, поиск.
 * Никакой сети. Только чтение S и Actions.
 */
const Render = (() => {
  let chatListEl = null;
  let chatViewEl = null;
  let rootEl = null;
  let lastChatId = null;
  let lastMessageCount = 0;
  let nearBottom = true;

  const MD = (() => {
    let ready = false;
    const setup = () => {
      if (ready || typeof marked === 'undefined') return;
      marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
      ready = true;
    };
    const render = (text) => {
      setup();
      const raw = marked.parse(String(text || ''));
      const clean = typeof DOMPurify !== 'undefined'
        ? DOMPurify.sanitize(raw, { ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel'] })
        : U.escape(text);
      return clean;
    };
    const enhance = (container) => {
      U.$$('pre code', container).forEach((code) => {
        if (code.dataset.done) return;
        code.dataset.done = '1';
        if (window.hljs) {
          try {
            hljs.highlightElement(code);
          } catch (_) {
            /* подсветка не критична */
          }
        }
        const pre = code.parentElement;
        if (pre && !pre.querySelector('.code-copy')) {
          const btn = U.el('button', { class: 'code-copy', type: 'button', title: 'Копировать' }, Icons.make('copy', 15));
          btn.addEventListener('click', () => {
            U.copyToClipboard(code.textContent || '');
            btn.classList.add('done');
            setTimeout(() => btn.classList.remove('done'), 900);
          });
          pre.classList.add('has-copy');
          pre.appendChild(btn);
        }
      });
      U.$$('a', container).forEach((a) => {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          const href = a.getAttribute('href') || '';
          if (href.startsWith('http')) Native.openLink(href);
        });
      });
    };
    return { render, enhance };
  })();

  const avatar = (name, color, size) => {
    const el = U.el('span', {
      class: 'avatar c' + (color == null ? U.colorIndex(name) : color) + (size ? ' s' + size : ''),
    }, U.initials(name));
    return el;
  };

  const iconButton = (name, title, onClick, extra) => {
    const btn = U.el('button', Object.assign({
      class: 'ibtn', type: 'button', title, 'aria-label': title,
      onclick: onClick,
    }, extra || {}), Icons.make(name, 20));
    return btn;
  };

  const sheetHost = () => U.$('#sheet-host');

  const openSheet = (options) => {
    const opts = options || {};
    const host = sheetHost();
    const sheet = U.el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
    if (opts.title) {
      sheet.appendChild(U.el('div', { class: 'sheet-head' }, [
        U.el('span', { class: 'sheet-title', text: opts.title }),
        iconButton('close', 'Закрыть', () => closeSheet()),
      ]));
    }
    const body = U.el('div', { class: 'sheet-body' });
    if (opts.content) body.appendChild(opts.content);
    sheet.appendChild(body);
    const backdrop = U.el('div', { class: 'sheet-backdrop', onclick: () => closeSheet() });
    host.appendChild(backdrop);
    host.appendChild(sheet);
    requestAnimationFrame(() => {
      sheet.classList.add('open');
      backdrop.classList.add('open');
    });
    S.sheets.push(sheet);
    bindDrag(sheet, backdrop);
    return sheet;
  };

  const closeSheet = () => {
    const host = sheetHost();
    const sheet = host.querySelector('.sheet.open');
    const backdrop = host.querySelector('.sheet-backdrop.open');
    if (sheet) {
      sheet.classList.remove('open');
      sheet.dataset.closing = '1';
    }
    if (backdrop) backdrop.classList.remove('open');
    setTimeout(() => {
      if (sheet && sheet.dataset.closing) sheet.remove();
      if (backdrop) backdrop.remove();
    }, 180);
    S.sheets = [];
  };

  const bindDrag = (sheet, backdrop) => {
    let startY = 0;
    let delta = 0;
    let startTime = 0;
    let dragging = false;
    const onStart = (ev) => {
      const point = ev.touches ? ev.touches[0] : ev;
      startY = point.clientY;
      startTime = Date.now();
      dragging = true;
      delta = 0;
      sheet.style.transition = 'none';
    };
    const onMove = (ev) => {
      if (!dragging) return;
      const point = ev.touches ? ev.touches[0] : ev;
      delta = Math.max(0, point.clientY - startY);
      sheet.style.transform = 'translateY(' + delta + 'px)';
      if (backdrop) backdrop.style.opacity = String(Math.max(0.15, 1 - delta / (sheet.offsetHeight || 400)));
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      const height = sheet.offsetHeight || 400;
      const velocity = delta / Math.max(1, Date.now() - startTime);
      if (delta > height * 0.32 || velocity > 0.8) {
        closeSheet();
      } else {
        sheet.style.transform = '';
        if (backdrop) backdrop.style.opacity = '';
      }
    };
    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: true });
    sheet.addEventListener('touchend', onEnd);
    sheet.addEventListener('touchcancel', onEnd);
  };

  const render = () => {
    U.queue(() => {
      if (!S.booted) return;
      const accent = document.documentElement;
      accent.dataset.theme = S.settings.theme;
      accent.dataset.accent = S.settings.accent;
      Accent.apply();
      const view = U.$('#view');
      if (!view) return;
      if (S.screen === 'chat' && S.chatId) {
        renderChat(view);
      } else if (S.route === 'search') {
        renderSearch(view);
      } else if (S.route === 'settings') {
        Settings2.render(view);
      } else {
        renderList(view);
      }
      renderTabbar();
    });
  };

  const renderTabbar = () => {
    const bar = U.$('#tabbar');
    if (!bar) return;
    U.clear(bar);
    const tabs = [
      { id: 'chats', icon: 'chats', label: 'Чаты' },
      { id: 'search', icon: 'search', label: 'Поиск' },
      { id: 'settings', icon: 'settings', label: 'Настройки' },
    ];
    tabs.forEach((tab) => {
      const active = tab.id === S.route;
      const btn = U.el('button', {
        class: 'tab' + (active ? ' active' : ''),
        type: 'button',
        'aria-label': tab.label,
        'aria-current': active ? 'page' : null,
        onclick: () => Actions.go(tab.id),
      }, [Icons.make(tab.icon, 22), U.el('span', { text: tab.label })]);
      bar.appendChild(btn);
    });
    bar.hidden = S.screen === 'chat' && S.route !== 'chats';
  };

  const chatStatusBadges = (chat) => {
    const badges = [];
    if (chat.status === 'running') badges.push(U.el('span', { class: 'spinner tiny', 'aria-label': 'Агент работает' }));
    if (chat.awaitingAnswer) badges.push(U.el('span', { class: 'mini-badge', text: '@', title: 'Ждёт ответа' }));
    if (chat.awaitingPermission) badges.push(U.el('span', { class: 'mini-badge warn', text: '!', title: 'Ждёт разрешения' }));
    return badges;
  };

  const renderList = (view) => {
    U.clear(view);
    const list = U.el('section', { class: 'screen list-screen' });
    const header = U.el('header', { class: 'topbar' }, [
      U.el('div', { class: 'brand' }, [
        U.el('span', { class: 'brand-mark', html: Icons.html('sparkle', 18) }),
        U.el('span', { class: 'brand-name', text: 'botCHAT' }),
      ]),
      U.el('div', { class: 'topbar-actions' }, [
        iconButton('search', 'Поиск', () => Actions.go('search')),
        iconButton('menu', 'Меню', () => Actions.openAppMenu()),
      ]),
    ]);
    list.appendChild(header);

    if (!S.online) {
      list.appendChild(U.el('div', { class: 'banner warn' }, [
        Icons.make('warn', 16),
        U.el('span', { text: 'Нет сети. История доступна, новые ответы — после подключения.' }),
      ]));
    }

    const chats = S.chats.filter((c) => !c.archived);
    if (!chats.length) {
      list.appendChild(U.el('div', { class: 'empty' }, [
        Icons.make('chats', 40),
        U.el('p', { text: 'Пока нет чатов' }),
        U.el('button', { class: 'btn primary', text: 'Создать чат', onclick: () => Actions.newChat() }),
      ]));
    } else {
      const groups = new Map();
      chats.forEach((chat) => {
        const label = U.groupLabel(chat.updatedAt || chat.createdAt);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(chat);
      });
      const container = U.el('div', { class: 'chat-list' });
      groups.forEach((items, label) => {
        container.appendChild(U.el('div', { class: 'group-label', text: label }));
        items.forEach((chat) => container.appendChild(chatRow(chat)));
      });
      list.appendChild(container);
    }

    const fab = U.el('button', {
      class: 'fab', type: 'button', 'aria-label': 'Новый чат',
      onclick: () => Actions.newChat(),
    }, Icons.make('plus', 24));
    list.appendChild(fab);
    view.appendChild(list);
    bindSwipeRows(view);
  };

  const chatRow = (chat) => {
    const unread = chat.unread || 0;
    const row = U.el('article', {
      class: 'chat-row', role: 'button', tabindex: '0',
      'data-chat': chat.id,
      onclick: () => Actions.openChat(chat.id),
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          Actions.openChat(chat.id);
        }
      },
    });
    const inner = U.el('div', { class: 'chat-row-inner' }, [
      U.el('div', { class: 'avatar-wrap' }, [
        avatar(chat.title, chat.color, 0),
        chat.pinned ? U.el('span', { class: 'pin-mark', html: Icons.html('pin', 10) }) : null,
      ]),
      U.el('div', { class: 'chat-row-main' }, [
        U.el('div', { class: 'chat-row-top' }, [
          U.el('span', { class: 'chat-title', text: chat.title }),
          U.el('span', { class: 'chat-time', text: U.listLabel(chat.updatedAt || chat.createdAt) }),
        ]),
        U.el('div', { class: 'chat-row-bottom' }, [
          U.el('span', { class: 'chat-preview', text: previewLine(chat) }),
          U.el('span', { class: 'chat-badges' }, [
            ...chatStatusBadges(chat),
            unread ? U.el('span', { class: 'badge', text: String(unread > 99 ? '99+' : unread) }) : null,
          ]),
        ]),
      ]),
    ]);
    row.appendChild(inner);
    row.appendChild(U.el('div', { class: 'swipe-actions' }, [
      U.el('button', {
        class: 'swipe-btn pin', type: 'button', 'aria-label': 'Закрепить',
        onclick: (ev) => { ev.stopPropagation(); Actions.togglePin(chat.id); },
      }, Icons.make('pin', 18)),
      U.el('button', {
        class: 'swipe-btn archive', type: 'button', 'aria-label': 'Архив',
        onclick: (ev) => { ev.stopPropagation(); Actions.toggleArchive(chat.id); },
      }, Icons.make('archive', 18)),
      U.el('button', {
        class: 'swipe-btn trash', type: 'button', 'aria-label': 'Удалить',
        onclick: (ev) => { ev.stopPropagation(); Actions.confirmDelete(chat.id); },
      }, Icons.make('trash', 18)),
    ]));
    return row;
  };

  const previewLine = (chat) => {
    if (chat.draft) return 'Черновик: ' + chat.draft;
    if (chat.status === 'running') return 'Агент работает…';
    return chat.preview || 'Нет сообщений';
  };

  const bindSwipeRows = (root) => {
    U.$$('.chat-row', root).forEach((row) => {
      let startX = 0;
      let startY = 0;
      let dragging = false;
      let dx = 0;
      row.addEventListener('touchstart', (ev) => {
        const t = ev.touches[0];
        startX = t.clientX;
        startY = t.clientY;
        dragging = false;
        dx = 0;
      }, { passive: true });
      row.addEventListener('touchmove', (ev) => {
        const t = ev.touches[0];
        const mx = t.clientX - startX;
        const my = t.clientY - startY;
        if (!dragging && Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my)) dragging = true;
        if (!dragging) return;
        dx = U.clamp(mx, -168, 0);
        const inner = row.querySelector('.chat-row-inner');
        if (inner) inner.style.transform = 'translateX(' + dx + 'px)';
      }, { passive: true });
      row.addEventListener('touchend', () => {
        if (!dragging) return;
        dragging = false;
        const inner = row.querySelector('.chat-row-inner');
        if (inner) {
          inner.style.transition = 'transform 160ms ease';
          inner.style.transform = dx < -72 ? 'translateX(-168px)' : '';
          setTimeout(() => { if (inner) inner.style.transition = ''; }, 200);
        }
        if (dx > -20) row.classList.remove('swiped');
      });
      row.addEventListener('click', () => {
        const inner = row.querySelector('.chat-row-inner');
        if (inner && inner.style.transform && inner.style.transform.includes('-168')) {
          inner.style.transform = '';
        }
      });
    });
  };

  const renderChat = (view) => {
    const chat = Store.getChat(S.chatId);
    if (!chat) {
      S.screen = 'list';
      render();
      return;
    }
    const list = S.messages.get(chat.id) || [];
    const isNewChat = lastChatId !== chat.id;

    if (isNewChat) {
      U.clear(view);
      chatViewEl = U.el('section', { class: 'screen chat-screen' });
      const header = U.el('header', { class: 'topbar chat-top' });
      header.appendChild(iconButton('back', 'Назад', () => Actions.back()));
      header.appendChild(U.el('div', { class: 'chat-head-main', onclick: () => Actions.openChatSheet() }, [
        avatar(chat.title, chat.color, 1),
        U.el('div', { class: 'chat-head-text' }, [
          U.el('span', { class: 'chat-head-title', text: chat.title }),
          U.el('span', { class: 'chat-head-sub', id: 'chat-sub', text: chatSub(chat) }),
        ]),
      ]));
      header.appendChild(U.el('div', { class: 'topbar-actions' }, [
        iconButton('model', 'Модель', () => Actions.openModelSheet()),
        iconButton('more', 'Ещё', () => Actions.openChatMenu()),
      ]));
      chatViewEl.appendChild(header);
      chatViewEl.appendChild(U.el('div', { class: 'agent-progress', id: 'agent-progress', hidden: 'hidden' }));
      chatListEl = U.el('div', { class: 'messages', id: 'messages', role: 'log', 'aria-live': 'polite' });
      chatViewEl.appendChild(chatListEl);
      const down = U.el('button', {
        class: 'scroll-down', type: 'button', 'aria-label': 'Вниз',
        onclick: () => scrollToBottom(true),
      }, [Icons.make('down', 18), U.el('span', { class: 'scroll-count', id: 'scroll-count' })]);
      chatViewEl.appendChild(down);
      chatViewEl.appendChild(U.el('div', { class: 'pending-host', id: 'pending-host', hidden: 'hidden' }));
      chatViewEl.appendChild(Composer.build());
      view.appendChild(chatViewEl);
      lastChatId = chat.id;
      lastMessageCount = 0;
      nearBottom = true;
    } else {
      chatViewEl = view.querySelector('.chat-screen');
      const sub = U.$('#chat-sub');
      if (sub) sub.textContent = chatSub(chat);
    }
    renderMessages(list, isNewChat || list.length !== lastMessageCount);
    renderProgress();
    renderPending();
    if (isNewChat || nearBottom) scrollToBottom(false);
    lastMessageCount = list.length;
    Composer.sync();
  };

  const chatSub = (chat) => {
    const provider = S.providers.find((p) => p.id === (chat.provider || S.settings.activeProvider));
    const model = chat.model || S.settings.activeModel;
    if (!model) return provider ? provider.name + ' · модель не выбрана' : 'Модель не выбрана';
    return (provider ? provider.name + ' · ' : '') + model;
  };

  const renderProgress = () => {
    const bar = U.$('#agent-progress');
    if (!bar) return;
    const agent = S.agent;
    if (!agent.running || agent.chatId !== S.chatId) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    U.clear(bar);
    const pct = agent.total ? Math.min(100, Math.round((agent.step / agent.total) * 100)) : 8;
    bar.appendChild(U.el('div', { class: 'progress-line' }, [
      U.el('span', { class: 'progress-fill', style: 'width:' + pct + '%' }),
    ]));
    bar.appendChild(U.el('div', { class: 'progress-row' }, [
      U.el('span', {
        class: 'progress-label',
        text: (agent.label || 'Агент работает') + (agent.total ? ' · шаг ' + agent.step + ' из ' + agent.total : ''),
      }),
      U.el('div', { class: 'progress-actions' }, [
        iconButton(agent.paused ? 'play' : 'pause', agent.paused ? 'Продолжить' : 'Пауза', () => Agent.togglePause()),
        iconButton('graph', 'Граф задач', () => Actions.openTaskGraph()),
        iconButton('stop', 'Стоп', () => Agent.stop()),
      ]),
    ]));
    const todos = agent.todos || [];
    if (todos.length) {
      const panel = U.el('details', { class: 'todo-panel' }, [
        U.el('summary', {}, 'План: ' + todos.filter((t) => t.status === 'done').length + ' из ' + todos.length),
      ]);
      todos.forEach((t) => {
        panel.appendChild(U.el('div', { class: 'todo-item ' + t.status }, [
          t.status === 'done' ? Icons.make('check', 14) : Icons.make('todo', 14),
          U.el('span', { text: t.text }),
        ]));
      });
      bar.appendChild(panel);
    }
  };

  const renderPending = () => {
    const host = U.$('#pending-host');
    if (!host) return;
    const pending = S.pending;
    if (!pending) {
      host.hidden = true;
      U.clear(host);
      return;
    }
    host.hidden = false;
    U.clear(host);
    if (pending.type === 'permission') {
      const call = pending.call || {};
      const args = call.args || {};
      const detail = call.name === 'bash' ? (args.command || '') : (args.path || args.url || '');
      host.appendChild(U.el('div', { class: 'pending-card' }, [
        U.el('div', { class: 'pending-head' }, [
          Icons.make('shield', 16),
          U.el('span', { text: 'Нужно разрешение: ' + call.name }),
        ]),
        detail ? U.el('pre', { class: 'pending-detail' }, [U.el('code', { text: detail })]) : null,
        U.el('div', { class: 'pending-actions' }, [
          U.el('button', {
            class: 'btn small primary', text: 'Разрешить раз',
            onclick: () => Actions.resolvePermission('allow'),
          }),
          U.el('button', {
            class: 'btn small', text: 'Всегда',
            onclick: () => Actions.resolvePermission('always'),
          }),
          U.el('button', {
            class: 'btn small danger-ghost', text: 'Отклонить',
            onclick: () => Actions.resolvePermission('deny'),
          }),
        ]),
      ]));
      return;
    }
    if (pending.type === 'choice') {
      const card = U.el('div', { class: 'pending-card' }, [
        U.el('div', { class: 'pending-head' }, [Icons.make('sparkle', 16), U.el('span', { text: pending.title || 'Выберите вариант' })]),
      ]);
      (pending.options || []).forEach((option) => {
        card.appendChild(U.el('button', {
          class: 'btn small full', text: option.label || option,
          onclick: () => Actions.resolvePermission(option.value || option),
        }));
      });
      host.appendChild(card);
    }
  };

  const scrollToBottom = (smooth) => {
    if (!chatListEl) return;
    if (typeof chatListEl.scrollTo === 'function') {
      chatListEl.scrollTo({
        top: chatListEl.scrollHeight,
        behavior: smooth && !U.isReducedMotion() ? 'smooth' : 'auto',
      });
    } else {
      chatListEl.scrollTop = chatListEl.scrollHeight;
    }
    nearBottom = true;
    const btn = U.$('.scroll-down');
    if (btn) btn.classList.remove('show');
    const count = U.$('#scroll-count');
    if (count) count.textContent = '';
  };

  const renderMessages = (list, force) => {
    if (!chatListEl) return;
    const settings = S.settings;
    const windowSize = settings.windowSize || 60;
    if (!force && list.length === lastMessageCount) {
      const tail = list.slice(-4);
      tail.forEach((msg) => patchMessage(msg));
      return;
    }
    const keepScroll = chatListEl.scrollTop + chatListEl.clientHeight >= chatListEl.scrollHeight - 80;
    U.clear(chatListEl);
    const visible = list.slice(-windowSize);
    let lastDay = '';
    let lastRole = '';
    visible.forEach((msg, i) => {
      const dayKey = U.dayKey(msg.ts);
      if (dayKey !== lastDay) {
        chatListEl.appendChild(U.el('div', { class: 'date-sep', text: U.dayLabel(msg.ts) }));
        lastDay = dayKey;
        lastRole = '';
      }
      const node = messageNode(msg, lastRole);
      chatListEl.appendChild(node);
      lastRole = msg.role;
      if (i === visible.length - 1 && msg.role === 'assistant' && msg.streaming) {
        chatListEl.appendChild(U.el('div', { class: 'typing', id: 'typing', 'aria-label': 'Агент печатает' }, [
          U.el('span'), U.el('span'), U.el('span'),
        ]));
      }
    });
    const typing = U.$('#typing');
    if (typing) typing.remove();
    if (keepScroll || force) scrollToBottom(false);
  };

  const patchMessage = (msg) => {
    const node = U.$('[data-msg="' + msg.id + '"]');
    if (!node) return;
    const bubble = node.querySelector('.bubble-text');
    if (bubble && msg.kind !== 'tool' && msg.role === 'assistant') {
      bubble.innerHTML = MD.render(msg.text || '') || '<span class="muted">…</span>';
      MD.enhance(bubble);
    }
    const status = node.querySelector('.msg-status');
    if (status) status.innerHTML = statusHtml(msg);
    let tools = node.querySelector('.tool-cards');
    if (msg.tools && msg.tools.length) {
      if (!tools) {
        const bubble = node.querySelector('.bubble');
        if (bubble) {
          tools = U.el('div', { class: 'tool-cards' });
          bubble.appendChild(tools);
        }
      }
      if (tools) renderToolCards(tools, msg);
    }
    const streamTail = U.$('#typing');
    if (msg.streaming && !streamTail && chatListEl) {
      chatListEl.appendChild(U.el('div', { class: 'typing', id: 'typing' }, [
        U.el('span'), U.el('span'), U.el('span'),
      ]));
    }
    if (!msg.streaming && streamTail) streamTail.remove();
    if (nearBottom) scrollToBottom(false);
  };

  const messageNode = (msg, prevRole) => {
    if (msg.role === 'system') {
      return U.el('div', { class: 'system-note', text: msg.text || '' });
    }
    const groupTail = prevRole === msg.role;
    const node = U.el('div', {
      class: 'msg ' + msg.role + (groupTail ? ' tail-same' : '') + (msg.kind === 'tool' ? ' tool-msg' : ''),
      'data-msg': msg.id,
      'data-ts': msg.ts,
    });
    node.appendChild(U.el('div', { class: 'bubble' }, bubbleChildren(msg)));
    node.appendChild(U.el('div', { class: 'msg-meta' }, [
      msg.replyTo ? U.el('div', { class: 'reply-quote' }, [
        U.el('span', { class: 'reply-author', text: msg.replyTo.author || 'Сообщение' }),
        U.el('span', { class: 'reply-text', text: U.truncate(msg.replyTo.text || '', 90) }),
      ]) : null,
      U.el('div', { class: 'meta-row' }, [
        U.el('span', { class: 'msg-time', text: U.time(msg.ts) }),
        msg.role === 'user' ? U.el('span', { class: 'msg-status', html: statusHtml(msg) }) : null,
      ]),
    ]));
    bindBubble(msg, node);
    return node;
  };

  const bubbleChildren = (msg) => {
    const out = [];
    if (msg.role === 'assistant' && msg.kind === 'text') {
      const text = U.el('div', { class: 'bubble-text' });
      text.innerHTML = MD.render(msg.text || '');
      MD.enhance(text);
      out.push(text);
    } else if (msg.role === 'user') {
      const right = U.el('div', { class: 'bubble-text plain', text: msg.text || '' });
      out.push(right);
    } else {
      out.push(U.el('div', { class: 'bubble-text', text: msg.text || '' }));
    }
    if (msg.attachments && msg.attachments.length) out.push(attachmentsBlock(msg.attachments));
    if (msg.tools && msg.tools.length) {
      const cards = U.el('div', { class: 'tool-cards' });
      renderToolCards(cards, msg);
      out.push(cards);
    }
    if (msg.error) out.push(U.el('div', { class: 'msg-error', text: msg.error }));
    return out;
  };

  const statusHtml = (msg) => {
    if (msg.role !== 'user') return '';
    if (msg.status === 'error') return Icons.html('error', 13);
    if (msg.status === 'sending') return Icons.html('clock', 13);
    if (msg.status === 'queued') return Icons.html('clock', 13);
    if (msg.status === 'sent') return Icons.html('check', 13);
    return Icons.html('checkDouble', 13);
  };

  const attachmentsBlock = (items) => {
    const wrap = U.el('div', { class: 'attachments' });
    items.forEach((att) => {
      const ext = U.ext(att.name || att.path || '');
      const isImage = (att.mime || '').startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
      if (isImage) {
        const img = U.el('img', { class: 'att-image', alt: att.name || 'изображение', loading: 'lazy' });
        if (att.dataUrl) img.src = att.dataUrl;
        wrap.appendChild(U.el('figure', { class: 'att-figure' }, [img, U.el('figcaption', { text: att.name || '' })]));
      } else {
        wrap.appendChild(U.el('a', {
          class: 'att-chip', href: '#', onclick: (ev) => { ev.preventDefault(); Actions.openAttachment(att); },
        }, [
          Icons.make(isPdf(att) ? 'pdf' : 'file', 16),
          U.el('span', { class: 'att-name', text: att.name || 'файл' }),
          U.el('span', { class: 'att-size', text: U.bytes(att.size || 0) }),
        ]));
      }
    });
    return wrap;
  };

  const isPdf = (att) => (att.mime || '').includes('pdf') || U.ext(att.name || '') === 'pdf';

  const toolTitle = (tool) => {
    const input = tool.input || {};
    switch (tool.name) {
      case 'bash': return input.command || 'команда';
      case 'read': return input.path || 'файл';
      case 'write': return input.path || 'файл';
      case 'edit': return input.path || 'файл';
      case 'grep': return input.pattern || 'поиск';
      case 'glob': return input.pattern || 'шаблон';
      case 'list': return input.path || '.';
      case 'webfetch': return input.url || 'url';
      case 'todo': return 'план';
      case 'task': return input.description || input.role || 'субагент';
      default: return tool.name;
    }
  };

  const toolSummary = (tool) => {
    const meta = tool.metadata || {};
    switch (tool.name) {
      case 'read': return (meta.lines || 0) + ' ' + U.plural(meta.lines || 0, 'строка', 'строки', 'строк');
      case 'edit': return U.formatDelta(meta.added, meta.removed);
      case 'grep': return String(meta.matches == null ? tool.output || '' : meta.matches) + ' совп.';
      case 'glob': return (meta.files == null ? 0 : meta.files) + ' ' + U.plural(meta.files || 0, 'файл', 'файла', 'файлов');
      case 'list': return (meta.entries == null ? 0 : meta.entries) + ' элем.';
      case 'bash': return tool.metadata && tool.metadata.exit === 0 ? 'успех' : (tool.metadata && tool.metadata.exit != null ? 'код ' + tool.metadata.exit : '');
      case 'webfetch': return meta.status ? 'HTTP ' + meta.status : '';
      case 'task': return tool.state.status === 'running' ? 'работает' : (tool.state.status === 'completed' ? 'готово' : tool.state.status);
      case 'todo': return (meta.items || 0) + ' задач';
      default: return '';
    }
  };

  const renderToolCards = (host, msg) => {
    U.clear(host);
    (msg.tools || []).forEach((tool) => {
      host.appendChild(toolCard(tool));
    });
  };

  const toolCard = (tool) => {
    const state = tool.state || {};
    const status = state.status || 'pending';
    const open = status === 'running' || (tool.uiOpen === true);
    const card = U.el('details', { class: 'tool-card ' + status, 'data-tool': tool.id });
    if (open) card.open = true;
    const summary = U.el('summary', { class: 'tool-head' }, [
      U.el('span', { class: 'tool-icon' }, toolIcon(tool.name, status)),
      U.el('span', { class: 'tool-name', text: tool.name }),
      U.el('span', { class: 'tool-title', text: U.truncate(toolTitle(tool), 48) }),
      U.el('span', { class: 'tool-meta', text: toolSummary(tool) }),
      status === 'running' ? U.el('span', { class: 'spinner tiny' }) : null,
    ]);
    card.appendChild(summary);
    const body = U.el('div', { class: 'tool-body' });
    if (tool.name === 'bash') {
      body.appendChild(U.el('pre', { class: 'code-block' }, [U.el('code', { text: (tool.input || {}).command || '' })]));
      if (tool.output) {
        body.appendChild(U.el('div', { class: 'tool-output-label', text: 'Вывод' }));
        body.appendChild(U.el('pre', { class: 'tool-output' }, [U.el('code', { text: tool.output })]));
      }
    } else if (tool.name === 'edit') {
      body.appendChild(U.el('div', { class: 'diff-head' }, [
        U.el('span', { text: (tool.input || {}).path || '' }),
        U.el('span', { class: 'diff-stat', text: U.formatDelta((tool.metadata || {}).added, (tool.metadata || {}).removed) }),
      ]));
      if (tool.metadata && tool.metadata.diff) {
        body.appendChild(U.el('pre', { class: 'diff-body', html: diffHtml(tool.metadata.diff) }));
      }
    } else if (tool.name === 'task') {
      body.appendChild(U.el('div', { class: 'task-line' }, [
        U.el('span', { class: 'task-role', text: (tool.input || {}).role || 'субагент' }),
        U.el('span', { class: 'task-status ' + status, text: statusText(status) }),
      ]));
      if (tool.output) body.appendChild(U.el('div', { class: 'tool-output-text', text: tool.output }));
    } else {
      if (tool.input && Object.keys(tool.input).length) {
        body.appendChild(U.el('pre', { class: 'tool-input' }, [U.el('code', { text: JSON.stringify(tool.input, null, 2) })]));
      }
      if (tool.output) {
        body.appendChild(U.el('pre', { class: 'tool-output' }, [U.el('code', { text: tool.output })]));
      }
    }
    if (state.error) body.appendChild(U.el('div', { class: 'tool-error', text: state.error }));
    card.appendChild(body);
    card.addEventListener('toggle', () => {
      tool.uiOpen = card.open;
    });
    return card;
  };

  const diffHtml = (diff) => String(diff).split('\n').map((line) => {
    const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : 'ctx';
    return '<span class="diff-line ' + cls + '">' + U.escape(line) + '</span>';
  }).join('');

  const toolIcon = (name, status) => {
    if (status === 'running') return Icons.html('refresh', 15);
    if (status === 'error') return Icons.html('error', 15);
    const map = {
      bash: 'terminal', read: 'eye', write: 'save', edit: 'edit', grep: 'search',
      glob: 'folder', list: 'folder', webfetch: 'globe', todo: 'todo', task: 'task',
    };
    return Icons.html(map[name] || 'code', 15);
  };

  const statusText = (status) => ({
    pending: 'ожидает', running: 'работает', completed: 'готово', error: 'ошибка', queued: 'в очереди',
  }[status] || status);

  const bindBubble = (msg, node) => {
    let startX = 0;
    let startY = 0;
    let dragging = false;
    const bubble = node.querySelector('.bubble');

    node.addEventListener('touchstart', (ev) => {
      const t = ev.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      dragging = false;
    }, { passive: true });
    node.addEventListener('touchmove', (ev) => {
      const t = ev.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!dragging && dx > 14 && Math.abs(dx) > Math.abs(dy)) dragging = true;
      if (!dragging) return;
      if (bubble) bubble.style.transform = 'translateX(' + Math.min(dx, 64) + 'px)';
    }, { passive: true });
    node.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      if (bubble) {
        bubble.style.transition = 'transform 140ms ease';
        bubble.style.transform = '';
        setTimeout(() => { if (bubble) bubble.style.transition = ''; }, 160);
      }
      Actions.replyTo(msg);
    });

    let timer = null;
    const startPress = () => {
      timer = setTimeout(() => Actions.messageMenu(msg), 480);
    };
    const cancelPress = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    node.addEventListener('touchstart', startPress, { passive: true });
    node.addEventListener('touchend', cancelPress);
    node.addEventListener('touchmove', cancelPress, { passive: true });
    node.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      Actions.messageMenu(msg);
    });
  };

  const renderSearch = (view) => {
    U.clear(view);
    const section = U.el('section', { class: 'screen search-screen' });
    section.appendChild(U.el('header', { class: 'topbar' }, [
      U.el('h1', { class: 'screen-title', text: 'Поиск' }),
    ]));
    const input = U.el('input', {
      class: 'search-input', type: 'search', placeholder: 'По чатам и сообщениям',
      value: S.search.query, 'aria-label': 'Поиск',
    });
    const results = U.el('div', { class: 'search-results' });
    let timer = null;
    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        Store.search(input.value);
        fillSearch(results, input.value);
      }, 120);
    });
    section.appendChild(U.el('div', { class: 'search-bar' }, [Icons.make('search', 18), input]));
    section.appendChild(results);
    fillSearch(results, S.search.query);
    view.appendChild(section);
    setTimeout(() => input.focus(), 80);
  };

  const fillSearch = (host, query) => {
    U.clear(host);
    const q = String(query || '').trim();
    if (!q) {
      host.appendChild(U.el('div', { class: 'empty small' }, [Icons.make('search', 32), U.el('p', { text: 'Начните вводить запрос' })]));
      return;
    }
    const results = S.search.results || [];
    if (!results.length) {
      host.appendChild(U.el('div', { class: 'empty small' }, [U.el('p', { text: 'Ничего не найдено' })]));
      return;
    }
    results.forEach(({ chat, count }) => {
      const hits = Store.messageHits(chat.id, q).slice(-3).reverse();
      const block = U.el('div', { class: 'search-group' }, [
        U.el('div', { class: 'search-chat', onclick: () => Actions.openChatAt(chat.id, hits[0]) }, [
          avatar(chat.title, chat.color, 2),
          U.el('div', { class: 'search-chat-main' }, [
            U.el('span', { class: 'search-chat-title', text: chat.title }),
            U.el('span', { class: 'search-chat-count', text: count + ' ' + U.plural(count, 'совпадение', 'совпадения', 'совпадений') }),
          ]),
        ]),
      ]);
      hits.forEach((msg) => {
        const snippet = U.el('div', { class: 'search-hit' }, [
          U.el('span', { class: 'search-hit-time', text: U.time(msg.ts) }),
          U.el('span', { class: 'search-hit-text', text: U.truncate(msg.text || '', 160) }),
        ]);
        U.highlight(snippet, q);
        snippet.addEventListener('click', () => Actions.openChatAt(chat.id, msg));
        block.appendChild(snippet);
      });
      host.appendChild(block);
    });
  };

  const toast = (text) => {
    const host = U.$('#toast-host');
    if (!host) return;
    U.clear(host);
    const item = U.el('div', { class: 'toast', text });
    host.appendChild(item);
    requestAnimationFrame(() => item.classList.add('show'));
    setTimeout(() => {
      item.classList.remove('show');
      setTimeout(() => item.remove(), 200);
    }, 2200);
  };

  const confirm = (options) => {
    const opts = options || {};
    const content = U.el('div', { class: 'confirm' }, [
      U.el('p', { text: opts.text || 'Вы уверены?' }),
      U.el('div', { class: 'confirm-actions' }, [
        U.el('button', {
          class: 'btn', text: opts.cancelText || 'Отмена',
          onclick: () => closeSheet(),
        }),
        U.el('button', {
          class: 'btn ' + (opts.danger ? 'danger' : 'primary'), text: opts.okText || 'Подтвердить',
          onclick: () => {
            closeSheet();
            if (opts.onOk) opts.onOk();
          },
        }),
      ]),
    ]);
    openSheet({ title: opts.title || 'Подтверждение', content });
  };

  const prompt = (options) => {
    const opts = options || {};
    const input = U.el('textarea', {
      class: 'field textarea', rows: 3, placeholder: opts.placeholder || '',
      value: opts.value || '',
    });
    const content = U.el('div', { class: 'confirm' }, [
      opts.label ? U.el('label', { class: 'field-label', text: opts.label }) : null,
      input,
      U.el('div', { class: 'confirm-actions' }, [
        U.el('button', { class: 'btn', text: 'Отмена', onclick: () => closeSheet() }),
        U.el('button', {
          class: 'btn primary', text: opts.okText || 'Сохранить',
          onclick: () => {
            const value = input.value.trim();
            closeSheet();
            if (opts.onOk) opts.onOk(value);
          },
        }),
      ]),
    ]);
    openSheet({ title: opts.title || 'Ввод', content });
    setTimeout(() => input.focus(), 100);
  };

  const bind = () => {
    Bus.on('render', render);
    Bus.on('chat:open', () => render());
    Bus.on('chats:changed', () => {
      if (S.screen === 'list') render();
    });
    Bus.on('agent:changed', () => {
      renderProgress();
      renderTabbar();
      renderPending();
    });
    Bus.on('permission:changed', () => renderPending());
    Bus.on('message:updated', ({ chatId, message }) => {
      if (chatId === S.chatId) patchMessage(message);
    });
    Bus.on('toast', toast);
    const messagesHost = () => chatListEl;
    document.addEventListener('scroll', () => {}, true);
    const attachScroll = () => {
      if (!chatListEl || chatListEl.dataset.bound) return;
      chatListEl.dataset.bound = '1';
      chatListEl.addEventListener('scroll', () => {
        const distance = chatListEl.scrollHeight - chatListEl.scrollTop - chatListEl.clientHeight;
        nearBottom = distance < 80;
        const btn = U.$('.scroll-down');
        if (btn) {
          btn.classList.toggle('show', distance > 400);
          const count = U.$('#scroll-count');
          if (count && distance > 400) {
            const unseen = Math.max(0, (S.messages.get(S.chatId) || []).length - lastMessageCount);
            count.textContent = unseen > 0 ? String(unseen) : '';
          }
        }
      }, { passive: true });
    };
    Bus.on('render', attachScroll);
    void messagesHost;
  };

  return {
    bind, render, openSheet, closeSheet, toast, confirm, prompt,
    avatar, iconButton, MD, scrollToBottom, renderProgress,
    statusText, toolCard, sheetHost,
  };
})();

window.Render = Render;