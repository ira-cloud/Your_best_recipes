// Text reader on top of Tesseract, tuned for photos and screenshots (captions over pictures, stickers, chats).
// Like Google Lens or Live Text it works in two steps: first find the text lines, then read each line
// cut out and cleaned on its own background, so a busy photo behind the text doesn't confuse the engine.
window.Reader = (() => {
  // Two views of the picture: 'gray' — ordinary brightness; 'white' — only near-white pixels drawn black
  // (white captions straight over photos, which the ordinary view cannot separate from the background).
  function views(canvas) {
    const { width: w, height: h } = canvas;
    const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const g = new Uint8ClampedArray(w * h), m = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) {
      const r = px[i], gg = px[i + 1], b = px[i + 2];
      g[j] = (r * 0.299 + gg * 0.587 + b * 0.114) | 0;
      const mn = Math.min(r, gg, b), mx = Math.max(r, gg, b);
      m[j] = mn > 200 && mx - mn < 45 ? 0 : 255;
    }
    return { gray: { g, w, h }, white: { g: m, w, h } };
  }
  // Stretch 1..99% and make the text dark on light (the background is the majority = median).
  function normalize(view, x0, y0, cw, ch, scale) {
    const { g, w } = view;
    const hist = new Uint32Array(256); let n = 0;
    for (let y = y0; y < y0 + ch; y++) for (let x = x0; x < x0 + cw; x++) { hist[g[y * w + x]]++; n++; }
    let lo = 0, hi = 255, acc = 0, med = 0;
    while (lo < 255 && (acc += hist[lo]) < n * 0.01) lo++;
    acc = 0; while (hi > 0 && (acc += hist[hi]) < n * 0.01) hi--;
    acc = 0; while (med < 255 && (acc += hist[med]) < n * 0.5) med++;
    const invert = med < (lo + hi) / 2;
    const range = Math.max(1, hi - lo);
    const src = document.createElement('canvas'); src.width = cw; src.height = ch;
    const sctx = src.getContext('2d'); const id = sctx.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      let v = ((g[(y0 + y) * w + x0 + x] - lo) * 255) / range; v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (invert) v = 255 - v;
      const k = (y * cw + x) * 4; id.data[k] = id.data[k + 1] = id.data[k + 2] = v; id.data[k + 3] = 255;
    }
    sctx.putImageData(id, 0, 0);
    if (scale === 1) return src;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cw * scale)); out.height = Math.max(1, Math.round(ch * scale));
    const octx = out.getContext('2d'); octx.imageSmoothingQuality = 'high'; octx.drawImage(src, 0, 0, out.width, out.height);
    return out;
  }
  const alnum = (t) => (t.match(/[\p{L}\p{N}]/gu) || []).length;
  const LAT2CYR = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У', a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у' };
  // Latin look-alike letters inside Cyrillic text ("Ha" -> "На", "OH" -> "ОН")
  function fixMixed(text) {
    const cyr = (text.match(/[Ѐ-ӿ]/g) || []).length, lat = (text.match(/[A-Za-z]/g) || []).length;
    if (cyr <= lat) return text;
    return text.replace(/\p{L}+/gu, (w) => {
      const latin = w.replace(/[Ѐ-ӿ]/g, '');
      if (!latin || ![...latin].every((ch) => LAT2CYR[ch])) return w;
      if (latin.length === w.length && w.length > 3) return w; // a real English word
      return [...w].map((ch) => LAT2CYR[ch] || ch).join('');
    });
  }

  // Find lines in one view, cut each out, clean it on its own background, stack them on a white page, read the page.
  async function readView(worker, view, opt) {
    const TARGET = 48, GAP = 24; // line height the engine reads best, px; space between lines on the page
    opt.step();
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const { data: d1 } = await worker.recognize(normalize(view, 0, 0, view.w, view.h, 1), {}, { blocks: true });
    const lines = [];
    for (const b of d1.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) {
      const bb = l.bbox; const h = bb.y1 - bb.y0;
      if (h < 8 || bb.x1 - bb.x0 < 8 || !/[\p{L}\p{N}]{2}/u.test(l.text)) continue;
      lines.push({ x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 });
    }
    // pieces on the same row that touch horizontally form one line
    lines.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const rows = [];
    for (const l of lines) {
      const h = l.y1 - l.y0;
      const m = rows.find((r) => Math.min(r.y1, l.y1) - Math.max(r.y0, l.y0) > 0.6 * Math.min(r.y1 - r.y0, h) && l.x0 - r.x1 < 1.5 * h && r.x0 - l.x1 < 1.5 * h);
      if (m) { m.x0 = Math.min(m.x0, l.x0); m.x1 = Math.max(m.x1, l.x1); m.y0 = Math.min(m.y0, l.y0); m.y1 = Math.max(m.y1, l.y1); }
      else rows.push({ ...l });
    }
    rows.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
    if (!rows.length) { opt.step(); return []; }
    const crops = rows.map((r) => {
      const pad = Math.round((r.y1 - r.y0) * 0.2);
      const x0 = Math.max(0, r.x0 - pad), y0 = Math.max(0, r.y0 - pad);
      const cw = Math.min(view.w, r.x1 + pad) - x0, ch = Math.min(view.h, r.y1 + pad) - y0;
      return normalize(view, x0, y0, cw, ch, Math.min(3, Math.max(0.4, TARGET / (r.y1 - r.y0))));
    });
    const page = document.createElement('canvas');
    page.width = Math.max(...crops.map((c) => c.width)) + 2 * GAP;
    page.height = crops.reduce((s, c) => s + c.height + GAP, GAP);
    const pctx = page.getContext('2d'); pctx.fillStyle = '#fff'; pctx.fillRect(0, 0, page.width, page.height);
    const slots = []; let y = GAP;
    crops.forEach((c, i) => { pctx.drawImage(c, GAP, y); slots.push({ top: y, bottom: y + c.height, row: rows[i] }); y += c.height + GAP; });
    opt.step();
    await worker.setParameters({ tessedit_pageseg_mode: '4' });
    const { data: d2 } = await worker.recognize(page, {}, { blocks: true });
    const out = [];
    for (const b of d2.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) {
      let words = l.words.filter((w) => alnum(w.text) || /^[—–\-…:;,.!?«»„“"'()]+$/.test(w.text));
      // stray bits of frames and icons at the ends of a line
      while (words.length > 1 && alnum(words[0].text) <= 2 && words[0].confidence < 75) words.shift();
      while (words.length > 1 && alnum(words[words.length - 1].text) <= 2 && words[words.length - 1].confidence < 75) words.pop();
      const longest = Math.max(0, ...words.map((w) => alnum(w.text)));
      if (l.confidence < (opt.minConf || 60) || longest < 2 || (longest < 3 && l.confidence < 85)) continue;
      const cy = (l.bbox.y0 + l.bbox.y1) / 2;
      const slot = slots.find((s) => cy >= s.top - GAP / 2 && cy <= s.bottom + GAP / 2) || slots[0];
      out.push({ text: fixMixed(words.map((w) => w.text).join(' ')), y: (slot.row.y0 + slot.row.y1) / 2, y0: slot.row.y0, y1: slot.row.y1, x: slot.row.x0 });
    }
    return out;
  }

  function similar(a, b) {
    a = a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); b = b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length] / Math.max(a.length, b.length) < 0.35;
  }

  // Read a picture. onStep(done, total) reports progress between the engine passes.
  async function read(worker, canvas, onStep = () => {}) {
    const V = views(canvas);
    let done = 0;
    const opt = { step: () => onStep(done++, 4) };
    const lines = await readView(worker, V.gray, opt);
    // white captions over photos: add only lines the ordinary view did not already read
    for (const w of await readView(worker, V.white, { ...opt, minConf: 80 })) {
      if (!lines.some((g) => similar(g.text, w.text))) lines.push(w);
    }
    lines.sort((a, b) => a.y - b.y || a.x - b.x);
    // a blank line between blocks that stand apart
    let text = '';
    lines.forEach((l, i) => {
      const p = lines[i - 1];
      if (p) text += l.y0 - p.y1 > 0.8 * Math.min(p.y1 - p.y0, l.y1 - l.y0) ? '\n\n' : '\n';
      text += l.text;
    });
    return text;
  }

  // Plain one-pass reading of the whole picture, nothing filtered out.
  async function readPlain(worker, canvas) {
    const gray = views(canvas).gray;
    await worker.setParameters({ tessedit_pageseg_mode: '3' });
    const { data } = await worker.recognize(normalize(gray, 0, 0, gray.w, gray.h, 1));
    return fixMixed(data.text);
  }

  return { read, readPlain, fixMixed };
})();
