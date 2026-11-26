// 10 个家族母题（纯 SVG 字符串）。变体只换配色，不重画。
// 每个母题都按「实物插画加强版」的约定：主体占满、金属有明暗、爆点带光晕。

import type { ArtFamily } from '../../../db/cardArt';

export interface ArtPalette {
  accent: string;
  accent2: string;
  metal: string;
  metalDark: string;
  glow: string;
  bg1: string;
  bg2: string;
}

const PALETTES: Record<string, ArtPalette> = {
  normal: { accent: '#ffd27a', accent2: '#ff9f45', metal: '#e6ded0', metalDark: '#3a3733', glow: '#ffb35c', bg1: '#241709', bg2: '#0b0906' },
  gold: { accent: '#ffe6a8', accent2: '#c9a44f', metal: '#f0e3c2', metalDark: '#4a3d22', glow: '#ffcf7a', bg1: '#26180a', bg2: '#0d0906' },
  silver: { accent: '#eaf6ff', accent2: '#9fb6bd', metal: '#e8eef0', metalDark: '#39454a', glow: '#cfe6f0', bg1: '#101a20', bg2: '#070b0d' },
  blue: { accent: '#bfe6ff', accent2: '#5b8cff', metal: '#dbe7f0', metalDark: '#26364a', glow: '#8fc4ff', bg1: '#0a1526', bg2: '#060a12' },
  rainbow: { accent: '#bff6ea', accent2: '#f0a8e0', metal: '#e6f0ee', metalDark: '#2c3a3a', glow: '#8fe8dd', bg1: '#0b1a1e', bg2: '#080b12' },
  neon: { accent: '#c6ffb8', accent2: '#5fe0a0', metal: '#dfeade', metalDark: '#24342a', glow: '#9dffb0', bg1: '#0a1a12', bg2: '#060b08' }
};

export function paletteFor(variant: string): ArtPalette {
  return PALETTES[variant] ?? PALETTES.normal;
}

type Body = (p: ArtPalette, uid: string) => string;

const star = (x: number, y: number, r: number, fill: string, op = 1) =>
  `<path d="M${x} ${y - r} L${x + r * 0.28} ${y - r * 0.28} L${x + r} ${y} L${x + r * 0.28} ${y + r * 0.28} L${x} ${y + r} L${x - r * 0.28} ${y + r * 0.28} L${x - r} ${y} L${x - r * 0.28} ${y - r * 0.28} Z" fill="${fill}" opacity="${op}"/>`;

const spark = (x: number, y: number, r: number, c: string) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" opacity="0.8"/>`;

/** 一束从 (x,y) 沿 angle 射出的楔形光 */
function ray(x: number, y: number, angleDeg: number, len: number, width: number, grad: string) {
  const a = (angleDeg * Math.PI) / 180;
  const px = -Math.sin(a);
  const py = Math.cos(a);
  const tipx = x + Math.cos(a) * len;
  const tipy = y + Math.sin(a) * len;
  return `<polygon points="${x + px * width * 0.3},${y + py * width * 0.3} ${x + px * width},${y + py * width} ${tipx},${tipy} ${x - px * width},${y - py * width} ${x - px * width * 0.3},${y - py * width * 0.3}" fill="url(#${grad})"/>`;
}

