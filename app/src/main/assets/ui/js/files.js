'use strict';

/**
 * Файлы, дерево проекта, просмотр, PTY-терминал.
 * Все операции — через Native.fs/tool; вне песочницы чата запрещены.
 */
const FilesUI = (() => {
  let terminal = null;
  let termFit = null;
  let termSocketCleanup = null;

  const openPanel = async () => {
    const chat = Store.getChat(S.chatId);
    if (!chat) return;
    const path = chat.projectFolder || '';
    const content = U.el('div', { class: 'files-screen' });
    const crumbs = U.el('div', { class: 'crumbs', text: path || 'корень проекта' });
    const list = U.el('div', { class: 'file-list' });
    const editor = U.el('div', { class: 'file-editor', hidden: 'hidden' });

    const load = async (dir) => {
      U.clear(list);
      S.files.path = dir;
      crumbs.textContent = dir || 'корень проекта';
      const res = await Native.fs.ls(dir);
      if (!res || !res.ok) {
        list.appendChild(U.el('p', { class: 'muted small', text: (res && res.error) || 'Не удалось прочитать папку' }));
        return;
      }
      const items = res.items || [];
      S.files.entries = items;
      if (dir) {
        list.appendChild(U.el('button', {
          class: 'file-row up', type: 'button',
          onclick: () => load(parentOf(dir)),
        }, [Icons.make('back', 16), U.el('span', { text: '..' })]));
      }
      items.forEach((item) => {
        const row = U.el('button', { class: 'file-row', type: 'button' }, [
          Icons.make(item.isDir ? 'folder' : 'file', 16),
          U.el('span', { class: 'file-name', text: item.name }),
          U.el('span', { class: 'file-size', text: item.isDir ? '' : U.bytes(item.size) }),
        ]);
        row.addEventListener('click', () => {
          const next = dir ? dir + '/' + item.name : item.name;
          if (item.isDir) load(next);
          else openFile(next, editor);
        });
        list.appendChild(row);
      });
      if (!items.length) list.appendChild(U.el('p', { class: 'muted small', text: 'Папка пуста' }));
    };

    content.appendChild(crumbs);
    content.appendChild(list);
    content.appendChild(editor);
    content.appendChild(U.el('div', { class: 'files-actions' }, [
      U.el('button', {
        class: 'btn small', text: 'Новый файл',
        onclick: () => Render.prompt({
          title: 'Новый файл', label: 'Путь относительно корня', placeholder: 'src/app.js',
          onOk: async (name) => {
            if (!name) return;
            const full = path ? path + '/' + name : name;
            await Native.fs.writeText(full, '');
            load(path);
          },
        }),
      }),
      U.el('button', {
        class: 'btn small', text: 'Новая папка',
        onclick: () => Render.prompt({
          title: 'Новая папка', label: 'Путь относительно корня', placeholder: 'src',
          onOk: async (name) => {
            if (!name) return;
            await Native.fs.mkdir(path ? path + '/' + name : name);
            load(path);
          },
        }),
      }),
      U.el('button', { class: 'btn small', text: 'Терминал', onclick: () => openTerminal() }),
    ]));

    Render.openSheet({ title: 'Файлы проекта', content });
    load(path);
  };

  const parentOf = (dir) => {
    const clean = String(dir || '').replace(/\/+$/, '');
    const idx = clean.lastIndexOf('/');
    return idx < 0 ? '' : clean.slice(0, idx);
  };

  const openFile = async (path, host) => {
    host.hidden = false;
    U.clear(host);
    const res = await Native.fs.readText(path, 512 * 1024);
    if (!res || !res.ok) {
      host.appendChild(U.el('p', { class: 'muted small', text: (res && res.error) || 'Не удалось прочитать файл' }));
      return;
    }
    const isBinary = U.looksBinary(res.text);
    host.appendChild(U.el('div', { class: 'editor-head' }, [
      U.el('span', { class: 'editor-path', text: path }),
      U.el('span', { class: 'muted small', text: U.bytes(res.size || 0) }),
      U.el('button', { class: 'btn small', text: 'Закрыть', onclick: () => { host.hidden = true; } }),
    ]));
    if (isBinary) {
      host.appendChild(U.el('p', { class: 'muted small', text: 'Двоичный файл: предпросмотр недоступен' }));
      return;
    }
    const area = U.el('textarea', {
      class: 'editor-area', spellcheck: 'false', value: res.text,
    });
    host.appendChild(area);
    host.appendChild(U.el('div', { class: 'editor-actions' }, [
      U.el('button', {
        class: 'btn primary small', text: 'Сохранить',
        onclick: async () => {
          const saved = await Native.fs.writeText(path, area.value);
          Render.toast(saved && saved.ok ? 'Сохранено' : 'Ошибка сохранения');
        },
      }),
      U.el('button', {
        class: 'btn small', text: 'Копировать',
        onclick: () => U.copyToClipboard(area.value),
      }),
    ]));
    if (res.truncated) host.appendChild(U.el('p', { class: 'muted small', text: 'Файл показан не полностью' }));
  };

  const openTerminal = () => {
    const content = U.el('div', { class: 'terminal-host' });
    const mount = U.el('div', { class: 'terminal-mount', id: 'term-mount' });
    content.appendChild(mount);
    const status = U.el('div', { class: 'muted small', text: 'Проверяю rootfs…' });
    content.appendChild(status);
    Render.openSheet({ title: 'Терминал', content });
    setTimeout(async () => {
      const env = await Native.api('runtime.info');
      if (!env || !env.ok || !env.bash) {
        U.clear(status);
        status.appendChild(U.el('p', { class: 'muted small', text: 'rootfs не установлен: bash недоступен. Остальные инструменты работают.' }));
        const url = U.el('input', {
          class: 'field', type: 'url',
          placeholder: 'URL архива rootfs (tar.gz)',
          value: (S.settings.rootfsUrl || ''),
        });
        const install = U.el('button', {
          class: 'btn small primary', text: 'Установить rootfs',
          onclick: async () => {
            if (!url.value.trim()) {
              Render.toast('Укажите URL архива');
              return;
            }
            Store.setSetting('rootfsUrl', url.value.trim());
            install.disabled = true;
            install.textContent = 'Устанавливаю…';
            const res = await Native.api('runtime.install', { url: url.value.trim() });
            install.disabled = false;
            install.textContent = 'Установить rootfs';
            if (res && res.ok) {
              Render.toast('rootfs установлен');
              Render.closeSheet();
              openTerminal();
            } else {
              Render.toast((res && res.error) || 'Не удалось установить rootfs');
            }
          },
        });
        status.appendChild(url);
        status.appendChild(install);
        return;
      }
      status.textContent = 'proot · Ubuntu arm64 · ' + U.bytes(env.size || 0);
      mountTerminal(mount, status);
    }, 60);
  };

  const mountTerminal = (mount, status) => {
    if (typeof Terminal === 'undefined') {
      status.textContent = 'xterm.js не загружен';
      return;
    }
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'monospace',
      cursorBlink: true,
      theme: {
        background: '#0f1216', foreground: '#e7ebf0', cursor: '#5b8cff',
        selectionBackground: '#2a3444',
      },
      convertEol: true,
      scrollback: 2000,
    });
    const FitCtor = window.FitAddon && window.FitAddon.FitAddon;
    if (FitCtor) {
      termFit = new FitCtor();
      term.loadAddon(termFit);
    }
    term.open(mount);
    if (termFit) termFit.fit();
    terminal = term;
    presentBanner(term);
    term.write('\r\n$ ');
    const onData = (data) => {
      Native.api('runtime.input', { chatId: S.chatId, data });
    };
    term.onData(onData);
    Native.api('runtime.attach', { chatId: S.chatId });
    termSocketCleanup = Native.on('term.output', (payload) => {
      if (payload && payload.data && (!payload.chatId || payload.chatId === S.chatId)) {
        term.write(payload.data);
      }
    });
  };

  const presentBanner = (term) => {
    term.writeln('botCHAT terminal');
    term.writeln('sandbox: /workspace');
    term.writeln('');
  };

  const dispose = () => {
    if (termSocketCleanup) termSocketCleanup();
    termSocketCleanup = null;
    if (S.chatId) Native.api('runtime.close', { chatId: S.chatId });
    if (terminal) {
      terminal.dispose();
      terminal = null;
    }
    termFit = null;
  };

  return { openPanel, openTerminal, dispose };
})();

window.FilesUI = FilesUI;