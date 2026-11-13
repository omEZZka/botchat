'use strict';

/**
 * Внешний вид: иконка приложения, цвет фона, цвет символа, палитра.
 * Хранится в bc.settings и применяется к документу.
 */
const Appearance = (() => {
  const PRESETS = [
    { id: 'blue', name: 'Синий', acc: '#4F86FF', soft: '#1B2942' },
    { id: 'indigo', name: 'Индиго', acc: '#6366F1', soft: '#20223C' },
    { id: 'violet', name: 'Фиолетовый', acc: '#8B5CF6', soft: '#251C3B' },
    { id: 'magenta', name: 'Маджента', acc: '#D946EF', soft: '#341B38' },
    { id: 'rose', name: 'Роза', acc: '#F43F5E', soft: '#3A1B24' },
    { id: 'orange', name: 'Оранжевый', acc: '#F97316', soft: '#3A2416' },
    { id: 'amber', name: 'Янтарь', acc: '#F59E0B', soft: '#382A12' },
    { id: 'lime', name: 'Лайм', acc: '#84CC16', soft: '#26331A' },
    { id: 'green', name: 'Зелёный', acc: '#22C55E', soft: '#16301F' },
    { id: 'emerald', name: 'Изумруд', acc: '#10B981', soft: '#132E27' },
    { id: 'teal', name: 'Бирюза', acc: '#14B8A6', soft: '#132E2C' },
    { id: 'cyan', name: 'Циан', acc: '#06B6D4', soft: '#122C33' },
    { id: 'sky', name: 'Небо', acc: '#0EA5E9', soft: '#12293A' },
    { id: 'slate', name: 'Графит', acc: '#94A3B8', soft: '#222830' },
    { id: 'mono', name: 'Моно', acc: '#E2E8F0', soft: '#252A32' },
  ];

  const BG_PRESETS = [
    '#0B0F16', '#0F1216', '#101826', '#0D1A1A', '#141020',
    '#1A1014', '#12181F', '#171A12', '#0E1418', '#181216',
  ];

  const toHex = (n) => n.toString(16).padStart(2, '0');

  const parseHex = (hex) => {
    const value = String(hex || '').replace('#', '');
    if (value.length !== 6) return null;
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16),
    };
  };

  const rgbToHex = (r, g, b) => '#' + toHex(r) + toHex(g) + toHex(b);

  const hsvToHex = (h, s, v) => {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return rgbToHex(
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255)
    );
  };

  const softFromAccent = (hex) => {
    const rgb = parseHex(hex);
    if (!rgb) return '#1B2942';
    return rgbToHex(
      Math.round(rgb.r * 0.18),
      Math.round(rgb.g * 0.18),
      Math.round(rgb.b * 0.24)
    );
  };

  const current = () => S.settings.appearance || {};

  /** Применяет цвета к CSS-переменным. */
  const apply = () => {
    const a = current();
    const root = document.documentElement;
    const accent = a.accent || '#4F86FF';
    root.style.setProperty('--acc', accent);
    root.style.setProperty('--acc-soft', a.accentSoft || softFromAccent(accent));
    if (a.bg) {
      root.style.setProperty('--bg', a.bg);
      root.style.setProperty('--bg-2', lighten(a.bg, 6));
      root.style.setProperty('--bg-3', lighten(a.bg, 11));
      root.style.setProperty('--line', lighten(a.bg, 15));
    }
    root.dataset.appearance = a.preset || 'blue';
  };

  const lighten = (hex, amount) => {
    const rgb = parseHex(hex);
    if (!rgb) return hex;
    const f = (v) => Math.min(255, Math.round(v + (255 - v) * (amount / 100)));
    return rgbToHex(f(rgb.r), f(rgb.g), f(rgb.b));
  };

  const setPreset = (id) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset) return;
    S.settings.appearance = Object.assign({}, current(), {
      preset: id,
      accent: preset.acc,
      accentSoft: preset.soft,
    });
    Settings.write(S.settings);
    apply();
    Bus.emit('appearance:changed', S.settings.appearance);
    Bus.emit('render');
  };

  const setAccent = (hex) => {
    if (!parseHex(hex)) return;
    S.settings.appearance = Object.assign({}, current(), {
      preset: 'custom',
      accent: hex,
      accentSoft: softFromAccent(hex),
    });
    Settings.write(S.settings);
    apply();
    Bus.emit('appearance:changed', S.settings.appearance);
    Bus.emit('render');
  };

  const setBackground = (hex) => {
    if (!parseHex(hex)) return;
    S.settings.appearance = Object.assign({}, current(), { bg: hex });
    Settings.write(S.settings);
    apply();
    Bus.emit('appearance:changed', S.settings.appearance);
    Bus.emit('render');
  };

  const setIcon = (name, filled) => {
    S.settings.appearance = Object.assign({}, current(), {
      icon: name,
      iconFilled: !!filled,
    });
    Settings.write(S.settings);
    Bus.emit('appearance:changed', S.settings.appearance);
    Bus.emit('render');
  };

  const currentIcon = () => {
    const a = current();
    return {
      name: Avatars.has(a.icon) ? a.icon : 'bubbleDots',
      filled: !!a.iconFilled,
    };
  };

  return {
    PRESETS, BG_PRESETS, apply, setPreset, setAccent, setBackground,
    setIcon, currentIcon, current, parseHex, hsvToHex, lighten,
  };
})();

window.Appearance = Appearance;