const gatling: Body = (p, uid) => {
  const barrels = [-36, -22, -8, 8, 22, 36]
    .map((o) => {
      const px = 205 + 0.894 * o;
      const py = 352 - 0.447 * o;
      const front = o < 0;
      const w = front ? 9 : 7;
      const L = front ? 190 : 180;
      return `<g transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(-26.6)">
        <rect x="${-w}" y="${-L}" width="${w * 2}" height="${L}" rx="${w}" fill="url(#${uid}-${front ? 'steel' : 'steelDark'})"/>
        <rect x="${-w}" y="${-L}" width="${w * 0.5}" height="${L}" rx="${w * 0.25}" fill="#fff" opacity="0.13"/>
        <ellipse cx="0" cy="${-L}" rx="${w}" ry="${w * 0.5}" fill="#0a0806"/>
      </g>`;
    })
    .join('');
  const muzzles = [
    [92, 207],
    [105, 201],
    [118, 195],
    [131, 189],
    [144, 182],
    [157, 175]
  ];
  return `
    <g filter="url(#${uid}-soft)" opacity="0.5">
      <ellipse cx="96" cy="120" rx="62" ry="34" fill="${p.accent2}" opacity="0.35"/>
      <ellipse cx="150" cy="96" rx="54" ry="26" fill="${p.accent2}" opacity="0.22"/>
    </g>
    <g stroke="url(#${uid}-tracer)" stroke-linecap="round">
      <g stroke-width="7" opacity="0.2">${muzzles.map(([x, y]) => `<line x1="${x}" y1="${y}" x2="${x - 74}" y2="${y - 150}"/>`).join('')}</g>
      <g stroke-width="2.2">${muzzles.map(([x, y]) => `<line x1="${x}" y1="${y}" x2="${x - 74}" y2="${y - 150}"/>`).join('')}</g>
    </g>
    ${barrels}
    <g transform="translate(214 300) rotate(-26.6)">
      <rect x="-44" y="-16" width="88" height="20" rx="10" fill="url(#${uid}-steelDark)"/>
      <rect x="-44" y="-16" width="88" height="5" rx="2.5" fill="#fff" opacity="0.12"/>
      <circle cx="-30" cy="-6" r="2.4" fill="${p.accent}"/><circle cx="30" cy="-6" r="2.4" fill="${p.accent}"/>
    </g>
    <g transform="translate(206 352) rotate(-26.6)">
      <path d="M-22 0 L22 0 L16 74 L-16 74 Z" fill="#15120f" stroke="#3a332b" stroke-width="1.6"/>
      <path d="M-14 18 L14 18 M-15 36 L15 36 M-16 54 L16 54" stroke="#4a4036" stroke-width="2.2"/>
    </g>
    <g filter="url(#${uid}-bloom)" opacity="0.85">${muzzles.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="15" fill="${p.glow}"/>`).join('')}</g>
    ${muzzles.map(([x, y], i) => star(x, y, i === 2 ? 11 : 9, '#fff6d8')).join('')}
    <g fill="${p.accent}">
      <rect x="238" y="356" width="7" height="18" rx="3.5" transform="rotate(24 238 356)"/>
      <rect x="222" y="382" width="7" height="18" rx="3.5" transform="rotate(-14 222 382)"/>
    </g>`;
};

const jellyfish: Body = (p, uid) => `
  <g filter="url(#${uid}-bloom)" opacity="0.55"><ellipse cx="160" cy="150" rx="86" ry="54" fill="${p.glow}"/></g>
  <g fill="none" stroke="url(#${uid}-accent)" stroke-linecap="round">
    <path d="M120 182 C108 214 132 236 118 270 C108 296 124 312 112 336" stroke-width="5"/>
    <path d="M137 190 C130 222 152 240 142 274 C134 300 150 314 144 340" stroke-width="4"/>
    <path d="M158 194 C152 226 170 244 160 278 C152 304 166 318 160 344" stroke-width="4.5"/>
    <path d="M180 190 C186 222 168 240 180 274 C188 300 172 314 180 340" stroke-width="4"/>
    <path d="M199 182 C212 214 188 236 202 270 C212 296 196 312 208 336" stroke-width="5"/>
  </g>
  <path d="M96 168 C96 112 126 84 160 84 C194 84 224 112 224 168 C206 184 184 178 160 178 C136 178 114 184 96 168 Z"
        fill="url(#${uid}-accent)" stroke="#fff" stroke-opacity="0.35" stroke-width="1.5"/>
  <ellipse cx="160" cy="138" rx="44" ry="18" fill="#fff" opacity="0.22"/>
  <g stroke="#fff" stroke-opacity="0.4" stroke-width="1.2" fill="none">
    <path d="M126 168 C130 134 142 112 158 98"/><path d="M148 174 C150 140 152 114 160 94"/>
    <path d="M172 174 C170 140 168 114 160 94"/><path d="M194 168 C190 134 178 112 162 98"/>
  </g>
  <g fill="${p.accent}" opacity="0.7">
    ${[
      [96, 232, 3],
      [228, 216, 2.4],
      [214, 262, 3.4],
      [108, 288, 2.2],
      [196, 300, 2.6],
      [240, 300, 2],
      [86, 316, 2.4]
    ]
      .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`)
      .join('')}
  </g>`;

const windmill: Body = (p, uid) => {
  const blades = [0, 90, 180, 270]
    .map(
      (deg) => `<g transform="rotate(${deg})">
        <path d="M0 0 C26 -20 40 -64 8 -104 C-14 -72 -12 -30 0 0 Z" fill="url(#${uid}-accent)" stroke="#fff" stroke-opacity="0.35"/>
        <path d="M0 -8 L4 -92" stroke="#fff" stroke-opacity="0.35" stroke-width="1.4"/>
      </g>`
    )
    .join('');
  return `
    <g fill="none" stroke="${p.glow}" stroke-opacity="0.28" stroke-dasharray="4 9">
      <circle cx="160" cy="196" r="118"/><circle cx="160" cy="196" r="136" stroke-opacity="0.16"/>
    </g>
    <g transform="translate(160 196 196)">
      <g transform="translate(160 196)">${blades}</g>
    </g>
    <g filter="url(#${uid}-bloom)" opacity="0.55"><circle cx="160" cy="196" r="22" fill="${p.glow}"/></g>
    <g transform="translate(160 196)">
      <circle r="10" fill="url(#${uid}-steel)" stroke="${p.accent}" stroke-width="2"/>
    </g>
    <rect x="156" y="206" width="8" height="150" rx="4" fill="url(#${uid}-steelDark)"/>
    <rect x="156" y="206" width="3" height="150" fill="#fff" opacity="0.12"/>`;
};

const dragonfly: Body = (p, uid) => {
  const wing = (deg: number) =>
    `<g transform="rotate(${deg})"><path d="M0 0 C16 -30 30 -74 4 -106 C-20 -74 -16 -30 0 0 Z" fill="url(#${uid}-accent)" stroke="#fff" stroke-opacity="0.4"/><path d="M0 -6 L2 -98" stroke="#fff" stroke-opacity="0.3" stroke-width="1.2"/></g>`;
  return `
    <g fill="none" stroke="${p.glow}" stroke-opacity="0.3" stroke-dasharray="3 8"><circle cx="160" cy="206" r="120"/></g>
    <g transform="translate(160 206)">${[45, 135, 225, 315].map(wing).join('')}</g>
    <g filter="url(#${uid}-bloom)" opacity="0.45"><circle cx="160" cy="206" r="24" fill="${p.glow}"/></g>
    <rect x="151" y="176" width="18" height="134" rx="9" fill="url(#${uid}-steelDark)" stroke="${p.accent}" stroke-opacity="0.35"/>
    <g stroke="${p.accent}" stroke-opacity="0.45" stroke-width="1.4">
      ${[206, 226, 246, 266, 286].map((y) => `<path d="M152 ${y} L168 ${y}"/>`).join('')}
    </g>
    <circle cx="160" cy="166" r="17" fill="url(#${uid}-steelDark)" stroke="${p.accent}" stroke-opacity="0.5"/>
    <circle cx="153" cy="163" r="4.2" fill="${p.accent}"/><circle cx="167" cy="163" r="4.2" fill="${p.accent}"/>
    <circle cx="153" cy="163" r="1.8" fill="#0a2020"/><circle cx="167" cy="163" r="1.8" fill="#0a2020"/>`;
};

const peacock: Body = (p, uid) => {
  const feathers = Array.from({ length: 9 }, (_, i) => {
    const a = -166 + i * 9.5;
    const rad = (a * Math.PI) / 180;
    const x1 = 160 + Math.cos(rad) * 150;
    const y1 = 336 + Math.sin(rad) * 150;
    const x0 = 160 + Math.cos(rad) * 26;
    const y0 = 336 + Math.sin(rad) * 26;
    return `<g><path d="M${x0} ${y0} L${x1} ${y1}" stroke="url(#${uid}-accent)" stroke-width="2.6" stroke-linecap="round"/>
      <ellipse cx="${x1}" cy="${y1}" rx="9" ry="13" transform="rotate(${a + 90} ${x1} ${y1})" fill="url(#${uid}-accent)" stroke="${p.accent}" stroke-width="1.2"/>
      <circle cx="${x1}" cy="${y1}" r="3.4" fill="${p.accent}"/></g>`;
  }).join('');
  return `
    <g filter="url(#${uid}-bloom)" opacity="0.5"><ellipse cx="160" cy="300" rx="120" ry="80" fill="${p.glow}"/></g>
    ${feathers}
    <g transform="translate(160 336)">
      <ellipse rx="26" ry="12" fill="url(#${uid}-steelDark)"/>
      <path d="M-18 -6 C-14 -30 14 -30 18 -6 Z" fill="url(#${uid}-steel)" stroke="${p.accent}" stroke-opacity="0.5"/>
    </g>`;
};

const fountain: Body = (p, uid) => {
  const rays = Array.from({ length: 13 }, (_, i) => {
    const a = -90 + (i - 6) * 12;
    return ray(160, 322, a, 150 + (i % 3) * 24, 5, `${uid}-accent`);
  }).join('');
  return `
    <g filter="url(#${uid}-bloom)" opacity="0.5"><ellipse cx="160" cy="292" rx="80" ry="70" fill="${p.glow}"/></g>
    <g>${rays}</g>
    ${Array.from({ length: 26 }, (_, i) => {
      const a = ((i * 37) % 140) - 160;
      const r = 60 + ((i * 23) % 120);
      const rad = (a * Math.PI) / 180;
      return spark(160 + Math.cos(rad) * r, 322 + Math.sin(rad) * r, 1 + (i % 3) * 0.6, '#fff6d8');
    }).join('')}
    <g transform="translate(160 330)">
      <rect x="-24" y="-14" width="48" height="34" rx="8" fill="url(#${uid}-steelDark)" stroke="${p.accent}" stroke-opacity="0.4"/>
      <rect x="-24" y="-14" width="48" height="8" rx="4" fill="#fff" opacity="0.12"/>
      <circle cy="-16" r="7" fill="${p.accent}" filter="url(#${uid}-bloom)"/>
    </g>`;
};

const sparkler: Body = (p, uid) => {
  const sparks = Array.from({ length: 30 }, (_, i) => {
    const a = (i * 47) % 360;
    const r = 40 + ((i * 31) % 70);
    const rad = (a * Math.PI) / 180;
    return spark(120 + Math.cos(rad) * r, 128 + Math.sin(rad) * r, 1.2 + (i % 3) * 0.7, '#fff6d8');
  }).join('');
  return `
    <g filter="url(#${uid}-bloom)" opacity="0.7"><circle cx="120" cy="128" r="34" fill="${p.glow}"/></g>
    ${sparks}
    ${Array.from({ length: 8 }, (_, i) => ray(120, 128, i * 45 + 10, 90, 4, `${uid}-accent`)).join('')}
    <g transform="translate(120 128) rotate(38)">
      <rect x="-4" y="0" width="8" height="230" rx="4" fill="url(#${uid}-steelDark)"/>
      <rect x="-4" y="0" width="3" height="230" fill="#fff" opacity="0.12"/>
      <rect x="-6" y="-6" width="12" height="16" rx="4" fill="${p.accent}"/>
    </g>
    ${star(120, 128, 14, '#fff6d8')}`;
};

const doubleBang: Body = (p, uid) => `
  <g filter="url(#${uid}-bloom)" opacity="0.55">
    <circle cx="160" cy="128" r="42" fill="${p.glow}"/><circle cx="160" cy="236" r="26" fill="${p.glow}" opacity="0.7"/>
  </g>
  ${Array.from({ length: 7 }, (_, i) => ray(160, 236, -90 + (i - 3) * 26, 96, 4, `${uid}-accent`)).join('')}
  ${Array.from({ length: 9 }, (_, i) => ray(160, 160, -90 + (i - 4) * 24, 120, 4, `${uid}-accent`)).join('')}
  <g transform="translate(160 300)">
    <rect x="-30" y="-14" width="60" height="42" rx="6" fill="#8f2a20" stroke="#d9503f" stroke-width="1.6"/>
    <rect x="-30" y="-14" width="60" height="10" rx="4" fill="#fff" opacity="0.18"/>
    <rect x="-8" y="-56" width="16" height="42" rx="4" fill="url(#${uid}-steelDark)"/>
    <path d="M-30 4 L-44 -10" stroke="${p.accent}" stroke-width="2.4" stroke-linecap="round"/>
    ${star(160, 236, 12, '#fff6d8')}
    ${star(160, 128, 16, '#fff6d8')}
  </g>`;

const firecracker: Body = (p, uid) => {
  const tubes = Array.from({ length: 7 }, (_, i) => {
    const x = 56 + i * 32;
    const h = 96 + ((i * 17) % 24);
    return `<g><rect x="${x}" y="${330 - h}" width="22" height="${h}" rx="5" fill="#9b2c22" stroke="#e0604f" stroke-width="1.4"/>
      <rect x="${x}" y="${330 - h}" width="22" height="10" rx="4" fill="#fff" opacity="0.2"/>
      <path d="M${x + 11} ${330 - h} c-6 -18 6 -24 2 -38" stroke="${p.accent}" stroke-width="2" fill="none" stroke-linecap="round"/></g>`;
  }).join('');
  return `
    <g filter="url(#${uid}-bloom)" opacity="0.45"><ellipse cx="160" cy="270" rx="130" ry="70" fill="${p.glow}"/></g>
    ${tubes}
    ${Array.from({ length: 22 }, (_, i) => {
      const x = 58 + ((i * 47) % 230);
      const y = 120 + ((i * 31) % 110);
      return spark(x, y, 1 + (i % 3) * 0.7, '#fff6d8');
    }).join('')}
    ${[92, 156, 220].map((x, i) => star(x, 150 + i * 18, 10, '#fff6d8')).join('')}`;
};

const sunflower: Body = (p, uid) => {
  const petals = Array.from({ length: 12 }, (_, i) => {
    const a = i * 30;
    return `<g transform="rotate(${a})"><ellipse cx="0" cy="-104" rx="20" ry="46" fill="url(#${uid}-accent)" stroke="#fff" stroke-opacity="0.3"/></g>`;
  }).join('');
  return `
    <g filter="url(#${uid}-bloom)" opacity="0.5"><circle cx="160" cy="206" r="120" fill="${p.glow}"/></g>
    <g transform="translate(160 206)">${petals}</g>
    <g transform="translate(160 206)">
      <circle r="40" fill="url(#${uid}-steelDark)" stroke="${p.accent}" stroke-width="1.6"/>
      <circle r="26" fill="${p.accent2}" opacity="0.55"/>
      ${Array.from({ length: 18 }, (_, i) => {
        const rad = (i * 61 * Math.PI) / 180;
        const r = 6 + ((i * 13) % 22);
        return `<circle cx="${Math.cos(rad) * r}" cy="${Math.sin(rad) * r}" r="2.2" fill="${p.accent}"/>`;
      }).join('')}
    </g>
    <rect x="156" y="248" width="9" height="120" rx="4" fill="url(#${uid}-steelDark)"/>
    <path d="M160 320 C130 330 120 352 118 372 C142 366 154 352 160 336 Z" fill="${p.accent2}" opacity="0.7"/>`;
};

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
  sunflower
};

