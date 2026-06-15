(function () {
    'use strict';

    // ─── Constants ───────────────────────────────────────────────────────
    const PROXIES = [
        (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
        (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
        (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    ];
    const GTRANSLATE = 'https://translate.googleapis.com/translate_a/single';
    const BATCH_SEP = '\n';
    const BATCH_MAX_CHARS = 800;
    const BATCH_MAX_ITEMS = 10;

    const RSS_URL = 'https://trends.google.com/trending/rss?geo={geo}';
    const NEWS_RSS_URL = 'https://news.google.com/rss/search?q=trending&hl=en&gl={geo}&ceid={geo}:en';

    const FALLBACK_FEEDS = [
        ['Yandex News', 'https://newssearch.yandex.ru/news/rss?text=&lr=213'],
        ['Dzen', 'https://dzen.ru/rss/topnews'],
        ['Mail.ru', 'https://news.mail.ru/rss'],
    ];

    const TRAFFIC_MAP = {
        '<1K': 1, '1K+': 2, '5K+': 3,
        '10K+': 4, '25K+': 5, '50K+': 6, '100K+': 7,
    };

    const TOP_20 = [
        'US', 'CN', 'JP', 'DE', 'IN', 'GB', 'FR', 'IT', 'CA', 'BR',
        'RU', 'KR', 'AU', 'ES', 'MX', 'ID', 'NL', 'SA', 'TR', 'PL',
    ];

    // ─── State ───────────────────────────────────────────────────────────
    let dataType = 'queries';
    let allTopics = [];
    let currentTab = 'table';
    let selectedTopicIdx = -1;

    // ─── Translation Cache ──────────────────────────────────────────────
    const translationCache = {};

    // ─── DOM refs ────────────────────────────────────────────────────────
    const $ = (s) => document.querySelector(s);
    const topicList = $('#topicList');
    const emptyState = $('#emptyState');
    const detailContent = $('#detailContent');
    const loadingOverlay = $('#loadingOverlay');
    const loadingText = $('#loadingText');
    const statsText = $('#statsText');
    const refreshBtn = $('#refreshBtn');
    const translateCheck = $('#translateCheck');
    const periodSelect = $('#periodSelect');
    const statusBadge = $('#statusBadge');

    // ─── Helpers ─────────────────────────────────────────────────────────
    function hasCyrillic(text) {
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c >= 0x400 && c <= 0x4ff) return true;
        }
        return false;
    }

    function cleanQuery(text) {
        text = decodeURIComponent(text);
        text = text.replace(/[\u2600-\u27BF\u2B50\u2702-\u27B0\uFE00-\uFE0F\u200D]/g, '');
        text = text.replace(/[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2B00-\u2BFF]/g, '');
        text = text.replace(/\s*\u2661\s*/g, ' ');
        text = text.replace(/\s{2,}/g, ' ');
        text = text.trim().replace(/^["'\(\)\[\]\{\}]+|["'\(\)\[\]\{\}]+$/g, '');
        return text;
    }

    function parseTraffic(raw) {
        return TRAFFIC_MAP[(raw || '').trim()] || 1;
    }

    // ─── RSS XML Parser ─────────────────────────────────────────────────
    function parseRSS(xmlText) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        return doc;
    }

    function parseGoogleTrendingRSS(xmlText, geo, days) {
        const doc = parseRSS(xmlText);
        const items = [];
        const itemEls = doc.querySelectorAll('item');
        const now = Date.now();
        const cutoff = days * 86400000;

        itemEls.forEach((item) => {
            const titleEl = item.querySelector('title');
            const trafficEl = item.getElementsByTagNameNS('https://trends.google.com/trending/rss', 'approx_traffic');
            const pubEl = item.querySelector('pubDate');

            if (!titleEl || !titleEl.textContent) return;

            if (days > 1 && pubEl && pubEl.textContent) {
                const pubDate = new Date(pubEl.textContent);
                if (!isNaN(pubDate.getTime()) && (now - pubDate.getTime()) > cutoff) return;
            }

            const query = cleanQuery(titleEl.textContent);
            if (!query || query.length < 2) return;

            const traffic = parseTraffic(trafficEl.length > 0 ? trafficEl[0].textContent : '');
            items.push({ original: query, value: traffic, geo });
        });

        return items;
    }

    function parseGoogleNewsRSS(xmlText, geo) {
        const doc = parseRSS(xmlText);
        const items = [];
        doc.querySelectorAll('item').forEach((item) => {
            const titleEl = item.querySelector('title');
            const sourceEl = item.querySelector('source');
            if (!titleEl || !titleEl.textContent) return;
            const headline = cleanQuery(titleEl.textContent);
            if (!headline || headline.length < 4) return;
            const source = sourceEl ? (sourceEl.textContent || '').trim() : '';
            items.push({ original: headline, value: 3, geo, source });
        });
        return items;
    }

    function parseFallbackRSS(xmlText) {
        const doc = parseRSS(xmlText);
        const items = [];
        doc.querySelectorAll('item').forEach((item) => {
            const titleEl = item.querySelector('title');
            const sourceEl = item.querySelector('source');
            if (!titleEl || !titleEl.textContent) return;
            const headline = cleanQuery(titleEl.textContent);
            if (!headline || headline.length < 4) return;
            const source = sourceEl ? (sourceEl.textContent || '').trim() : '';
            items.push({ original: headline, value: 3, geo: 'RU', source });
        });
        return items;
    }

    // ─── Fetch with proxy (fallback chain) ──────────────────────────────
    async function fetchWithProxy(url) {
        let lastErr;
        for (const makeUrl of PROXIES) {
            try {
                const resp = await fetch(makeUrl(url), { signal: AbortSignal.timeout(8000) });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return await resp.text();
            } catch (e) {
                lastErr = e;
                continue;
            }
        }
        throw lastErr || new Error('All proxies failed');
    }

    // ─── Translation (Google Translate API — no CORS) ───────────────────
    async function translateBatch(texts) {
        if (!texts.length) return texts;
        const results = [...texts];
        const batches = [];
        let start = 0, len = 0, count = 0;

        for (let i = 0; i < texts.length; i++) {
            const chunk = texts[i].length + 1;
            if ((len + chunk > BATCH_MAX_CHARS || count >= BATCH_MAX_ITEMS) && i > start) {
                batches.push([start, i]);
                start = i;
                len = 0;
                count = 0;
            }
            len += chunk;
            count++;
        }
        if (start < texts.length) batches.push([start, texts.length]);

        for (const [s, e] of batches) {
            const joined = texts.slice(s, e).join(BATCH_SEP);
            try {
                const url = `${GTRANSLATE}?client=gtx&sl=auto&tl=ru&dt=t&q=${encodeURIComponent(joined)}`;
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const data = await resp.json();
                const translated = data[0].map(p => p[0]).join('');
                const parts = translated.split('\n');
                for (let j = 0; j < (e - s); j++) {
                    if (j < parts.length && parts[j].trim()) {
                        results[s + j] = parts[j].trim();
                    }
                }
            } catch (err) {
                console.warn('Translation batch failed:', err);
            }
        }
        return results;
    }

    async function translateBatchCached(texts) {
        const toTranslate = [];
        const indices = [];
        const results = [...texts];

        for (let i = 0; i < texts.length; i++) {
            if (!texts[i] || hasCyrillic(texts[i])) continue;
            if (translationCache[texts[i]]) {
                results[i] = translationCache[texts[i]];
            } else {
                toTranslate.push(texts[i]);
                indices.push(i);
            }
        }

        if (toTranslate.length) {
            const translated = await translateBatch(toTranslate);
            for (let j = 0; j < indices.length; j++) {
                if (translated[j] !== toTranslate[j]) {
                    translationCache[toTranslate[j]] = translated[j];
                }
                results[indices[j]] = translated[j];
            }
        }
        return results;
    }

    // ─── Fetching data ──────────────────────────────────────────────────
    async function fetchGeoTrending(geo, days) {
        try {
            const xml = await fetchWithProxy(RSS_URL.replace('{geo}', geo));
            return parseGoogleTrendingRSS(xml, geo, days);
        } catch {
            return [];
        }
    }

    async function fetchGeoNews(geo) {
        try {
            const xml = await fetchWithProxy(NEWS_RSS_URL.replace('{geo}', geo));
            return parseGoogleNewsRSS(xml, geo);
        } catch {
            return [];
        }
    }

    async function fetchFallbackFeeds(limit) {
        const seen = new Set();
        const allItems = [];
        const sourcesUsed = [];

        for (const [name, url] of FALLBACK_FEEDS) {
            try {
                const xml = await fetchWithProxy(url);
                const items = parseFallbackRSS(xml);
                if (items.length) sourcesUsed.push(name);
                for (const it of items) {
                    const key = it.original.toLowerCase();
                    if (!seen.has(key)) {
                        seen.add(key);
                        allItems.push(it);
                    }
                }
                if (allItems.length >= limit) break;
            } catch {
                continue;
            }
        }

        const sourceLabel = sourcesUsed.length ? sourcesUsed.join(' + ') : 'Fallback RSS';
        return { items: allItems.slice(0, limit), source: sourceLabel };
    }

    async function fetchTrendingQueries(days, translate) {
        const geoResults = await Promise.allSettled(
            TOP_20.map(g => fetchGeoTrending(g, days))
        );

        let totalTrending = 0;
        const geoItems = {};
        geoResults.forEach((r, i) => {
            const items = r.status === 'fulfilled' ? r.value : [];
            geoItems[TOP_20[i]] = items;
            totalTrending += items.length;
        });

        if (totalTrending === 0) {
            const fb = await fetchFallbackFeeds(500);
            if (fb.items.length) {
                if (translate) {
                    const originals = fb.items.map(i => i.original);
                    const translated = await translateBatchCached(originals);
                    fb.items.forEach((it, i) => { it.query = translated[i]; });
                } else {
                    fb.items.forEach(it => { it.query = it.original; });
                }
                return { topics: fb.items, source: fb.source, geoCounts: {} };
            }
        }

        const seen = new Set();
        const items = [];
        const geoCounts = {};

        for (const g of TOP_20) {
            for (const item of (geoItems[g] || [])) {
                if (seen.has(item.original.toLowerCase())) continue;
                seen.add(item.original.toLowerCase());
                geoCounts[g] = (geoCounts[g] || 0) + 1;
                items.push({ ...item, query: item.original });
                if (items.length >= 500) break;
            }
            if (items.length >= 500) break;
        }

        if (translate) {
            const originals = items.map(i => i.original);
            const translated = await translateBatchCached(originals);
            items.forEach((it, i) => { it.query = translated[i]; });
        }

        return { topics: items, source: null, geoCounts };
    }

    async function fetchTrendingNews(translate) {
        const geoResults = await Promise.allSettled(
            TOP_20.map(g => fetchGeoNews(g))
        );

        let totalNews = 0;
        const geoItems = {};
        geoResults.forEach((r, i) => {
            const items = r.status === 'fulfilled' ? r.value : [];
            geoItems[TOP_20[i]] = items;
            totalNews += items.length;
        });

        if (totalNews === 0) {
            const fb = await fetchFallbackFeeds(500);
            if (fb.items.length) {
                if (translate) {
                    const originals = fb.items.map(i => i.original);
                    const translated = await translateBatchCached(originals);
                    fb.items.forEach((it, i) => { it.query = translated[i]; });
                } else {
                    fb.items.forEach(it => { it.query = it.original; });
                }
                return { topics: fb.items, source: fb.source, geoCounts: {} };
            }
        }

        const seen = new Set();
        const items = [];
        const geoCounts = {};

        for (const g of TOP_20) {
            for (const item of (geoItems[g] || [])) {
                if (seen.has(item.original.toLowerCase())) continue;
                seen.add(item.original.toLowerCase());
                geoCounts[g] = (geoCounts[g] || 0) + 1;
                items.push({ ...item, query: item.original });
                if (items.length >= 500) break;
            }
            if (items.length >= 500) break;
        }

        if (translate) {
            const originals = items.map(i => i.original);
            const translated = await translateBatchCached(originals);
            items.forEach((it, i) => { it.query = translated[i]; });
        }

        return { topics: items, source: null, geoCounts };
    }

    // ─── Group into topics (simple frequency-based clustering) ──────────
    function buildTopics(items) {
        const wordBuckets = {};
        const topicList = [];
        const used = new Set();

        items.forEach((item, idx) => {
            if (used.has(idx)) return;
            const words = item.original.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            const related = [idx];
            used.add(idx);

            items.forEach((other, j) => {
                if (used.has(j)) return;
                const otherWords = other.original.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                const overlap = words.filter(w => otherWords.includes(w));
                if (overlap.length >= 1 && item.geo === other.geo) {
                    related.push(j);
                    used.add(j);
                }
            });

            if (related.length >= 2) {
                const clusterItems = related.map(i => items[i]);
                const totalWeight = clusterItems.reduce((s, i) => s + i.value, 0);
                topicList.push({
                    id: topicList.length,
                    items: clusterItems,
                    totalWeight,
                    geos: [...new Set(clusterItems.map(i => i.geo))],
                    representative: clusterItems.slice(0, 3).map(i => i.query || i.original),
                });
            }
        });

        topicList.sort((a, b) => b.totalWeight - a.totalWeight);
        return topicList;
    }

    // ─── UI: Show/Hide Loading ──────────────────────────────────────────
    function showLoading(msg) {
        loadingText.textContent = msg || 'Loading...';
        loadingOverlay.classList.remove('hidden');
    }

    function hideLoading() {
        loadingOverlay.classList.add('hidden');
    }

    // ─── UI: Render Topics List ─────────────────────────────────────────
    async function renderTopics() {
        topicList.innerHTML = '';

        if (!allTopics.length) {
            emptyState.classList.remove('hidden');
            return;
        }
        emptyState.classList.add('hidden');

        const doTranslate = translateCheck.checked;
        let displayTopics = [...allTopics];

        if (doTranslate) {
            const allOriginals = displayTopics.flatMap(t =>
                t.items.slice(0, 3).map(i => i.original)
            );
            const translated = await translateBatchCached(allOriginals);
            let offset = 0;
            displayTopics.forEach(t => {
                const count = Math.min(t.items.length, 3);
                t._displayRep = translated.slice(offset, offset + count);
                offset += count;
            });
        } else {
            displayTopics.forEach(t => {
                t._displayRep = t.items.slice(0, 3).map(i => i.query || i.original);
            });
        }

        displayTopics.forEach((topic, idx) => {
            const div = document.createElement('div');
            div.className = 'topic-row px-4 py-3 cursor-pointer active:bg-dark-700 transition-colors';

            const repText = (topic._displayRep || []).join(' · ');
            const geoChips = topic.geos.slice(0, 4).map(g =>
                `<span class="chip bg-dark-700 text-slate-400">${g}</span>`
            ).join('');

            div.innerHTML = `
                <div class="flex items-start justify-between gap-2">
                    <div class="flex-1 min-w-0">
                        <div class="text-xs text-accent-light font-mono mb-1">#${idx + 1}</div>
                        <p class="text-sm text-slate-200 font-medium leading-snug line-clamp-2">${repText}</p>
                    </div>
                    <div class="flex flex-col items-end gap-1 shrink-0">
                        <span class="text-xs font-bold text-warn">${topic.totalWeight}</span>
                        <span class="text-[10px] text-slate-500">${topic.items.length} items</span>
                    </div>
                </div>
                <div class="flex gap-1 mt-1.5 flex-wrap">${geoChips}</div>
            `;

            div.onclick = () => selectTopic(idx);
            topicList.appendChild(div);
        });

        statsText.textContent = `${allTopics.length} topics · ${allTopics.reduce((s, t) => s + t.items.length, 0)} queries`;
    }

    // ─── UI: Render Topic Details ───────────────────────────────────────
    async function renderDetail(topicIdx) {
        if (topicIdx < 0 || topicIdx >= allTopics.length) {
            detailContent.innerHTML = `
                <div class="flex flex-col items-center justify-center py-20 text-slate-500">
                    <p class="text-sm">Select a topic from the list</p>
                </div>`;
            return;
        }

        const topic = allTopics[topicIdx];
        const doTranslate = translateCheck.checked;
        let displayItems = topic.items.map(i => i.query || i.original);

        if (doTranslate) {
            const originals = topic.items.map(i => i.original);
            displayItems = await translateBatchCached(originals);
        }

        const geoChips = topic.geos.map(g =>
            `<span class="chip bg-accent/15 text-accent-light">${g}</span>`
        ).join('');

        const itemsHtml = displayItems.map((item, i) => `
            <div class="py-2 px-3 rounded-lg bg-dark-700/50 mb-1.5">
                <span class="text-[10px] text-slate-500 font-mono mr-1.5">${i + 1}.</span>
                <span class="text-sm text-slate-200">${item}</span>
                ${topic.items[i].source ? `<span class="text-[10px] text-slate-500 ml-1">via ${topic.items[i].source}</span>` : ''}
            </div>
        `).join('');

        detailContent.innerHTML = `
            <div class="fade-in">
                <div class="flex items-center justify-between mb-3">
                    <h2 class="text-base font-bold text-accent-light">Topic #${topicIdx + 1}</h2>
                    <div class="flex items-center gap-2">
                        <span class="chip bg-warn/15 text-warn font-bold">Weight: ${topic.totalWeight}</span>
                        <span class="chip bg-dark-700 text-slate-400">${topic.items.length} items</span>
                    </div>
                </div>
                <div class="flex gap-1.5 mb-3 flex-wrap">${geoChips}</div>
                <p class="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wide">Queries in this cluster</p>
                <div>${itemsHtml}</div>
            </div>
        `;
    }

    // ─── UI: Select topic ───────────────────────────────────────────────
    function selectTopic(idx) {
        selectedTopicIdx = idx;
        renderDetail(idx);
        switchTab('details');
    }

    // ─── UI: Tab switching ──────────────────────────────────────────────
    window.switchTab = function (tab) {
        currentTab = tab;
        const tabTable = $('#tabTable');
        const tabDetails = $('#tabDetails');
        const btnTable = $('#tabBtnTable');
        const btnDetails = $('#tabBtnDetails');

        if (tab === 'table') {
            tabTable.classList.remove('hidden');
            tabDetails.classList.add('hidden');
            btnTable.className = 'flex-1 flex flex-col items-center py-2 tab-active border-t-2 transition-all';
            btnDetails.className = 'flex-1 flex flex-col items-center py-2 tab-inactive border-t-2 transition-all';
        } else {
            tabTable.classList.add('hidden');
            tabDetails.classList.remove('hidden');
            btnTable.className = 'flex-1 flex flex-col items-center py-2 tab-inactive border-t-2 transition-all';
            btnDetails.className = 'flex-1 flex flex-col items-center py-2 tab-active border-t-2 transition-all';
        }
    };

    // ─── UI: Set data type ──────────────────────────────────────────────
    window.setDataType = function (type) {
        dataType = type;
        const btnQ = $('#btnQueries');
        const btnN = $('#btnNews');
        if (type === 'queries') {
            btnQ.className = 'px-3 py-1 text-xs font-semibold rounded-md bg-accent text-white transition-all';
            btnN.className = 'px-3 py-1 text-xs font-semibold rounded-md text-slate-400 transition-all';
        } else {
            btnN.className = 'px-3 py-1 text-xs font-semibold rounded-md bg-accent text-white transition-all';
            btnQ.className = 'px-3 py-1 text-xs font-semibold rounded-md text-slate-400 transition-all';
        }
    };

    window.onPeriodChange = function () {};

    // ─── Main refresh ───────────────────────────────────────────────────
    window.refresh = async function () {
        refreshBtn.disabled = true;
        refreshBtn.classList.add('opacity-50');
        showLoading(dataType === 'queries' ? 'Fetching trending queries...' : 'Fetching trending news...');

        try {
            const translate = translateCheck.checked;
            Object.keys(translationCache).forEach(k => delete translationCache[k]);

            let result;
            if (dataType === 'queries') {
                const days = parseInt(periodSelect.value, 10);
                result = await fetchTrendingQueries(days, translate);
            } else {
                result = await fetchTrendingNews(translate);
            }

            if (result.topics.length === 0) {
                emptyState.classList.remove('hidden');
                emptyState.innerHTML = `
                    <svg class="w-12 h-12 mb-3 text-dark-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                    <p class="text-sm">No trends found</p>
                    <p class="text-xs text-slate-600 mt-1">Google Trends may be blocked. Try again later.</p>`;
                statsText.textContent = '0 topics';
                hideLoading();
                return;
            }

            if (result.source) {
                statusBadge.textContent = result.source;
                statusBadge.classList.remove('hidden');
            } else {
                statusBadge.classList.add('hidden');
            }

            const totalItems = result.topics.length;
            allTopics = buildTopics(result.topics);

            await renderTopics();
            selectedTopicIdx = -1;
            renderDetail(-1);

        } catch (err) {
            console.error('Refresh failed:', err);
            emptyState.innerHTML = `
                <svg class="w-12 h-12 mb-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                <p class="text-sm text-red-400">Error loading data</p>
                <p class="text-xs text-slate-600 mt-1">${err.message}</p>`;
        } finally {
            hideLoading();
            refreshBtn.disabled = false;
            refreshBtn.classList.remove('opacity-50');
        }
    };

    // ─── Re-render on translate toggle ──────────────────────────────────
    translateCheck.addEventListener('change', () => {
        if (allTopics.length) {
            renderTopics();
            if (selectedTopicIdx >= 0) renderDetail(selectedTopicIdx);
        }
    });

    // ─── PWA: Register service worker ──────────────────────────────────
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    }
})();
