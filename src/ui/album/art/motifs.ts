// 10 个家族母题：**发光线稿**，不画背景、不上大面积实色。
//
// 为什么要这样：卡面要长在应用的「夜间余烬 + 玻璃」体系里。
// 实色海报会和玻璃卡打架；线稿用 ink 色勾形，只留一点余烬暖光，
// 背景透明，玻璃表面直接透出来。

import type { ArtFamily } from '../../../db/cardArt';

export interface ArtPalette {
  /** 主线条：接近界面的 ink-2 */
  line: string;
  /** 余烬暖光：只用于火口、火星、极少量填充 */
  ember: string;
}

const PALETTES: Record<string, ArtPalette> = {
  normal: { line: '#e8f1f3', ember: '#ffc07a' },
  gold: { line: '#f8ecd2', ember: '#ffd98f' },
  silver: { line: '#f2f8fb', ember: '#d8ecf5' },
  blue: { line: '#e3efff', ember: '#a8d3ff' },
  rainbow: { line: '#eafaf5', ember: '#f5c9e3' },
  neon: { line: '#e6fbeb', ember: '#b3ffc4' }
};

export function paletteFor(variant: string): ArtPalette {
  return PALETTES[variant] ?? PALETTES.normal;
}

type Body = (p: ArtPalette, uid: string) => string;

const dot = (x: number, y: number, r: number, c: string, op = 0.9) =>
  `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${c}" opacity="${op}" stroke="none"/>`;

const star = (x: number, y: number, r: number, c: string, op = 0.95) =>
  `<path d="M${x} ${y - r} L${x + r * 0.26} ${y - r * 0.26} L${x + r} ${y} L${x + r * 0.26} ${y + r * 0.26} L${x} ${y + r} L${x - r * 0.26} ${y + r * 0.26} L${x - r} ${y} L${x - r * 0.26} ${y - r * 0.26} Z" fill="${c}" opacity="${op}" stroke="none"/>`;

const gatling: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(206 352) rotate(-26.6)">
      ${[-30, -15, 0, 15, 30]
        .map((o) => `<g transform="translate(${o} 0)"><rect x="-6" y="-182" width="12" height="182" rx="6" stroke-width="2.8"/><ellipse cx="0" cy="-182" rx="6" ry="3" stroke-width="2.24"/></g>`)
        .join('')}
      <path d="M-22 0 L22 0 L16 74 L-16 74 Z" stroke-width="2.8"/>
      <path d="M-14 20 L14 20 M-15 40 L15 40" stroke-width="1.96" opacity="0.7"/>
      <path d="M-40 -104 L40 -104 M-40 -92 L40 -92" stroke-width="2.8" opacity="0.9"/>
      <circle cx="-34" cy="-98" r="2" fill="${p.ember}" stroke="none"/>
      <circle cx="34" cy="-98" r="2" fill="${p.ember}" stroke="none"/>
    </g>
    <g stroke-width="2.24" opacity="0.9">
      <path d="M92 207 L40 92"/><path d="M108 199 L62 82"/><path d="M124 190 L88 72"/>
      <path d="M140 182 L114 64"/><path d="M156 174 L140 58"/>
    </g>
  </g>
  ${[[92, 207], [108, 199], [124, 190], [140, 182], [156, 174]].map(([x, y]) => star(x, y, 6, p.ember)).join('')}
  ${dot(214, 392, 3, p.ember, 0.7)}`;

const jellyfish: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round">
    <path d="M96 170 C96 112 126 84 160 84 C194 84 224 112 224 170 C206 186 184 180 160 180 C136 180 114 186 96 170 Z" stroke-width="3.08"/>
    <path d="M126 168 C130 132 142 110 158 96 M148 174 C150 140 152 114 160 94 M172 174 C170 140 168 114 160 94 M194 168 C190 132 178 110 162 96" stroke-width="1.68" opacity="0.6"/>
    <path d="M118 182 C104 216 130 238 116 274 C104 302 122 318 110 344" stroke-width="2.52"/>
    <path d="M138 186 C130 220 152 240 142 276 C134 302 150 316 144 342" stroke-width="2.24"/>
    <path d="M160 188 C154 222 170 242 160 278 C152 304 166 318 160 344" stroke-width="2.52"/>
    <path d="M182 186 C190 220 168 240 180 276 C188 302 172 316 180 342" stroke-width="2.24"/>
    <path d="M202 182 C216 216 190 238 204 274 C216 302 198 318 210 344" stroke-width="2.52"/>
  </g>
  ${[[96, 236, 2.4], [228, 220, 2], [214, 266, 2.6], [108, 292, 1.8], [196, 304, 2.2], [240, 302, 1.6]]
    .map(([x, y, r]) => dot(x, y, r, p.line, 0.55))
    .join('')}
  ${dot(160, 120, 3, p.ember, 0.8)}`;

