'use strict';

/**
 * Композер: авторасширение, вложения, микрофон, кнопка отправка/стоп, черновик.
 */
const Composer = (() => {
  let textarea = null;
  let host = null;
  let attachments = [];
  let recording = null;

  const build = () => {
    host = U.el('div', { class: 'composer' });
    const replyBar = U.el('div', { class: 'reply-bar', id: 'reply-bar', hidden: 'hidden' });
    attachments = [];
    const attachRow = U.el('div', { class: 'composer-attachments', id: 'composer-attachments', hidden: 'hidden' });

    textarea = U.el('textarea', {
      class: 'composer-input', id: 'composer-input', rows: 1,
      placeholder: t('chat.placeholder'), 'aria-label': t('chat.placeholder'),
      oninput: () => {
        autoGrow();
        const chatId = S.chatId;
        if (chatId) Store.setDraft(chatId, textarea.value);
        syncSend();
      },
      onkeydown: (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey && S.settings.sendOnEnter) {
          ev.preventDefault();
          send();
        }
      },
    });

    const left = U.el('div', { class: 'composer-left' }, [
      iconButton('clip', 'Вложение', () => openAttachMenu()),
      iconButton('mic', 'Голос', () => toggleMic()),
    ]);

    const sendBtn = U.el('button', {
      class: 'composer-send', type: 'button', id: 'composer-send', 'aria-label': 'Отправить',
      onclick: () => send(),
    }, Icons.make('send', 20));

    host.appendChild(replyBar);
    host.appendChild(attachRow);
    host.appendChild(U.el('div', { class: 'composer-row' }, [
      left,
      U.el('div', { class: 'composer-field' }, [textarea, U.el('div', { class: 'composer-counters', id: 'composer-counters' })]),
      sendBtn,
    ]));
    return host;
  };

  const iconButton = (name, title, handler) => U.el('button', {
    class: 'ibtn', type: 'button', title, 'aria-label': title, onclick: handler,
  }, Icons.make(name, 20));

  const autoGrow = () => {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
  };

  const sync = () => {
    if (!textarea) return;
    const chatId = S.chatId;
    const draft = chatId ? (S.drafts[chatId] || '') : '';
    if (textarea.value !== draft && document.activeElement !== textarea) {
      textarea.value = draft;
      autoGrow();
    }
    syncSend();
    renderReply();
    renderAttachments();
  };

  const syncSend = () => {
    const btn = U.$('#composer-send');
    if (!btn) return;
    const running = S.agent.running && S.agent.chatId === S.chatId;
    const hasText = textarea && textarea.value.trim().length > 0;
    U.clear(btn);
    if (running) {
      btn.appendChild(Icons.make('stop', 20));
      btn.classList.add('stop');
      btn.setAttribute('aria-label', t('chat.stop'));
      btn.title = t('chat.stop');
    } else {
      btn.appendChild(Icons.make('send', 20));
      btn.classList.remove('stop');
      btn.setAttribute('aria-label', t('chat.send'));
      btn.title = t('chat.send');
    }
    btn.classList.toggle('ready', hasText || attachments.length > 0 || running);
    const counters = U.$('#composer-counters');
    if (counters) {
      const len = textarea ? textarea.value.length : 0;
      counters.textContent = len > 1500 ? String(len) : '';
    }
  };

  const send = async () => {
    if (!textarea) return;
    const running = S.agent.running && S.agent.chatId === S.chatId;
    if (running) {
      Agent.stop();
      return;
    }
    const text = textarea.value.trim();
    if (!text && !attachments.length) return;
    const chatId = S.chatId;
    if (!chatId) return;
    const pending = { text, attachments: attachments.slice(), replyTo: S.pendingReply || null };
    textarea.value = '';
    autoGrow();
    attachments = [];
    S.pendingReply = null;
    Store.setDraft(chatId, '');
    renderAttachments();
    renderReply();
    syncSend();
    await Agent.send(chatId, pending);
  };

  const renderReply = () => {
    const bar = U.$('#reply-bar');
    if (!bar) return;
    const reply = S.pendingReply;
    if (!reply) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    U.clear(bar);
    bar.appendChild(U.el('div', { class: 'reply-bar-main' }, [
      U.el('span', { class: 'reply-author', text: reply.author || (reply.role === 'user' ? 'Вы' : 'Агент') }),
      U.el('span', { class: 'reply-text', text: U.truncate(reply.text || '', 80) }),
    ]));
    bar.appendChild(iconButton('close', 'Отменить ответ', () => {
      S.pendingReply = null;
      renderReply();
    }));
  };

  const renderAttachments = () => {
    const row = U.$('#composer-attachments');
    if (!row) return;
    if (!attachments.length) {
      row.hidden = true;
      U.clear(row);
      return;
    }
    row.hidden = false;
    U.clear(row);
    attachments.forEach((att, idx) => {
      row.appendChild(U.el('div', { class: 'comp-att' }, [
        Icons.make((att.mime || '').startsWith('image/') ? 'image' : 'file', 14),
        U.el('span', { class: 'comp-att-name', text: att.name }),
        U.el('button', {
          class: 'comp-att-x', type: 'button', 'aria-label': 'Убрать',
          onclick: () => {
            attachments.splice(idx, 1);
            renderAttachments();
            syncSend();
          },
        }, Icons.make('close', 12)),
      ]));
    });
  };

  const openAttachMenu = () => {
    const content = U.el('div', { class: 'att-menu' });
    const add = async (kind) => {
      Render.closeSheet();
      const res = await Native.pick(kind);
      if (res && res.ok) {
        const items = (res.items || []).map((item) => Object.assign({}, item));
        for (const item of items) {
          if ((item.mime || '').startsWith('image/') && item.path) {
            const read = await Native.fs.readBase64(item.path, 4 * 1024 * 1024);
            if (read && read.ok && read.base64) {
              item.dataUrl = 'data:' + (item.mime || 'image/png') + ';base64,' + read.base64;
            }
          }
          attachments.push(item);
        }
        renderAttachments();
        syncSend();
      }
    };
    content.appendChild(U.el('button', { class: 'att-option', type: 'button', onclick: () => add('image') }, [
      Icons.make('image', 20), U.el('span', { text: 'Фото' }),
    ]));
    content.appendChild(U.el('button', { class: 'att-option', type: 'button', onclick: () => add('file') }, [
      Icons.make('file', 20), U.el('span', { text: 'Файл или PDF' }),
    ]));
    Render.openSheet({ title: 'Прикрепить', content });
  };

  const toggleMic = () => {
    if (recording) {
      clearInterval(recording.timer);
      recording = null;
      Render.toast('Голосовой ввод недоступен в этой сборке');
      return;
    }
    Render.toast('Голосовой ввод появится в следующей версии');
  };

  const focus = () => {
    if (textarea) textarea.focus();
  };

  const setText = (text) => {
    if (!textarea) return;
    textarea.value = text;
    autoGrow();
    syncSend();
  };

  return { build, sync, focus, setText, send, renderReply };
})();

