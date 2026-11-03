// Plain SVG charts - no chart library needed, they print and scale well.

import { compact, esc, money } from './format.js';

export const PAL = ['#1D4ED8', '#C2410C', '#15803D', '#6D28D9', '#B91C1C', '#0F766E', '#BE185D', '#B54708'];

export function barChart(title, cats, series, horiz = false) {
  const W = 520;
  const rowH = horiz ? 26 : 0;
  const H = horiz ? Math.max(150, (cats.length * rowH * series.length) / 1.6 + 50) : 230;
  const pl = horiz ? 150 : 46;
  const pr = 12;
  const pt = 30;
  const pb = horiz ? 14 : 44;
  let maxv = 1;
  series.forEach((s) => s.v.forEach((x) => { maxv = Math.max(maxv, Math.abs(x)); }));
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><text x="8" y="16" font-size="13" font-weight="700" fill="currentColor">${esc(title)}</text>`;
  series.forEach((s, i) => {
    out += `<rect x="${W - 110}" y="${4 + i * 13}" width="9" height="9" fill="${s.c}"/><text x="${W - 97}" y="${12 + i * 13}" font-size="10" fill="currentColor">${esc(s.n)}</text>`;
  });
  const n = Math.max(cats.length, 1);
  if (horiz) {
    const ph = H - pt - pb;
    const gh = ph / n;
    const bh = Math.min(14, (gh - 4) / series.length);
    cats.forEach((c, ci) => {
      const y0 = pt + ci * gh;
      out += `<text x="${pl - 6}" y="${y0 + gh / 2 + 3}" font-size="10" text-anchor="end" fill="currentColor">${esc(String(c).slice(0, 26))}</text>`;
      series.forEach((s, si) => {
        const w = ((W - pl - pr - 40) * Math.abs(s.v[ci])) / maxv;
        const y = y0 + (gh - bh * series.length) / 2 + si * bh;
        out += `<rect x="${pl}" y="${y}" width="${Math.max(w, 1)}" height="${bh - 1}" fill="${s.c}" rx="2"><title>${esc(String(c))} - ${esc(s.n)}: ${money(s.v[ci])}</title></rect><text x="${pl + w + 4}" y="${y + bh - 3}" font-size="9" fill="currentColor">${compact(s.v[ci])}</text>`;
      });
    });
  } else {
    const pw = W - pl - pr;
    const ph2 = H - pt - pb;
    const gw = pw / n;
    const bw = Math.min(36, (gw - 8) / series.length);
    for (let g = 0; g <= 4; g += 1) {
      const yy = pt + ph2 - (ph2 * g) / 4;
      out += `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" stroke="#8884" stroke-width="1"/><text x="${pl - 4}" y="${yy + 3}" font-size="9" text-anchor="end" fill="currentColor">${compact((maxv * g) / 4)}</text>`;
    }
    cats.forEach((c, ci) => {
      const x0 = pl + ci * gw;
      out += `<text x="${x0 + gw / 2}" y="${H - pb + 14}" font-size="9.5" text-anchor="middle" fill="currentColor">${esc(String(c).slice(0, 16))}</text>`;
      series.forEach((s, si) => {
        const v = Math.max(s.v[ci], 0);
        const h = (ph2 * v) / maxv;
        const x = x0 + (gw - bw * series.length) / 2 + si * bw;
        out += `<rect x="${x}" y="${pt + ph2 - h}" width="${bw - 2}" height="${Math.max(h, 0.5)}" fill="${s.c}" rx="2"><title>${esc(String(c))} - ${esc(s.n)}: ${money(s.v[ci])}</title></rect><text x="${x + bw / 2 - 1}" y="${pt + ph2 - h - 3}" font-size="8.5" text-anchor="middle" fill="currentColor">${compact(s.v[ci])}</text>`;
      });
    });
  }
  return `${out}</svg>`;
}

export function donut(title, items) {
  const tot = items.reduce((s, x) => s + Math.max(x.v, 0), 0);
  const W = 520;
  const H = 210;
  const cx = 110;
  const cy = 118;
  const R = 70;
  const r = 40;
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><text x="8" y="16" font-size="13" font-weight="700" fill="currentColor">${esc(title)}</text>`;
  if (tot <= 0) return `${out}<text x="${cx}" y="${cy}" font-size="12" text-anchor="middle" fill="currentColor">No data</text></svg>`;
  let a0 = -Math.PI / 2;
  items.forEach((it, i) => {
    if (it.v <= 0) return;
    const a1 = a0 + (2 * Math.PI * it.v) / tot;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const big = it.v === tot;
    const shrink = big ? 0.0001 : 0;
    const x0 = cx + R * Math.cos(a0);
    const y0 = cy + R * Math.sin(a0);
    const x1 = cx + R * Math.cos(a1 - shrink);
    const y1 = cy + R * Math.sin(a1 - shrink);
    const x2 = cx + r * Math.cos(a1 - shrink);
    const y2 = cy + r * Math.sin(a1 - shrink);
    const x3 = cx + r * Math.cos(a0);
    const y3 = cy + r * Math.sin(a0);
    const colour = it.c || PAL[i % PAL.length];
    out += `<path d="M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z" fill="${colour}"><title>${esc(it.l)}: ${it.money ? money(it.v) : it.v} (${Math.round((100 * it.v) / tot)}%)</title></path>`;
    out += `<rect x="230" y="${34 + i * 20}" width="10" height="10" fill="${colour}"/><text x="246" y="${43 + i * 20}" font-size="11" fill="currentColor">${esc(it.l)} - ${it.money ? money(it.v) : it.v} (${Math.round((100 * it.v) / tot)}%)</text>`;
    a0 = a1;
  });
  return `${out}</svg>`;
}