const windmill: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(160 196)">
      ${[0, 90, 180, 270]
        .map((d) => `<g transform="rotate(${d})"><path d="M0 0 C24 -18 38 -62 8 -102 C-14 -70 -12 -30 0 0 Z" stroke-width="2.8"/><path d="M0 -10 L4 -90" stroke-width="1.68" opacity="0.55"/></g>`)
        .join('')}
      <circle r="10" stroke-width="2.8"/>
      <circle r="3.2" fill="${p.ember}" stroke="none"/>
    </g>
    <path d="M156 206 L156 356 M164 206 L164 356" stroke-width="2.52"/>
    <path d="M146 356 L174 356" stroke-width="2.8"/>
    <path d="M60 196 A100 100 0 0 1 96 120" stroke-width="1.68" opacity="0.5" stroke-dasharray="3 8"/>
    <path d="M260 196 A100 100 0 0 0 224 120" stroke-width="1.68" opacity="0.5" stroke-dasharray="3 8"/>
  </g>
  ${star(160, 196, 7, p.ember, 0.9)}`;

const dragonfly: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(160 206)">
      ${[45, 135, 225, 315]
        .map((d) => `<g transform="rotate(${d})"><path d="M0 0 C16 -28 30 -72 4 -104 C-20 -72 -16 -28 0 0 Z" stroke-width="2.8"/><path d="M0 -8 L2 -96" stroke-width="1.54" opacity="0.55"/></g>`)
        .join('')}
      <rect x="-9" y="-34" width="18" height="130" rx="9" stroke-width="2.8"/>
      <path d="M-9 -14 L9 -14 M-9 6 L9 6 M-9 26 L9 26 M-9 46 L9 46 M-9 66 L9 66" stroke-width="1.68" opacity="0.55"/>
      <circle cx="0" cy="-48" r="17" stroke-width="2.8"/>
      <circle cx="-7" cy="-51" r="3.4" fill="${p.ember}" stroke="none"/>
      <circle cx="7" cy="-51" r="3.4" fill="${p.ember}" stroke="none"/>
    </g>
    <path d="M40 206 A120 120 0 0 1 160 86" stroke-width="1.54" opacity="0.45" stroke-dasharray="3 9"/>
  </g>`;

