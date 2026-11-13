/**
 * Векторные иконки современного интерфейса (ui/glass.css): линии 1.8 px в сетке 24×24, цвет — currentColor.
 * Нарисованы для этого проекта; в классическом интерфейсе не показываются (там иконки на картинках кнопок).
 */

/** шестерёнка: 8 зубцов по окружности */
function gearPath(): string {
  const teeth = 8;
  const outer = 9.5;
  const inner = 7.2;
  const points: string[] = [];
  for (let n = 0; n < teeth * 4; n++) {
    const angle = ((n - 0.5) / (teeth * 4)) * Math.PI * 2;
    const radius = n % 4 < 2 ? outer : inner;
    points.push(`${(12 + radius * Math.cos(angle)).toFixed(2)} ${(12 + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M15.5 4.7a3.5 3.5 0 0 1 0 6.6M18 14.4c2.1.8 3.5 2.8 3.5 5.6"/>',
  userPlus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M19 7v6M16 10h6"/>',
  // два скрещённых меча: клинок, гарда, рукоять
  swords: '<path d="M4 4l11 11M20 4 9 15"/><path d="M13 17l4-4M7 13l4 4"/><path d="M15 15l4.5 4.5M9 15l-4.5 4.5"/>',
  tank: '<rect x="2.5" y="13" width="19" height="6.5" rx="3.2"/><path d="M6.5 13v-3.5h8l2 3.5"/><path d="M14.5 10.5h7"/><circle cx="7" cy="16.25" r="1"/><circle cx="12" cy="16.25" r="1"/><circle cx="17" cy="16.25" r="1"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.9-.9 1.5v.7"/><path d="M12 16.8v.2"/>',
  sound:
    '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path class="glass-sound-on" d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/><path class="glass-sound-off" d="M16 9.5l5 5M21 9.5l-5 5"/>',
  gear: `<path d="${gearPath()}"/><circle cx="12" cy="12" r="3"/>`,
  bug: '<rect x="8" y="7.5" width="8" height="12" rx="4"/><path d="M12 11.5v8M10 7.5a2 2 0 0 1 4 0M8 12H4.5M16 12h3.5M8 16H5M16 16h3M8.5 9.5 6 7M15.5 9.5 18 7"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  // режимы боя: DM — прицел, TDM — две команды, CTF — флаг, CP — контрольная точка
  dm: '<circle cx="12" cy="12" r="6.5"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/>',
  tdm: '<circle cx="7.5" cy="8.5" r="2.8"/><circle cx="16.5" cy="8.5" r="2.8"/><path d="M2.5 19c0-3 2.2-5.2 5-5.2s5 2.2 5 5.2M11.5 19c0-3 2.2-5.2 5-5.2s5 2.2 5 5.2"/>',
  ctf: '<path d="M6 21V3.5"/><path d="M6 4h12l-3 4.5 3 4.5H6"/>',
  cp: '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="8.5" stroke-dasharray="3.4 2.3"/>',
} as const;

export type GlassIconName = keyof typeof ICONS;

export function glassIcon(name: GlassIconName): string {
  return `<svg class="glass-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
