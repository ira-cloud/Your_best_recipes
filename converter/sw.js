// Caches the whole app (including the OCR engine and language data) so it works fully offline.
// Bump APP_CACHE when the app files change; the large engine files stay in their own cache.
const APP_CACHE = 'ocr-app-v2';
const ENGINE_CACHE = 'ocr-engine-v1';
const APP_FILES = [
    './',
    'index.html',
    'app.js',
    'manifest.webmanifest',
    'icons/icon.svg',
    'icons/icon-192.png',
    'icons/icon-512.png',
];
const ENGINE_FILES = [
    'lib/tesseract.min.js',
    'lib/worker.min.js',
    'lib/core/tesseract-core-lstm.wasm.js',
    'lib/core/tesseract-core-simd-lstm.wasm.js',
    'lang/eng.traineddata.gz',
    'lang/rus.traineddata.gz',
];

// Fill a cache, skipping files it already holds; bypass the HTTP cache so updates arrive.
async function fill(cacheName, files) {
    const cache = await caches.open(cacheName);
    await Promise.all(files.map(async (f) => {
        if (await cache.match(f)) return;
        const res = await fetch(f, { cache: 'reload' });
        if (!res.ok) throw new Error('Failed to cache ' + f);
        await cache.put(f, res);
    }));
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.delete(APP_CACHE)
            .then(() => Promise.all([fill(APP_CACHE, APP_FILES), fill(ENGINE_CACHE, ENGINE_FILES)]))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys
                .filter((k) => k.startsWith('ocr-') && k !== APP_CACHE && k !== ENGINE_CACHE)
                .map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(
        caches.match(event.request, { ignoreSearch: true }).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).catch(() => (event.request.mode === 'navigate' ? caches.match('index.html') : Response.error()));
        })
    );
});
