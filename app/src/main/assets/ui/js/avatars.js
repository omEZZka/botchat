'use strict';

/**
 * Библиотека иконок приложения: 48 вариантов (24 набора × 2 стиля).
 * Рисуются SVG в `currentColor`, поэтому цвет задаётся отдельно.
 */
const Avatars = (() => {
  const shapes = {
    bubble: 'M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
    bubbleDots: 'M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M8 11h.01 M12 11h.01 M16 11h.01',
    chat: 'M3 6h18v11H8l-5 4z',
    chatLines: 'M3 6h18v11H8l-5 4z M7 10h10 M7 13h6',
    sparkle: 'M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12 4.5 10 10 8.5z',
    sparkleBig: 'M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z M18 3l.9 2.1L21 6l-2.1.9L18 9l-.9-2.1L15 6l2.1-.9z',
    robot: 'M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z M9 12h.01 M15 12h.01 M9 16h6 M12 5v3',
    brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V16a3 3 0 0 0 5 2.2 M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V16a3 3 0 0 1-5 2.2 M12 4v16',
    bolt: 'M13 2 4 14h6l-1 8 9-12h-6z',
    layers: 'M12 3 3 8l9 5 9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
    cube: 'M12 3 4 7.5v9L12 21l8-4.5v-9z M4 7.5 12 12l8-4.5 M12 12v9',
    orbit: 'M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14z M5 19c-2-2 2-7 7-9s7 0 6 2-5 5-9 6z',
    atom: 'M12 12m-2 0a2 2 0 1 1 4 0a2 2 0 1 1-4 0 M5 12c0-4 3-7 7-7s7 3 7 7-3 7-7 7-7-3-7-7z M7 7c3-3 7 0 9 5s0 7-2 6-5-5-6-9z',
    prism: 'M12 3 21 20H3z M12 3v17 M8 20l4-8 4 8',
    code: 'M8 7 4 12l4 5 M16 7l4 5-4 5 M13 5l-2 14',
    terminal: 'M3 5h18v14H3z M7 10l3 2-3 2 M13 14h4',
    shield: 'M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z',
    lock: 'M6 10V8a6 6 0 0 1 12 0v2 M4 10h16v11H4z M12 14v3',
    globe: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M3 12h18 M12 3c3 3.4 3 14 0 18 M12 3c-3 3.4-3 14 0 18',
    compass: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M16 8l-2.4 5.6L8 16l2.4-5.6z',
    target: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M12 11v2',
    flame: 'M12 3c4 4 6 6 6 10a6 6 0 0 1-12 0c0-2 1-3 2-4 1 2 2 2 2 0 0-3 1-5 2-6z',
    leaf: 'M20 4C10 4 4 9 4 16c0 2 1 4 1 4s2-3 5-4c-1-2 0-5 3-7-2 3-2 6 0 8 5 1 7-3 7-13z',
    wave: 'M2 12c3-5 5-5 8 0s5 5 8 0 M2 17c3-4 5-4 8 0s5 4 8 0',
    pulse: 'M2 12h4l2-6 3 12 3-9 2 3h6',
    star: 'M12 3l2.6 6.1 6.4.6-4.9 4.3 1.5 6.3L12 17l-5.6 3.3 1.5-6.3L3 9.7l6.4-.6z',
    hexagon: 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z M12 8l3.5 2v4L12 16l-3.5-2v-4z',
    key: 'M14 4a6 6 0 1 1-4.2 10.2L8 16v3H5v-3l2-2A6 6 0 0 1 14 4z M16 8h.01',
    book: 'M4 5h7a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H4z M20 5h-7a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h7z',
    pen: 'M4 20l4-1 11-11-3-3L5 16z M14 5l3 3',
    brush: 'M9 14a3 3 0 1 1-2 5c2 0 3-1 3-3z M12 12L20 4l-2-1-9 8z',
    camera: 'M4 7h4l2-2h4l2 2h4v12H4z M12 10a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z',
    music: 'M9 18V6l10-2v12 M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3z M19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z',
    play: 'M7 4l13 8-13 8z',
    pause: 'M8 4v16 M16 4v16',
    dice: 'M4 4h16v16H4z M8 8h.01 M16 8h.01 M12 12h.01 M8 16h.01 M16 16h.01',
    merge: 'M6 4v6a5 5 0 0 0 5 5h7 M18 12l3 3-3 3 M6 20v-6',
    split: 'M6 4v4a5 5 0 0 1 5 5v7 M18 20v-4a5 5 0 0 0-5-5 M3 4h6 M15 20h6',
    ticket: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4z',
    bell: 'M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z M10 20h4',
    headset: 'M4 14v-2a8 8 0 0 1 16 0v2 M4 14a3 3 0 0 0 3 3h1v-6H7a3 3 0 0 0-3 3z M20 14a3 3 0 0 1-3 3h-1v-6h1a3 3 0 0 1 3 3z',
    mic: 'M12 4a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0v-5A2.5 2.5 0 0 1 12 4z M6 11a6 6 0 0 0 12 0 M12 17v3',
    chart: 'M4 20V9 M10 20V4 M16 20v-7 M22 20H2',
    grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
    dial: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M12 12l6-6 M12 12h.01',
    flag: 'M5 3v18 M5 4h12l-2 4 2 4H5',
    tag: 'M4 4h8l8 8-8 8-8-8z M9 9h.01',
    paperclip: 'M8 12l6-6a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7-7l7-7',
    puzzle: 'M9 4h6v2a2 2 0 1 0 4 0h1v6h-2a2 2 0 1 0 0 4h2v4h-6v-2a2 2 0 1 0-4 0v2H4v-6h2a2 2 0 1 0 0-4H4V4h5z',
    glasses: 'M3 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0z M15 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0z M9 12h6 M3 12V9 M21 12V9',
    eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
    compassAlt: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M15.5 8.5l-2 5.5-5.5 2 2-5.5z',
    mountain: 'M3 20l6-11 4 7 2-3 6 7z M7 9l1.5 2.5',
    droplet: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
    sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M19 5l-1.5 1.5 M6.5 17.5 5 19',
    moon: 'M20 14a8 8 0 1 1-10-10 7 7 0 0 0 10 10z',
    cloud: 'M7 18a4 4 0 0 1-.6-8 5.5 5.5 0 0 1 10.6 1.4A3.6 3.6 0 0 1 17 18z',
    infinity: 'M7 9a3 3 0 1 0 0 6c2.5 0 7.5-6 10-6a3 3 0 1 1 0 6c-2.5 0-7.5-6-10-6z',
  };

  // 24 базовых фигур × 2 стиля (контур/заливка) = 48; плюс рамки и фоны дают 100+ комбинаций.
  const ids = Object.keys(shapes);

  const svg = (name, opts) => {
    const o = opts || {};
    const fill = o.filled;
    const d = shapes[name] || shapes.bubble;
    return '<svg viewBox="0 0 24 24" width="' + (o.size || 24) + '" height="' + (o.size || 24) +
      '" fill="' + (fill ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="' + d + '"/></svg>';
  };

  return { shapes, ids, svg, has: (n) => Object.prototype.hasOwnProperty.call(shapes, n) };
})();

window.Avatars = Avatars;