export function motifMarkup(family: ArtFamily, p: ArtPalette, uid: string): string {
  return BODIES[family](p, uid);
}

/** 共享 defs：金属、主色、光晕、bloom、暗角 */
export function defsMarkup(p: ArtPalette, uid: string): string {
  return `<defs>
    <radialGradient id="${uid}-bg" cx=".42" cy=".3" r=".85">
      <stop offset="0" stop-color="${p.bg1}"/><stop offset=".55" stop-color="${p.bg2}"/><stop offset="1" stop-color="#050708"/>
    </radialGradient>
    <linearGradient id="${uid}-steel" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2b2926"/><stop offset=".2" stop-color="${p.metal}"/><stop offset=".5" stop-color="#fff"/><stop offset=".72" stop-color="${p.metal}"/><stop offset="1" stop-color="${p.metalDark}"/>
    </linearGradient>
    <linearGradient id="${uid}-steelDark" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#171512"/><stop offset=".45" stop-color="${p.metalDark}"/><stop offset=".8" stop-color="#2a2724"/><stop offset="1" stop-color="#121110"/>
    </linearGradient>
    <linearGradient id="${uid}-accent" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="${p.accent2}"/><stop offset=".55" stop-color="${p.accent}"/><stop offset="1" stop-color="#fff8e6"/>
    </linearGradient>
    <linearGradient id="${uid}-tracer" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="${p.accent}" stop-opacity="0"/><stop offset=".55" stop-color="${p.accent}" stop-opacity=".85"/><stop offset="1" stop-color="#fffaf0"/>
    </linearGradient>
    <filter id="${uid}-bloom" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="${uid}-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="12"/></filter>
    <radialGradient id="${uid}-vig" cx=".5" cy=".48" r=".75">
      <stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".62"/>
    </radialGradient>
  </defs>`;
}