const peacock: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round">
    ${Array.from({ length: 9 }, (_, i) => {
      const a = (-166 + i * 9.5) * (Math.PI / 180);
      const x0 = 160 + Math.cos(a) * 28;
      const y0 = 336 + Math.sin(a) * 28;
      const x1 = 160 + Math.cos(a) * 150;
      const y1 = 336 + Math.sin(a) * 150;
      return `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} L${x1.toFixed(1)} ${y1.toFixed(1)}" stroke-width="2.52"/><ellipse cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" rx="8" ry="12" transform="rotate(${(-166 + i * 9.5 + 90).toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)})" stroke-width="2.24"/>`;
    }).join('')}
    <path d="M132 336 C138 312 182 312 188 336" stroke-width="2.8"/>
    <ellipse cx="160" cy="338" rx="28" ry="9" stroke-width="2.24"/>
  </g>
  ${Array.from({ length: 9 }, (_, i) => {
    const a = (-166 + i * 9.5) * (Math.PI / 180);
    return dot(160 + Math.cos(a) * 150, 336 + Math.sin(a) * 150, 2.2, p.ember, 0.85);
  }).join('')}`;

const fountain: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round">
    ${Array.from({ length: 13 }, (_, i) => {
      const a = -90 + (i - 6) * 12;
      const len = 130 + (i % 3) * 30;
      const rad = (a * Math.PI) / 180;
      const x1 = 160 + Math.cos(rad) * len;
      const y1 = 322 + Math.sin(rad) * len;
      const cx = 160 + Math.cos(rad) * len * 0.5;
      const cy = 322 + Math.sin(rad) * len * 0.5 - 18;
      return `<path d="M160 322 Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke-width="2.24" opacity="${(0.85 - (Math.abs(i - 6) / 14)).toFixed(2)}"/>`;
    }).join('')}
    <rect x="136" y="316" width="48" height="34" rx="8" stroke-width="2.8"/>
    <path d="M136 326 L184 326" stroke-width="1.68" opacity="0.5"/>
  </g>
  ${Array.from({ length: 22 }, (_, i) => {
    const a = ((i * 37) % 150) - 165;
    const r = 60 + ((i * 23) % 110);
    const rad = (a * Math.PI) / 180;
    return dot(160 + Math.cos(rad) * r, 322 + Math.sin(rad) * r, 1 + (i % 3) * 0.5, p.ember, 0.55);
  }).join('')}`;

const sparkler: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round">
    <path d="M120 128 L176 350" stroke-width="2.8"/>
    <path d="M120 128 L176 350" stroke-width="1.4" opacity="0.35"/>
    ${Array.from({ length: 10 }, (_, i) => {
      const a = (i * 36 + 8) * (Math.PI / 180);
      return `<path d="M${(120 + Math.cos(a) * 16).toFixed(1)} ${(128 + Math.sin(a) * 16).toFixed(1)} L${(120 + Math.cos(a) * (64 + (i % 3) * 18)).toFixed(1)} ${(128 + Math.sin(a) * (64 + (i % 3) * 18)).toFixed(1)}" stroke-width="2.24"/>`;
    }).join('')}
  </g>
  ${star(120, 128, 12, p.ember)}
  ${Array.from({ length: 18 }, (_, i) => {
    const a = (i * 47) % 360;
    const r = 42 + ((i * 29) % 60);
    const rad = (a * Math.PI) / 180;
    return dot(120 + Math.cos(rad) * r, 128 + Math.sin(rad) * r, 1 + (i % 2) * 0.6, p.ember, 0.7);
  }).join('')}`;

const doubleBang: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round">
    <rect x="134" y="290" width="52" height="38" rx="6" stroke-width="2.8"/>
    <rect x="150" y="252" width="20" height="38" rx="4" stroke-width="2.52"/>
    <path d="M134 300 L186 300" stroke-width="1.68" opacity="0.5"/>
    <path d="M160 252 L160 226" stroke-width="2.24"/>
    ${Array.from({ length: 8 }, (_, i) => {
      const a = (-160 + i * 12) * (Math.PI / 180);
      return `<path d="M160 232 L${(160 + Math.cos(a) * 52).toFixed(1)} ${(232 + Math.sin(a) * 52).toFixed(1)}" stroke-width="2.1"/>`;
    }).join('')}
    ${Array.from({ length: 10 }, (_, i) => {
      const a = (-170 + i * 9) * (Math.PI / 180);
      return `<path d="M160 150 L${(160 + Math.cos(a) * 88).toFixed(1)} ${(150 + Math.sin(a) * 88).toFixed(1)}" stroke-width="2.1" opacity="0.9"/>`;
    }).join('')}
  </g>
  ${star(160, 232, 9, p.ember)}
  ${star(160, 150, 13, p.ember)}
  ${dot(160, 96, 3, p.ember, 0.6)}`;

const firecracker: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round">
    ${Array.from({ length: 7 }, (_, i) => {
      const x = 56 + i * 32;
      const h = 92 + ((i * 17) % 22);
      return `<rect x="${x}" y="${330 - h}" width="22" height="${h}" rx="5" stroke-width="2.52"/><path d="M${x + 11} ${330 - h} c-6 -16 6 -22 2 -34" stroke-width="1.96" opacity="0.8"/>`;
    }).join('')}
    <path d="M50 330 L262 330" stroke-width="2.52"/>
  </g>
  ${Array.from({ length: 18 }, (_, i) => {
    const x = 58 + ((i * 47) % 200);
    const y = 120 + ((i * 31) % 100);
    return dot(x, y, 1 + (i % 3) * 0.5, p.ember, 0.6);
  }).join('')}
  ${star(92, 150, 8, p.ember, 0.9)}${star(160, 128, 10, p.ember, 0.9)}${star(226, 156, 7, p.ember, 0.85)}`;