/**
 * Инкрементальный стрим в пузырь: батчинг кадров, без полного ре-рендера.
 */
const ChatStream = (() => {
  const pending = new Map();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const batch = Array.from(pending.entries());
    pending.clear();
    for (const [messageId, text] of batch) {
      const msg = findMessage(messageId);
      if (!msg) continue;
      msg.text = text;
      msg.streaming = true;
      const node = U.$('[data-msg="' + messageId + '"]');
      if (!node) {
        Bus.emit('render');
        continue;
      }
      const bubble = node.querySelector('.bubble-text');
      if (bubble) {
        bubble.innerHTML = Render.MD.render(text);
        Render.MD.enhance(bubble);
      }
      let typing = U.$('#typing');
      const host = U.$('#messages');
      if (!typing && host) {
        typing = U.el('div', { class: 'typing', id: 'typing' }, [U.el('span'), U.el('span'), U.el('span')]);
        host.appendChild(typing);
      }
      if (host) {
        const distance = host.scrollHeight - host.scrollTop - host.clientHeight;
        if (distance < 140) host.scrollTop = host.scrollHeight;
      }
    }
  };

  const findMessage = (messageId) => {
    for (const list of S.messages.values()) {
      const found = list.find((m) => m.id === messageId);
      if (found) return found;
    }
    return null;
  };

  const update = (chatId, messageId, text) => {
    const list = S.messages.get(chatId) || [];
    const msg = list.find((m) => m.id === messageId);
    if (msg) msg.text = text;
    pending.set(messageId, text);
    if (!scheduled) {
      scheduled = true;
      U.raf(flush);
    }
  };

  const notice = (chatId, messageId, text) => {
    const node = U.$('[data-msg="' + messageId + '"]');
    if (!node) return;
    const bubble = node.querySelector('.bubble');
    if (!bubble) return;
    let box = bubble.querySelector('.stream-notice');
    if (!box) {
      box = U.el('div', { class: 'stream-notice' });
      bubble.appendChild(box);
    }
    box.textContent = text;
  };

  const switched = (chatId, messageId, label) => {
    const node = U.$('[data-msg="' + messageId + '"]');
    if (!node) return;
    const bubble = node.querySelector('.bubble');
    if (!bubble) return;
    let box = bubble.querySelector('.model-switch');
    if (!box) {
      box = U.el('div', { class: 'model-switch' });
      bubble.appendChild(box);
    }
    box.textContent = 'Продолжено на ' + label;
  };

  return { update, notice, switched };
})();

window.Composer = Composer;
window.ChatStream = ChatStream;