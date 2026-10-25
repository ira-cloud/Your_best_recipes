(() => {
    const $ = (id) => document.getElementById(id);
    const images = []; // { id, file, url, rotation }
    let worker = null;
    let workerLang = null;
    let nextId = 1;

    const toast = (msg) => {
        const t = $('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => t.classList.remove('show'), 1800);
    };

    // ---------- Offline (service worker) ----------
    const setStatus = (text, ok) => {
        $('status').textContent = text;
        $('status').classList.toggle('ok', !!ok);
    };

    const OFFLINE_FILES = ['rus.traineddata', 'ukr.traineddata', 'eng.traineddata', 'tesseract-core-lstm', 'tesseract-core-simd-lstm', 'worker.min.js', 'app.js'];
    async function isFullyCached() {
        try {
            const urls = [];
            for (const name of await caches.keys()) {
                if (!name.startsWith('ocr-')) continue;
                urls.push(...(await (await caches.open(name)).keys()).map((r) => r.url));
            }
            return OFFLINE_FILES.every((f) => urls.some((u) => u.includes(f)));
        } catch { return false; }
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => setStatus('Офлайн-режим недоступен в этом браузере'));
        setStatus('Сохраняю файлы для работы без интернета (~16 МБ)…');
        (async function poll() {
            if (await isFullyCached()) setStatus('✅ Готово к работе без интернета', true);
            else setTimeout(poll, 1500);
        })();
        // A new version was installed: reload once so it takes effect.
        let reloaded = false;
        const hadController = !!navigator.serviceWorker.controller;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController || reloaded) return;
            reloaded = true;
            location.reload();
        });
    } else {
        setStatus('Офлайн-режим недоступен в этом браузере');
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    // ---------- Install prompt (Android/Chrome) ----------
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        $('installBtn').style.display = 'flex';
    });
    $('installBtn').addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        $('installBtn').style.display = 'none';
    });

    // ---------- Notes storage ----------
    const NOTES_KEY = 'ocr-notes';
    let notes = [];
    try { notes = JSON.parse(localStorage.getItem(NOTES_KEY)) || []; } catch { notes = []; }

    function persistNotes() {
        try {
            localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
            $('notesCount').textContent = notes.length;
            return true;
        } catch {
            toast('Не удалось сохранить — память телефона заполнена?');
            return false;
        }
    }

    const noteTitle = (n) => (n.text.trim().split('\n')[0] || 'Без названия').slice(0, 80);
    const fmtDate = (ts) => new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const findNote = (id) => notes.find((n) => n.id === id);

    function createNote(text) {
        const now = Date.now();
        const note = { id: String(now) + Math.random().toString(36).slice(2, 6), text, created: now, updated: now };
        notes.unshift(note);
        persistNotes();
        return note;
    }

    function appendToNote(note, text) {
        note.text = note.text.trim() ? note.text.replace(/\s+$/, '') + '\n\n' + text : text;
        note.updated = Date.now();
        // keep most recently changed first
        notes.splice(notes.indexOf(note), 1);
        notes.unshift(note);
        persistNotes();
    }

    // ---------- Views ----------
    let openNoteId = null;
    let targetNoteId = null; // note that new recognized text will be appended to

    function setNoteFull(on) {
        document.body.classList.toggle('note-full', on);
        $('fullBtn').textContent = on ? '↙ Свернуть' : '⛶ Весь экран';
    }
    $('fullBtn').addEventListener('click', () => setNoteFull(!document.body.classList.contains('note-full')));

    function showView(name) {
        if (name !== 'note') setNoteFull(false);
        document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
        const onNotes = name === 'notes' || name === 'note';
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', onNotes && t.dataset.view === 'notes'));
        if (name === 'notes') renderNotes();
        window.scrollTo(0, 0);
    }
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
        closeNote();
        showView(t.dataset.view);
    }));

    function renderNotes() {
        $('notesCount').textContent = notes.length;
        const q = $('search').value.trim().toLowerCase();
        const list = $('notesList');
        list.innerHTML = '';
        const shown = q ? notes.filter((n) => n.text.toLowerCase().includes(q)) : notes;
        if (!shown.length) {
            list.innerHTML = q
                ? '<div class="empty">Ничего не найдено</div>'
                : '<div class="empty">Заметок пока нет.<br>Распознайте текст с фото и нажмите «Сохранить в блокнот» или создайте заметку вручную.</div>';
            return;
        }
        for (const n of shown) {
            const el = document.createElement('button');
            el.className = 'note';
            const rest = n.text.trim().split('\n').slice(1).join(' ').trim();
            el.innerHTML = '<div class="title"></div><div class="preview"></div><div class="date"></div>';
            el.querySelector('.title').textContent = noteTitle(n);
            el.querySelector('.preview').textContent = rest;
            el.querySelector('.date').textContent = fmtDate(n.updated);
            el.addEventListener('click', () => openNote(n.id));
            list.appendChild(el);
        }
    }
    $('search').addEventListener('input', renderNotes);

    function openNote(id) {
        const n = findNote(id);
        if (!n) return;
        openNoteId = id;
        $('noteText').value = n.text;
        $('savedState').textContent = 'Изменено ' + fmtDate(n.updated);
        showView('note');
    }

    function closeNote() {
        saveOpenNote();
        const n = openNoteId && findNote(openNoteId);
        // drop notes that were created and left empty
        if (n && !n.text.trim()) {
            notes.splice(notes.indexOf(n), 1);
            persistNotes();
        }
        openNoteId = null;
    }

    let saveTimer = null;
    function saveOpenNote() {
        clearTimeout(saveTimer);
        const n = openNoteId && findNote(openNoteId);
        if (!n || n.text === $('noteText').value) return;
        n.text = $('noteText').value;
        n.updated = Date.now();
        if (persistNotes()) $('savedState').textContent = '✓ Сохранено';
    }
    $('noteText').addEventListener('input', () => {
        $('savedState').textContent = '…';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(saveOpenNote, 500);
    });
    // save if the app is closed or hidden mid-edit
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveOpenNote(); });
    window.addEventListener('pagehide', saveOpenNote);

    $('backBtn').addEventListener('click', () => { closeNote(); showView('notes'); });
    $('newNoteBtn').addEventListener('click', () => {
        const n = createNote('');
        openNote(n.id);
        $('noteText').focus();
    });

    $('addFromPhotoBtn').addEventListener('click', () => {
        saveOpenNote();
        const n = findNote(openNoteId);
        if (!n) return;
        if (!n.text.trim()) { n.text = ' '; persistNotes(); } // keep it from being dropped as empty
        setTarget(n.id);
        openNoteId = null;
        showView('scan');
    });

    function setTarget(id) {
        targetNoteId = id;
        const n = id && findNote(id);
        $('target').classList.toggle('show', !!n);
        if (n) $('targetTitle').textContent = n.text.trim() ? noteTitle(n) : 'новая заметка';
        $('toNoteBtn').textContent = n ? '📒 Добавить в заметку' : '📒 Сохранить в блокнот';
    }
    $('targetCancel').addEventListener('click', () => setTarget(null));

    $('toNoteBtn').addEventListener('click', () => {
        const text = $('result').value.trim();
        if (!text) return toast('Сначала распознайте текст');
        const target = targetNoteId && findNote(targetNoteId);
        let note;
        if (target) {
            if (!target.text.trim()) target.text = '';
            appendToNote(target, text);
            note = target;
        } else {
            note = createNote(text);
        }
        setTarget(null);
        resetScan();
        toast(target ? 'Добавлено в заметку' : 'Сохранено в блокнот');
        openNote(note.id);
    });

    // ---------- Note actions ----------
    async function copyText(text, fallbackEl) {
        if (!text.trim()) return toast('Нечего копировать');
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            fallbackEl.select();
            document.execCommand('copy');
        }
        toast('Скопировано');
    }
    $('noteCopyBtn').addEventListener('click', () => copyText($('noteText').value, $('noteText')));
    $('noteShareBtn').addEventListener('click', async () => {
        const text = $('noteText').value;
        if (!text.trim()) return toast('Нечего отправлять');
        if (navigator.share) {
            try { await navigator.share({ text }); } catch { /* cancelled */ }
        } else {
            copyText(text, $('noteText'));
        }
    });
    $('noteSaveBtn').addEventListener('click', () => {
        const text = $('noteText').value;
        if (!text.trim()) return toast('Нечего сохранять');
        const name = noteTitle({ text }).replace(/[\\/:*?"<>|]+/g, '').slice(0, 40).trim() || 'заметка';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        a.download = name + '.txt';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('noteDeleteBtn').addEventListener('click', () => {
        const n = findNote(openNoteId);
        if (!n) return;
        if (n.text.trim() && !confirm('Удалить заметку «' + noteTitle(n) + '»?')) return;
        notes.splice(notes.indexOf(n), 1);
        persistNotes();
        if (targetNoteId === n.id) setTarget(null);
        openNoteId = null;
        toast('Заметка удалена');
        showView('notes');
    });

    // ---------- Images ----------
    // Each item: { id, file, url, rotation, crop, thumb }; crop is { x, y, w, h } as 0..1 of the rotated photo, or null.
    // Several items may share one photo (different zones of the same picture).
    function removeImage(img) {
        images.splice(images.indexOf(img), 1);
        if (!images.some((i) => i.url === img.url)) URL.revokeObjectURL(img.url);
    }

    function addFiles(files) {
        const added = [];
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            const img = { id: nextId++, file, url: URL.createObjectURL(file), rotation: 0, crop: null, thumb: null };
            images.push(img);
            added.push(img);
        }
        renderThumbs();
        added.forEach(updateThumb);
    }

    async function updateThumb(img) {
        try {
            img.thumb = (await renderImage(img, 320)).toDataURL('image/jpeg', 0.8);
        } catch {
            img.thumb = null;
        }
        renderThumbs();
    }

    function moveImage(img, dir) {
        const i = images.indexOf(img);
        const j = i + dir;
        if (j < 0 || j >= images.length) return;
        [images[i], images[j]] = [images[j], images[i]];
        renderThumbs();
    }

    function renderThumbs() {
        const box = $('thumbs');
        box.innerHTML = '';
        images.forEach((img, i) => {
            const el = document.createElement('div');
            el.className = 'thumb';
            el.innerHTML = `<img alt="Открыть фото"><div class="num">${i + 1}</div>${img.crop ? '<div class="cropped">✂️ зона</div>' : ''}
                <div class="tools"><button data-act="left" title="Раньше">◀</button><button data-act="rot" title="Повернуть">↻</button><button data-act="right" title="Позже">▶</button><button data-act="del" title="Удалить">✕</button></div>`;
            el.querySelector('img').src = img.thumb || img.url;
            el.querySelector('img').onclick = () => openCropper(img);
            el.querySelector('[data-act="left"]').disabled = i === 0;
            el.querySelector('[data-act="right"]').disabled = i === images.length - 1;
            el.querySelector('[data-act="left"]').onclick = () => moveImage(img, -1);
            el.querySelector('[data-act="right"]').onclick = () => moveImage(img, 1);
            el.querySelector('[data-act="rot"]').onclick = () => {
                img.rotation = (img.rotation + 90) % 360;
                img.crop = null;
                updateThumb(img);
            };
            el.querySelector('[data-act="del"]').onclick = () => { removeImage(img); renderThumbs(); };
            box.appendChild(el);
        });
        $('thumbsHint').textContent = !images.length ? ''
            : 'Нажмите на фото, чтобы открыть его и выделить нужный текст.' +
              (images.length > 1 ? ` ${images.length} картинки — текст соберётся в один по порядку номеров.` : '');
        $('runBtn').disabled = images.length === 0;
        $('runBtn').textContent = images.length > 1 ? `🔍 Распознать ${images.length} картинки в один текст` : '🔍 Распознать текст';
    }

    $('cameraInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

    const drop = $('drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
    window.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile());
        if (files.length) addFiles(files);
    });

    // Draw the photo rotated and (optionally) cropped onto a canvas, at most maxSide px on the longer side.
    // Small zones are enlarged up to 2x: the engine reads small text better when it is bigger.
    async function renderImage(img, maxSide, { useCrop = true, upscale = false } = {}) {
        const bmp = await loadImage(img.url);
        const swap = img.rotation % 180 !== 0;
        const fullW = swap ? bmp.height : bmp.width;
        const fullH = swap ? bmp.width : bmp.height;
        const c = useCrop && img.crop ? img.crop : { x: 0, y: 0, w: 1, h: 1 };
        const sw = fullW * c.w;
        const sh = fullH * c.h;
        const scale = Math.min(maxSide / Math.max(sw, sh), upscale && Math.max(sw, sh) < 1200 ? 2 : 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(sw * scale));
        canvas.height = Math.max(1, Math.round(sh * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        ctx.scale(scale, scale);
        ctx.translate(-fullW * c.x + fullW / 2, -fullH * c.y + fullH / 2);
        ctx.rotate((img.rotation * Math.PI) / 180);
        ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
        return canvas;
    }

    // Rotate, crop, resize, optionally boost contrast. Returns a canvas.
    async function prepare(img, enhance) {
        const canvas = await renderImage(img, 2600, { upscale: true });
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        if (enhance) {
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const px = data.data;
            // grayscale + stretch histogram (1%..99%)
            const hist = new Uint32Array(256);
            for (let i = 0; i < px.length; i += 4) {
                const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
                px[i] = g;
                hist[g]++;
            }
            const total = px.length / 4;
            let lo = 0, hi = 255, acc = 0;
            while (lo < 255 && (acc += hist[lo]) < total * 0.01) lo++;
            acc = 0;
            while (hi > 0 && (acc += hist[hi]) < total * 0.01) hi--;
            const range = Math.max(1, hi - lo);
            // light text on a dark background (dark-mode screenshots): invert to dark-on-light
            let sum = 0;
            for (let g = 0; g < 256; g++) sum += hist[g] * g;
            const invert = ((sum / total - lo) * 255) / range < 110;
            for (let i = 0; i < px.length; i += 4) {
                let v = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / range));
                if (invert) v = 255 - v;
                px[i] = px[i + 1] = px[i + 2] = v;
            }
            ctx.putImageData(data, 0, 0);
        }
        return canvas;
    }

    // ---------- Photo viewer: pick the zone to recognize ----------
    const crop = { img: null, rect: null, drag: null, w: 0, h: 0, startRotation: 0 };
    const HANDLE = 30; // touch radius around a corner, px

    async function openCropper(img) {
        crop.img = img;
        crop.startRotation = img.rotation;
        crop.startCrop = img.crop;
        $('cropper').hidden = false;
        document.body.classList.add('cropping');
        await drawCropper(img.crop);
    }

    async function drawCropper(norm) {
        const stage = $('cropStage');
        const full = await renderImage(crop.img, 2400, { useCrop: false });
        const fit = Math.min(stage.clientWidth / full.width, stage.clientHeight / full.height);
        crop.w = Math.floor(full.width * fit);
        crop.h = Math.floor(full.height * fit);
        const cv = $('cropCanvas');
        cv.width = full.width;
        cv.height = full.height;
        cv.getContext('2d').drawImage(full, 0, 0);
        $('cropWrap').style.width = crop.w + 'px';
        $('cropWrap').style.height = crop.h + 'px';
        crop.rect = norm ? { x: norm.x * crop.w, y: norm.y * crop.h, w: norm.w * crop.w, h: norm.h * crop.h } : null;
        updateCropBox();
    }

    function updateCropBox() {
        const r = crop.rect;
        const box = $('cropBox');
        box.hidden = !r;
        if (r) Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        $('cropDup').disabled = !r;
    }

    function cropNorm() {
        const r = crop.rect;
        return r ? { x: r.x / crop.w, y: r.y / crop.h, w: r.w / crop.w, h: r.h / crop.h } : null;
    }

    function closeCropper() {
        $('cropper').hidden = true;
        document.body.classList.remove('cropping');
        crop.img = null;
    }

    const cropPoint = (e) => {
        const b = $('cropWrap').getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(crop.w, e.clientX - b.left)),
            y: Math.max(0, Math.min(crop.h, e.clientY - b.top)),
        };
    };

    $('cropStage').addEventListener('pointerdown', (e) => {
        e.preventDefault();
        $('cropStage').setPointerCapture(e.pointerId);
        const p = cropPoint(e);
        const r = crop.rect;
        if (r) {
            // corners: top-left, top-right, bottom-left, bottom-right; dragging one keeps the opposite in place
            const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
            const k = corners.findIndex(([cx, cy]) => Math.hypot(p.x - cx, p.y - cy) < HANDLE);
            if (k >= 0) {
                crop.drag = { mode: 'draw', ax: corners[3 - k][0], ay: corners[3 - k][1] };
                return;
            }
            if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) {
                crop.drag = { mode: 'move', dx: p.x - r.x, dy: p.y - r.y };
                return;
            }
        }
        crop.drag = { mode: 'draw', ax: p.x, ay: p.y };
    });

    $('cropStage').addEventListener('pointermove', (e) => {
        const d = crop.drag;
        if (!d) return;
        const p = cropPoint(e);
        if (d.mode === 'draw') {
            crop.rect = { x: Math.min(d.ax, p.x), y: Math.min(d.ay, p.y), w: Math.abs(p.x - d.ax), h: Math.abs(p.y - d.ay) };
        } else {
            const r = crop.rect;
            r.x = Math.max(0, Math.min(crop.w - r.w, p.x - d.dx));
            r.y = Math.max(0, Math.min(crop.h - r.h, p.y - d.dy));
        }
        updateCropBox();
    });

    const endDrag = () => {
        if (!crop.drag) return;
        crop.drag = null;
        // a tap or a tiny box means "no zone"
        if (crop.rect && (crop.rect.w < 15 || crop.rect.h < 15)) crop.rect = null;
        updateCropBox();
    };
    $('cropStage').addEventListener('pointerup', endDrag);
    $('cropStage').addEventListener('pointercancel', endDrag);

    $('cropDone').addEventListener('click', () => {
        const img = crop.img;
        img.crop = cropNorm();
        closeCropper();
        updateThumb(img);
    });
    $('cropCancel').addEventListener('click', () => {
        const img = crop.img;
        const changed = img.rotation !== crop.startRotation;
        img.rotation = crop.startRotation;
        img.crop = crop.startCrop;
        closeCropper();
        if (changed) updateThumb(img);
    });
    $('cropAll').addEventListener('click', () => { crop.rect = null; updateCropBox(); });
    $('cropRotate').addEventListener('click', () => {
        crop.img.rotation = (crop.img.rotation + 90) % 360;
        drawCropper(null);
    });
    $('cropDup').addEventListener('click', async () => {
        const img = crop.img;
        img.crop = cropNorm();
        updateThumb(img);
        const next = { id: nextId++, file: img.file, url: img.url, rotation: img.rotation, crop: null, thumb: img.thumb };
        images.splice(images.indexOf(img) + 1, 0, next);
        renderThumbs();
        crop.img = next;
        crop.startRotation = next.rotation;
        crop.startCrop = null;
        await drawCropper(null);
        toast('Зона сохранена. Выделите следующую');
    });
    window.addEventListener('resize', () => { if (crop.img) drawCropper(cropNorm()); });

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = url;
        });
    }

    // ---------- OCR ----------
    let currentPage = { index: 0, total: 1 };
    function onProgress(m) {
        const bar = $('progress').firstElementChild;
        const labels = {
            'loading tesseract core': 'Загрузка движка',
            'initializing tesseract': 'Запуск движка',
            'loading language traineddata': 'Загрузка языка',
            'initializing api': 'Подготовка',
            'recognizing text': 'Распознавание',
        };
        const label = labels[m.status] || m.status;
        const pct = Math.round((m.progress || 0) * 100);
        if (m.status === 'recognizing text') {
            const overall = ((currentPage.index + (m.progress || 0)) / currentPage.total) * 100;
            bar.style.width = overall + '%';
            $('progressText').textContent = `${label}: картинка ${currentPage.index + 1} из ${currentPage.total} — ${pct}%`;
        } else {
            $('progressText').textContent = `${label}… ${pct}%`;
        }
    }

    async function getWorker(lang) {
        if (worker && workerLang === lang) return worker;
        if (worker) await worker.terminate();
        const base = new URL('./', location.href).href;
        worker = await Tesseract.createWorker(lang.split('+'), Tesseract.OEM.LSTM_ONLY, {
            workerPath: base + 'lib/worker.min.js',
            corePath: base + 'lib/core',
            langPath: base + 'lang',
            gzip: true,
            workerBlobURL: false,
            logger: onProgress,
        });
        workerLang = lang;
        return worker;
    }

    // Build text from recognized lines, dropping what the engine was unsure about:
    // icons, buttons and frames come out as low-confidence junk like "] Г adh" or "| ©]".
    function cleanText(data) {
        const blocks = [];
        for (const block of data.blocks || []) {
            const paras = [];
            for (const para of block.paragraphs) {
                const lines = [];
                for (const line of para.lines) {
                    if (line.confidence < 55) continue;
                    const words = line.words.filter((w) => w.confidence >= 60 && (/[\p{L}\p{N}]/u.test(w.text) || /^[—–\-…:;,.!?«»„“"'()]+$/.test(w.text)));
                    if (!words.some((w) => (w.text.match(/[\p{L}\p{N}]/gu) || []).length >= 2)) continue;
                    lines.push(words.map((w) => w.text).join(' '));
                }
                if (lines.length) paras.push(lines.join('\n'));
            }
            if (paras.length) blocks.push(paras.join('\n\n'));
        }
        return blocks.join('\n\n');
    }

    function joinLines(text) {
        return text
            .split(/\n{2,}/)
            .map((p) => p.replace(/-\n(?=\p{Ll})/gu, '').replace(/\s*\n\s*/g, ' ').trim())
            .filter(Boolean)
            .join('\n\n');
    }

    $('runBtn').addEventListener('click', async () => {
        if (!images.length) return;
        const btn = $('runBtn');
        btn.disabled = true;
        $('progress').style.display = 'block';
        $('progress').firstElementChild.style.width = '0%';
        try {
            const w = await getWorker($('lang').value);
            const parts = [];
            currentPage = { index: 0, total: images.length };
            for (let i = 0; i < images.length; i++) {
                currentPage.index = i;
                const canvas = await prepare(images[i], $('optEnhance').checked);
                const clean = $('optClean').checked;
                const { data } = await w.recognize(canvas, {}, { text: true, blocks: clean });
                let text = (clean ? cleanText(data) : data.text).trim();
                if ($('optJoin').checked) text = joinLines(text);
                parts.push(text);
            }
            const sep = $('optSeparator').checked ? '\n\n———\n\n' : '\n\n';
            const out = parts.filter(Boolean).join(sep);
            const res = $('result');
            res.value = res.value.trim() ? res.value.trim() + sep + out : out;
            $('progress').firstElementChild.style.width = '100%';
            $('progressText').textContent = out
                ? (images.length > 1 ? `✅ Готово: текст с ${images.length} картинок собран в один` : '✅ Готово')
                : 'Текст не найден — попробуйте более чёткое фото';
            res.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
            console.error(err);
            $('progressText').textContent = '❌ Ошибка: ' + (err && err.message ? err.message : err);
        } finally {
            btn.disabled = images.length === 0;
        }
    });

    // ---------- Result actions ----------
    function resetScan() {
        $('result').value = '';
        new Set(images.map((i) => i.url)).forEach((u) => URL.revokeObjectURL(u));
        images.length = 0;
        renderThumbs();
        $('progress').style.display = 'none';
        $('progressText').textContent = '';
    }

    // remember the chosen language
    try { const saved = localStorage.getItem('ocr-lang'); if (saved && $('lang').querySelector(`option[value="${saved}"]`)) $('lang').value = saved; } catch { /* ignore */ }
    $('lang').addEventListener('change', () => { try { localStorage.setItem('ocr-lang', $('lang').value); } catch { /* ignore */ } });

    $('copyBtn').addEventListener('click', () => copyText($('result').value, $('result')));
    $('clearBtn').addEventListener('click', resetScan);

    renderThumbs();
    $('notesCount').textContent = notes.length;
})();
