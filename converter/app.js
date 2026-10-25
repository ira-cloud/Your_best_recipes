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

    const CACHE_NAME = 'ocr-converter-v1';
    async function isFullyCached() {
        try {
            const keys = await (await caches.open(CACHE_NAME)).keys();
            return ['rus.traineddata', 'eng.traineddata', 'tesseract-core-lstm', 'tesseract-core-simd-lstm', 'worker.min.js']
                .every((name) => keys.some((r) => r.url.includes(name)));
        } catch { return false; }
    }

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => setStatus('Офлайн-режим недоступен в этом браузере'));
        setStatus('Сохраняю файлы для работы без интернета (~14 МБ)…');
        (async function poll() {
            if (await isFullyCached()) setStatus('✅ Готово к работе без интернета', true);
            else setTimeout(poll, 1500);
        })();
    } else {
        setStatus('Офлайн-режим недоступен в этом браузере');
    }

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

    // ---------- Images ----------
    function addFiles(files) {
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            images.push({ id: nextId++, file, url: URL.createObjectURL(file), rotation: 0 });
        }
        renderThumbs();
    }

    function renderThumbs() {
        const box = $('thumbs');
        box.innerHTML = '';
        for (const img of images) {
            const el = document.createElement('div');
            el.className = 'thumb';
            el.innerHTML = `<img alt="" style="transform: rotate(${img.rotation}deg)">
                <div class="tools"><button data-act="rot" title="Повернуть">↻</button><button data-act="del" title="Удалить">✕</button></div>`;
            el.querySelector('img').src = img.url;
            el.querySelector('[data-act="rot"]').onclick = () => { img.rotation = (img.rotation + 90) % 360; renderThumbs(); };
            el.querySelector('[data-act="del"]').onclick = () => {
                URL.revokeObjectURL(img.url);
                images.splice(images.indexOf(img), 1);
                renderThumbs();
            };
            box.appendChild(el);
        }
        $('runBtn').disabled = images.length === 0;
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

    // Rotate, downscale huge photos, optionally boost contrast. Returns a canvas.
    async function prepare(img, enhance) {
        const bmp = await loadImage(img.url);
        const maxSide = 2600;
        const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        const w = Math.round(bmp.width * scale);
        const h = Math.round(bmp.height * scale);
        const swap = img.rotation === 90 || img.rotation === 270;
        const canvas = document.createElement('canvas');
        canvas.width = swap ? h : w;
        canvas.height = swap ? w : h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((img.rotation * Math.PI) / 180);
        ctx.drawImage(bmp, -w / 2, -h / 2, w, h);

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
            for (let i = 0; i < px.length; i += 4) {
                const v = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / range));
                px[i] = px[i + 1] = px[i + 2] = v;
            }
            ctx.putImageData(data, 0, 0);
        }
        return canvas;
    }

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
                const { data } = await w.recognize(canvas);
                let text = data.text.trim();
                if ($('optJoin').checked) text = joinLines(text);
                parts.push(text);
            }
            const out = parts.filter(Boolean).join('\n\n———\n\n');
            const res = $('result');
            res.value = res.value.trim() ? res.value.trim() + '\n\n' + out : out;
            $('progress').firstElementChild.style.width = '100%';
            $('progressText').textContent = out ? '✅ Готово' : 'Текст не найден — попробуйте более чёткое фото';
            res.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
            console.error(err);
            $('progressText').textContent = '❌ Ошибка: ' + (err && err.message ? err.message : err);
        } finally {
            btn.disabled = images.length === 0;
        }
    });

    // ---------- Result actions ----------
    $('copyBtn').addEventListener('click', async () => {
        const text = $('result').value;
        if (!text) return toast('Нечего копировать');
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            $('result').select();
            document.execCommand('copy');
        }
        toast('Скопировано');
    });

    $('shareBtn').addEventListener('click', async () => {
        const text = $('result').value;
        if (!text) return toast('Нечего отправлять');
        if (navigator.share) {
            try { await navigator.share({ text }); } catch { /* cancelled */ }
        } else {
            toast('Поделиться недоступно — используйте копирование');
        }
    });

    $('saveBtn').addEventListener('click', () => {
        const text = $('result').value;
        if (!text) return toast('Нечего сохранять');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        a.download = 'text-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.txt';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    $('clearBtn').addEventListener('click', () => {
        $('result').value = '';
        images.forEach((i) => URL.revokeObjectURL(i.url));
        images.length = 0;
        renderThumbs();
        $('progress').style.display = 'none';
        $('progressText').textContent = '';
    });
})();