const sunflower: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(160 200)">
      ${Array.from({ length: 12 }, (_, i) => `<g transform="rotate(${i * 30})"><ellipse cx="0" cy="-104" rx="18" ry="44" stroke-width="2.52"/><path d="M0 -66 L0 -142" stroke-width="1.4" opacity="0.45"/></g>`).join('')}
      <circle r="40" stroke-width="2.8"/>
      <circle r="24" stroke-width="1.96" opacity="0.7"/>
    </g>
    <path d="M156 240 L156 356 M164 240 L164 356" stroke-width="2.52"/>
    <path d="M160 320 C132 330 122 350 120 372 C142 366 154 352 160 336 Z" stroke-width="2.24"/>
  </g>
  ${Array.from({ length: 12 }, (_, i) => {
    const a = (i * 30 * Math.PI) / 180;
    return dot(160 + Math.cos(a - Math.PI / 2) * 104, 200 + Math.sin(a - Math.PI / 2) * 104, 2, p.ember, 0.75);
  }).join('')}`;

const butterfly: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(160 210)">
      <path d="M0 -60 C40 -120 96 -104 92 -58 C88 -22 40 -6 4 -18 Z" stroke-width="2.2"/>
      <path d="M0 -60 C-40 -120 -96 -104 -92 -58 C-88 -22 -40 -6 -4 -18 Z" stroke-width="2.2"/>
      <path d="M4 -18 C40 4 74 44 52 78 C30 106 -2 62 -4 22 Z" stroke-width="2"/>
      <path d="M-4 -18 C-40 4 -74 44 -52 78 C-30 106 2 62 4 22 Z" stroke-width="2"/>
      <rect x="-7" y="-62" width="14" height="128" rx="7" stroke-width="2.2"/>
      <path d="M-7 -50 C-18 -78 -30 -92 -44 -98" stroke-width="1.8"/>
      <path d="M7 -50 C18 -78 30 -92 44 -98" stroke-width="1.8"/>
      <circle cx="-46" cy="-100" r="2.6" fill="${p.ember}" stroke="none"/>
      <circle cx="46" cy="-100" r="2.6" fill="${p.ember}" stroke="none"/>
    </g>
  </g>
  ${dot(160, 140, 3.2, p.ember, 0.8)}`;

const bee: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M38 138 C84 108 128 170 172 140 C214 112 246 168 286 148" stroke-width="1.4" opacity="0.45" stroke-dasharray="4 10"/>
    <g transform="translate(160 226)">
      <ellipse rx="52" ry="70" stroke-width="2.2"/>
      <path d="M-52 -18 L52 -18 M-52 12 L52 12 M-50 42 L50 42" stroke-width="1.6" opacity="0.7"/>
      <ellipse cx="-34" cy="-86" rx="42" ry="26" transform="rotate(-24 -34 -86)" stroke-width="1.8"/>
      <ellipse cx="34" cy="-86" rx="42" ry="26" transform="rotate(24 34 -86)" stroke-width="1.8"/>
      <circle cx="-20" cy="-38" r="5" fill="${p.ember}" stroke="none"/>
      <circle cx="20" cy="-38" r="5" fill="${p.ember}" stroke="none"/>
    </g>
  </g>
  ${dot(160, 120, 3, p.ember, 0.7)}`;

const lotus: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(160 214)">
      ${Array.from({ length: 8 }, (_, i) => `<g transform="rotate(${i * 45})"><path d="M0 -26 C24 -56 26 -104 0 -128 C-26 -104 -24 -56 0 -26 Z" stroke-width="1.8"/></g>`).join('')}
      ${Array.from({ length: 6 }, (_, i) => `<g transform="rotate(${i * 60 + 30})"><path d="M0 -20 C16 -44 18 -78 0 -96 C-18 -78 -16 -44 0 -20 Z" stroke-width="1.6" opacity="0.8"/></g>`).join('')}
      <circle r="22" stroke-width="2"/>
      <circle r="10" stroke-width="1.4" opacity="0.7"/>
    </g>
  </g>
  ${Array.from({ length: 8 }, (_, i) => {
    const a = (i * 45 * Math.PI) / 180;
    return dot(160 + Math.sin(a) * 124, 214 - Math.cos(a) * 124, 2.2, p.ember, 0.75);
  }).join('')}`;

