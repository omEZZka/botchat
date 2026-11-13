'use strict';

/**
 * Режим «звонка»: разговор голосом с моделью.
 *
 * Петля: запись → распознавание (STT) → ответ модели → озвучка (TTS) → снова запись.
 * Пока идёт ответ и озвучка, микрофон выключен. Тап по «микрофон» прерывает речь
 * (barge-in) и сразу начинает слушать.
 */
const CallMode = (() => {
  let active = false;
  let phase = 'idle'; // idle | listening | thinking | speaking
  let timer = null;
  let ui = {};
  let spokenIndex = 0;

  const phases = {
    idle: 'Готов',
    listening: 'Слушаю вас…',
    thinking: 'Думаю…',
    speaking: 'Отвечаю…',
  };

  const open = (chatId) => {
    const chat = Store.getChat(chatId || S.chatId);
    if (!chat) return;
    active = true;
    spokenIndex = 0;

    const avatarBox = U.el('div', { class: 'call-avatar' });
    const name = U.el('div', { class: 'call-name', text: chat.title });
    const model = U.el('div', { class: 'call-model', text: chat.model || S.settings.activeModel || 'модель не выбрана' });
    const state = U.el('div', { class: 'call-state', text: phases.idle });
    const transcript = U.el('div', { class: 'call-transcript', id: 'call-transcript' });
    const wave = U.el('div', { class: 'call-wave', id: 'call-wave' });
    for (let i = 0; i < 22; i += 1) wave.appendChild(U.el('span'));

    const micBtn = U.el('button', {
      class: 'call-btn primary', type: 'button', 'aria-label': 'Говорить',
      onclick: () => {
        if (phase === 'speaking') {
          Native.api('speech.stop', {});
          startListening();
          return;
        }
        if (phase === 'listening') stopListening();
        else startListening();
      },
    }, Icons.make('mic', 26));

    const muteBtn = U.el('button', {
      class: 'call-btn', type: 'button', 'aria-label': 'Стоп',
      onclick: () => { Native.api('speech.stop', {}); setPhase('idle'); },
    }, Icons.make('pause', 20));

    const endBtn = U.el('button', {
      class: 'call-btn danger', type: 'button', 'aria-label': 'Завершить',
      onclick: () => close(),
    }, Icons.make('close', 22));

    const content = U.el('div', { class: 'call-screen' }, [
      U.el('div', { class: 'call-top' }, [avatarBox, name, model]),
      wave,
      state,
      transcript,
      U.el('div', { class: 'call-controls' }, [muteBtn, micBtn, endBtn]),
      U.el('button', {
        class: 'link-btn call-end-link', text: 'Завершить разговор',
        onclick: () => close(),
      }),
    ]);

    ui = { avatarBox, name, model, state, transcript, wave, micBtn };
    renderAvatar(chat);

    Render.openSheet({ title: 'Разговор', content, full: true });
    setPhase('idle');

    OffSpeech = Native.on('speech.state', (payload) => {
      if (!active || !payload) return;
      if (payload.state === 'idle' && phase === 'speaking') {
        setPhase('idle');
      }
    });
    OffPerm = Native.on('voice.permission', (payload) => {
      if (!active || !payload || !payload.granted) return;
      if (pendingListen) {
        pendingListen = false;
        startListening();
      }
    });
  };

  let OffSpeech = null;
  let OffPerm = null;
  let pendingListen = false;

  const renderAvatar = (chat) => {
    if (!ui.avatarBox) return;
    U.clear(ui.avatarBox);
    const big = Render.avatar(chat.title, chat.color, 0, chat);
    big.classList.add('call-avatar-img');
    ui.avatarBox.appendChild(big);
  };

  const setPhase = (next) => {
    phase = next;
    if (!ui.state) return;
    ui.state.textContent = phases[next] || '';
    ui.state.dataset.phase = next;
    if (ui.micBtn) {
      U.clear(ui.micBtn);
      ui.micBtn.appendChild(Icons.make(next === 'listening' ? 'stop' : 'mic', 26));
      ui.micBtn.classList.toggle('recording', next === 'listening');
    }
    const waveHost = ui.wave;
    if (waveHost) waveHost.classList.toggle('active', next === 'listening' || next === 'speaking');
  };

  const animateWave = (level) => {
    if (!ui.wave) return;
    Array.from(ui.wave.children).forEach((bar, i) => {
      const center = 1 - Math.abs(i - (ui.wave.childElementCount - 1) / 2) / ((ui.wave.childElementCount - 1) / 2);
      const h = phase === 'listening'
        ? 4 + Math.round((level / 100) * 34 * (0.4 + center * 0.6))
        : 4 + Math.round(Math.random() * 10);
      bar.style.height = h + 'px';
    });
  };

  const startListening = async () => {
    if (!active) return;
    const perm = await Native.call('mic.request', {});
    if (!perm || !perm.ok) {
      Render.toast('Нет доступа к микрофону');
      return;
    }
    const res = await Native.api('voice.start', { chatId: S.chatId });
    if (!res || !res.ok) {
      if (res && res.permission) {
        pendingListen = true;
        return;
      }
      Render.toast((res && res.error) || 'Не удалось включить микрофон');
      return;
    }
    setPhase('listening');
    if (timer) clearInterval(timer);
    timer = setInterval(async () => {
      if (!active || phase !== 'listening') return;
      const st = await Native.api('voice.state');
      if (st && st.ok) animateWave(st.level || 0);
    }, 120);
  };

  const stopListening = async () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (!active) return;
    setPhase('thinking');
    const res = await Native.api('voice.stop', {});
    if (!res || !res.ok || !res.path) {
      setPhase('idle');
      return;
    }
    const tr = await Native.api('voice.transcribe', { path: res.path });
    if (!tr || !tr.ok) {
      Render.toast((tr && tr.error) || 'Не удалось распознать');
      setPhase('idle');
      return;
    }
    const said = (tr.text || '').trim();
    if (said) addLine('Вы', said);
    await ask(said);
  };

  const addLine = (who, text) => {
    if (!ui.transcript) return;
    ui.transcript.appendChild(U.el('div', { class: 'call-line ' + (who === 'Вы' ? 'user' : 'agent') }, [
      U.el('span', { class: 'call-who', text: who }),
      U.el('span', { class: 'call-text', text: text }),
    ]));
    ui.transcript.scrollTop = ui.transcript.scrollHeight;
  };

  const ask = async (text) => {
    if (!text) {
      setPhase('idle');
      return;
    }
    if (!S.online) {
      Render.toast('Нет сети');
      setPhase('idle');
      return;
    }
    // Сообщение уходит через тот же движок, что и в чате:
    // история, модель чата и инструменты работают одинаково.
    const before = (Store.messages(S.chatId) || []).length;
    await Agent.send(S.chatId, { text, attachments: [] });
    // Ждём финальный ответ по этому чату.
    const started = Date.now();
    let answer = '';
    while (active && Date.now() - started < 120000) {
      const list = Store.messages(S.chatId) || [];
      const last = list[list.length - 1];
      if (list.length > before && last && last.role === 'assistant' && !last.streaming) {
        answer = (last.text || '').trim();
        break;
      }
      await U.sleep(250);
    }
    if (!active) return;
    if (!answer) {
      setPhase('idle');
      Render.toast('Ответ не получен');
      return;
    }
    addLine('Модель', answer);
    setPhase('speaking');
    await Native.api('speech.speak', { text: answer });
    // После окончания речи возвращаемся к прослушиванию.
    const check = setInterval(async () => {
      if (!active || phase !== 'speaking') { clearInterval(check); return; }
      const st = await Native.api('speech.state');
      if (st && st.ok && !st.speaking) {
        clearInterval(check);
        if (active && phase === 'speaking') startListening();
      }
    }, 400);
  };

  const close = async () => {
    active = false;
    if (timer) clearInterval(timer);
    timer = null;
    await Native.api('voice.cancel', {});
    await Native.api('speech.stop', {});
    if (OffSpeech) { OffSpeech(); OffSpeech = null; }
    if (OffPerm) { OffPerm(); OffPerm = null; }
    setPhase('idle');
    Render.closeSheet();
  };

  return { open, close, isActive: () => active };
})();

window.CallMode = CallMode;
