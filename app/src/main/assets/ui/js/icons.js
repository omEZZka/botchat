'use strict';

/**
 * Единственный источник иконок. Эмодзи запрещены: всё рисуется SVG.
 */
const Icons = (() => {
  const paths = {
    chats: 'M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm5.6 12.2 4.9 4.9',
    settings: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm8.4 6.1.1-1.3-.1-1.3 2-1.6-1.9-3.3-2.4.9-1.1-.7-.4-2.5h-3.8l-.4 2.5-1.1.7-2.4-.9L6.9 10l2 1.6-.1 1.3.1 1.3-2 1.6 1.9 3.3 2.4-.9 1.1.7.4 2.5h3.8l.4-2.5 1.1-.7 2.4.9 1.9-3.3-2-1.6z',
    plus: 'M12 5v14M5 12h14',
    send: 'M4 12 20 4l-7 16-2.4-6.1L4 12z',
    stop: 'M7 7h10v10H7z',
    mic: 'M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4zM6 11a6 6 0 0 0 12 0M12 17v3',
    clip: 'M8 12.5 14.5 6a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7-7l7.5-7.5',
    back: 'M15 5 8 12l7 7',
    more: 'M12 6h.01M12 12h.01M12 18h.01',
    close: 'M6 6l12 12M18 6 6 18',
    check: 'M4 12.5 9.5 18 20 6',
    checkDouble: 'M2 12.5 6.5 17 14 8M9 12.5 13.5 17 21 8',
    clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 4v5l3.5 2',
    error: 'M12 3 2 21h20L12 3zm0 6v6m0 3h.01',
    down: 'M12 4v14m0 0 6-6m-6 6-6-6',
    copy: 'M9 9h10v12H9zM5 15V3h10',
    reply: 'M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v2',
    forward: 'M15 7l5 5-5 5M20 12h-9a6 6 0 0 0-6 6v2',
    refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
    pin: 'M9 3h6l-1 6 4 4H6l4-4-1-6zM12 13v8',
    archive: 'M3 5h18v5H3zM5 10v10h14V10M10 14h4',
    edit: 'M4 20h4l11-11-4-4L4 16v4z',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    folder: 'M3 6h6l2 3h10v11H3z',
    image: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6',
    pdf: 'M6 3h8l4 4v14H6zM14 3v4h4M9 14h1.5a1.5 1.5 0 0 1 0 3H9v-3zm0 0v5',
    play: 'M7 5l12 7-12 7z',
    pause: 'M8 5v14M16 5v14',
    menu: 'M4 7h16M4 12h16M4 17h16',
    globe: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c3 3.5 3 14 0 18M12 3c-3 3.5-3 14 0 18',
    key: 'M14 4a6 6 0 1 1-3.5 10.9L8 17.5V20H5v-3l2.6-2.5A6 6 0 0 1 14 4zm2.5 3.5h.01',
    model: 'M12 3 3 7.5 12 12l9-4.5L12 3zM3 12.5 12 17l9-4.5M3 17.5 12 22l9-4.5',
    bell: 'M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6zM10 20h4',
    palette: 'M12 3a9 9 0 0 0 0 18c1.7 0 2-1.2 1.2-2.2-.7-.9-.2-2.3 1-2.3H17a4 4 0 0 0 4-4c0-5.2-4-9.5-9-9.5zM7.5 11h.01M10 7.5h.01M14 7.5h.01M17 11h.01',
    shield: 'M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3z',
    backup: 'M12 4v10m0 0 4-4m-4 4-4-4M4 17v3h16v-3',
    info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 5h.01M11 11h1v6h1',
    lock: 'M6 10V8a6 6 0 0 1 12 0v2M4 10h16v11H4z',
    unlock: 'M6 10V8a6 6 0 0 1 11-3M4 10h16v11H4z',
    terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
    code: 'M9 8 5 12l4 4M15 8l4 4-4 4',
    task: 'M4 5h5v5H4zM15 5h5v5h-5zM4 14h5v5H4zM15 14h5v5h-5zM9 7.5h6M9 16.5h6',
    todo: 'M4 6h4v4H4zM4 14h4v4H4zM11 8h9M11 16h9',
    graph: 'M5 19V9M12 19V4M19 19v-7M3 19h18',
    external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6zm10-2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
    eyeOff: 'M3 3l18 18M10.6 6.1A10.9 10.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.6M6.3 7.8A16.7 16.7 0 0 0 2 12s3.5 6 10 6a10 10 0 0 0 4.2-.9',
    add: 'M12 5v14M5 12h14',
    remove: 'M5 12h14',
    sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z',
    warn: 'M12 4 3 20h18L12 4zm0 5v6m0 3h.01',
    pauseCircle: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM10 9v6M14 9v6',
    newChat: 'M4 5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4zM20 9v7M16.5 12.5h7',
    checkpoint: 'M3 12h4l3-6 4 12 3-6h4',
    article: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',
    save: 'M4 4h13l3 3v13H4zM8 4v6h8V4M8 20v-6h8v6',
    attach: 'M12 5v14M5 12h14',
  };

  const make = (name, size) => {
    const dim = size || 20;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(dim));
    svg.setAttribute('height', String(dim));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', paths[name] || paths.info);
    svg.appendChild(path);
    return svg;
  };

  const html = (name, size) => {
    const dim = size || 20;
    const d = paths[name] || paths.info;
    return '<svg class="icon" viewBox="0 0 24 24" width="' + dim + '" height="' + dim +
      '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  };

  return { make, html, paths, has: (name) => Object.prototype.hasOwnProperty.call(paths, name) };
})();

window.Icons = Icons;