const rocket: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(160 236) rotate(14)">
      <path d="M-26 78 C-26 40 -18 4 0 -70 C18 4 26 40 26 78 Z" stroke-width="2.2"/>
      <path d="M0 -70 L0 78" stroke-width="1.2" opacity="0.5"/>
      <path d="M-26 46 L-52 84 L-24 78 Z" stroke-width="1.8"/>
      <path d="M26 46 L52 84 L24 78 Z" stroke-width="1.8"/>
      <circle cx="0" cy="16" r="8" stroke-width="1.6"/>
      <path d="M-14 84 L-6 120 M14 84 L6 120 M0 84 L0 132" stroke-width="1.6" opacity="0.7"/>
    </g>
  </g>
  ${Array.from({ length: 14 }, (_, i) => {
    const x = 160 + ((i * 37) % 60) - 30;
    const y = 360 + ((i * 23) % 44);
    return dot(x, y, 1.2 + (i % 3) * 0.6, p.ember, 0.55);
  }).join('')}
  ${star(160, 96, 9, p.ember)}`;

const bouquet: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round" stroke-linejoin="round">
    <rect x="86" y="300" width="148" height="86" rx="8" stroke-width="2.2"/>
    <path d="M86 326 L234 326" stroke-width="1.2" opacity="0.5"/>
    ${Array.from({ length: 5 }, (_, i) => {
      const x = 104 + i * 28;
      return `<path d="M${x} 300 L${x} 252" stroke-width="1.8"/>`;
    }).join('')}
    ${Array.from({ length: 5 }, (_, i) => {
      const cx = 104 + i * 28;
      const len = 60 + (i % 3) * 16;
      return Array.from({ length: 5 }, (_, k) => {
        const a = ((-150 + k * 30) * Math.PI) / 180;
        return `<path d="M${cx} 252 L${(cx + Math.cos(a) * len).toFixed(1)} ${(252 + Math.sin(a) * len).toFixed(1)}" stroke-width="1.4"/>`;
      }).join('');
    }).join('')}
  </g>
  ${Array.from({ length: 5 }, (_, i) => star(104 + i * 28, 252 - (60 + (i % 3) * 16), 6, p.ember, 0.85)).join('')}`;

const spinner: Body = (p) => `
  <g fill="none" stroke="${p.line}" stroke-linecap="round">
    <path d="M92 330 C60 300 64 240 108 224 C156 206 204 240 198 284 C192 322 150 340 118 318 C92 300 96 268 124 258 C150 248 174 264 172 286" stroke-width="2.2"/>
    <path d="M232 300 C258 280 254 236 218 224" stroke-width="1.2" opacity="0.5" stroke-dasharray="4 9"/>
    <g transform="translate(172 286)">
      <rect x="-16" y="-10" width="32" height="22" rx="6" stroke-width="2"/>
      <path d="M0 -10 L0 -34" stroke-width="1.8"/>
    </g>
  </g>
  ${Array.from({ length: 10 }, (_, i) => {
    const a = (i * 36 * Math.PI) / 180;
    return dot(172 + Math.cos(a) * 34, 286 + Math.sin(a) * 34, 1.6, p.ember, 0.5);
  }).join('')}
  ${star(172, 252, 8, p.ember)}`;

const BODIES: Record<ArtFamily, Body> = {
  gatling,
  jellyfish,
  windmill,
  dragonfly,
  peacock,
  fountain,
  sparkler,
  doubleBang,
  firecracker,
  sunflower,
  butterfly,
  bee,
  lotus,
  rocket,
  bouquet,
  spinner
};

export function motifMarkup(family: ArtFamily, p: ArtPalette, uid: string): string {
  return BODIES[family](p, uid);
}

/** 线稿风格的 defs：只有极淡的暖光底 + 两层模糊，不再有实色背景 */
export function defsMarkup(p: ArtPalette, uid: string): string {
  return `<defs>
    <radialGradient id="${uid}-halo" cx=".5" cy=".42" r=".65">
      <stop offset="0" stop-color="${p.ember}" stop-opacity=".2"/>
      <stop offset=".55" stop-color="${p.ember}" stop-opacity=".05"/>
      <stop offset="1" stop-color="${p.ember}" stop-opacity="0"/>
    </radialGradient>
    <filter id="${uid}-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="${uid}-soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="12"/></filter>
  </defs>`;
}
