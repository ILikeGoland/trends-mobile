(function () {
    'use strict';

    // ─── Constants ───────────────────────────────────────────────────────
    let WORKER_URL = localStorage.getItem('worker_url') || '';
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
    const TRAFFIC_MAP = { '<1K': 1, '1K+': 2, '5K+': 3, '10K+': 4, '25K+': 5, '50K+': 6, '100K+': 7 };
    const TOP_20 = ['US','CN','JP','DE','IN','GB','FR','IT','CA','BR','RU','KR','AU','ES','MX','ID','NL','SA','TR','PL'];
    const RUSSIAN_HOSTS = ['newssearch.yandex.ru', 'dzen.ru', 'news.mail.ru'];

    // ─── State ───────────────────────────────────────────────────────────
    let dataType = 'queries';
    let allTopics = [];
    let selectedTopicIdx = -1;
    const translationCache = {};

    // ─── DOM ─────────────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const topicList = $('topicList');
    const emptyState = $('emptyState');
    const detailContent = $('detailContent');
    const loadingOverlay = $('loadingOverlay');
    const loadingText = $('loadingText');
    const statsText = $('statsText');
    const refreshBtn = $('refreshBtn');
    const translateCheck = $('translateCheck');
    const periodSelect = $('periodSelect');
    const statusBadge = $('statusBadge');
    const settingsModal = $('settingsModal');
    const workerUrlInput = $('workerUrlInput');

    // ─── Helpers ─────────────────────────────────────────────────────────
    function hasCyrillic(t) { for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c >= 0x400 && c <= 0x4ff) return true; } return false; }

    function cleanQuery(text) {
        text = decodeURIComponent(text);
        text = text.replace(/[\u2600-\u27BF\u2B50\u2702-\u27B0\uFE00-\uFE0F\u200D]/g, '');
        text = text.replace(/[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2B00-\u2BFF]/g, '');
        text = text.replace(/\s*\u2661\s*/g, ' ').replace(/\s{2,}/g, ' ');
        return text.trim().replace(/^["'\(\)\[\]\{\}]+|["'\(\)\[\]\{\}]+$/g, '');
    }

    function parseTraffic(raw) { return TRAFFIC_MAP[(raw || '').trim()] || 1; }
    function parseRSS(xmlText) { return new DOMParser().parseFromString(xmlText, 'text/xml'); }

    function parseGoogleTrendingRSS(xmlText, geo, days) {
        const doc = parseRSS(xmlText);
        const items = [];
        const now = Date.now();
        const cutoff = days * 86400000;
        doc.querySelectorAll('item').forEach(item => {
            const titleEl = item.querySelector('title');
            const trafficEl = item.getElementsByTagNameNS('https://trends.google.com/trending/rss', 'approx_traffic');
            const pubEl = item.querySelector('pubDate');
            if (!titleEl || !titleEl.textContent) return;
            if (days > 1 && pubEl && pubEl.textContent) {
                const d = new Date(pubEl.textContent);
                if (!isNaN(d.getTime()) && (now - d.getTime()) > cutoff) return;
            }
            const q = cleanQuery(titleEl.textContent);
            if (!q || q.length < 2) return;
            items.push({ original: q, value: parseTraffic(trafficEl.length > 0 ? trafficEl[0].textContent : ''), geo });
        });
        return items;
    }

    function parseGoogleNewsRSS(xmlText, geo) {
        const doc = parseRSS(xmlText);
        const items = [];
        doc.querySelectorAll('item').forEach(item => {
            const t = item.querySelector('title');
            const s = item.querySelector('source');
            if (!t || !t.textContent) return;
            const h = cleanQuery(t.textContent);
            if (!h || h.length < 4) return;
            items.push({ original: h, value: 3, geo, source: s ? (s.textContent || '').trim() : '' });
        });
        return items;
    }

    function parseFallbackRSS(xmlText) {
        const doc = parseRSS(xmlText);
        const items = [];
        doc.querySelectorAll('item').forEach(item => {
            const t = item.querySelector('title');
            const s = item.querySelector('source');
            if (!t || !t.textContent) return;
            const h = cleanQuery(t.textContent);
            if (!h || h.length < 4) return;
            items.push({ original: h, value: 3, geo: 'RU', source: s ? (s.textContent || '').trim() : '' });
        });
        return items;
    }

    // ─── Fetch ───────────────────────────────────────────────────────────
    function isRussianFeed(url) { return RUSSIAN_HOSTS.some(h => url.includes(h)); }

    async function fetchViaWorker(url) {
        if (!WORKER_URL) throw new Error('Worker not configured');
        const sep = WORKER_URL.includes('?') ? '&' : '?';
        const fullUrl = WORKER_URL + sep + 'url=' + encodeURIComponent(url);
        console.log('[v7] fetchViaWorker:', fullUrl);
        const resp = await fetch(fullUrl, { signal: AbortSignal.timeout(10000) });
        console.log('[v7] worker response:', resp.status, url);
        if (!resp.ok) throw new Error('Worker HTTP ' + resp.status);
        return await resp.text();
    }

    async function fetchDirect(url) {
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.text();
    }

    async function fetchWithProxy(url) {
        if (isRussianFeed(url)) { try { return await fetchDirect(url); } catch (e) { /* fall through */ } }
        return fetchViaWorker(url);
    }

    // ─── Translation ─────────────────────────────────────────────────────
    async function translateBatch(texts) {
        if (!texts.length) return texts;
        const results = [...texts];
        const batches = [];
        let start = 0, len = 0, count = 0;
        for (let i = 0; i < texts.length; i++) {
            const chunk = texts[i].length + 1;
            if ((len + chunk > BATCH_MAX_CHARS || count >= BATCH_MAX_ITEMS) && i > start) {
                batches.push([start, i]); start = i; len = 0; count = 0;
            }
            len += chunk; count++;
        }
        if (start < texts.length) batches.push([start, texts.length]);
        for (const [s, e] of batches) {
            const joined = texts.slice(s, e).join(BATCH_SEP);
            const translateUrl = GTRANSLATE + '?client=gtx&sl=auto&tl=ru&dt=t&q=' + encodeURIComponent(joined);
            try {
                let data;
                if (WORKER_URL) {
                    const sep = WORKER_URL.includes('?') ? '&' : '?';
                    const resp = await fetch(WORKER_URL + sep + 'url=' + encodeURIComponent(translateUrl), { signal: AbortSignal.timeout(10000) });
                    if (!resp.ok) continue;
                    data = await resp.json();
                } else {
                    const resp = await fetch(translateUrl, { signal: AbortSignal.timeout(10000) });
                    if (!resp.ok) continue;
                    data = await resp.json();
                }
                if (!data || !data[0]) continue;
                const translated = data[0].map(function (p) { return p[0]; }).join('');
                const parts = translated.split('\n');
                for (let j = 0; j < (e - s); j++) {
                    if (j < parts.length && parts[j].trim()) results[s + j] = parts[j].trim();
                }
            } catch (err) { console.warn('[v7] Translation failed:', err); }
        }
        return results;
    }

    async function translateBatchCached(texts) {
        const toTranslate = [], indices = [], results = [...texts];
        for (let i = 0; i < texts.length; i++) {
            if (!texts[i] || hasCyrillic(texts[i])) continue;
            if (translationCache[texts[i]]) { results[i] = translationCache[texts[i]]; }
            else { toTranslate.push(texts[i]); indices.push(i); }
        }
        if (toTranslate.length) {
            const translated = await translateBatch(toTranslate);
            for (let j = 0; j < indices.length; j++) {
                if (translated[j] !== toTranslate[j]) translationCache[toTranslate[j]] = translated[j];
                results[indices[j]] = translated[j];
            }
        }
        return results;
    }

    // ─── Data fetching ──────────────────────────────────────────────────
    async function fetchGeoTrending(geo, days) {
        try { return parseGoogleTrendingRSS(await fetchViaWorker(RSS_URL.replace('{geo}', geo)), geo, days); }
        catch { return []; }
    }

    async function fetchGeoNews(geo) {
        try { return parseGoogleNewsRSS(await fetchViaWorker(NEWS_RSS_URL.replace('{geo}', geo)), geo); }
        catch { return []; }
    }

    async function fetchFallbackFeeds(limit) {
        const seen = new Set(), allItems = [], sourcesUsed = [];
        for (const [name, url] of FALLBACK_FEEDS) {
            try {
                const items = parseFallbackRSS(await fetchDirect(url));
                if (items.length) sourcesUsed.push(name);
                for (const it of items) { const k = it.original.toLowerCase(); if (!seen.has(k)) { seen.add(k); allItems.push(it); } }
                if (allItems.length >= limit) break;
            } catch { continue; }
        }
        return { items: allItems.slice(0, limit), source: sourcesUsed.length ? sourcesUsed.join(' + ') : 'Fallback RSS' };
    }

    async function fetchTrendingQueries(days, translate) {
        const geoResults = await Promise.allSettled(TOP_20.map(g => fetchGeoTrending(g, days)));
        const geoItems = {};
        let total = 0;
        geoResults.forEach((r, i) => { const items = r.status === 'fulfilled' ? r.value : []; geoItems[TOP_20[i]] = items; total += items.length; });

        if (total === 0) {
            const fb = await fetchFallbackFeeds(500);
            if (fb.items.length) {
                if (translate) { const o = fb.items.map(i => i.original); const t = await translateBatchCached(o); fb.items.forEach((it, i) => { it.query = t[i]; }); }
                else fb.items.forEach(it => { it.query = it.original; });
                return { topics: fb.items, source: fb.source, geoCounts: {} };
            }
        }

        const seen = new Set(), items = [], geoCounts = {};
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
        if (translate) { const o = items.map(i => i.original); const t = await translateBatchCached(o); items.forEach((it, i) => { it.query = t[i]; }); }
        return { topics: items, source: null, geoCounts };
    }

    async function fetchTrendingNews(translate) {
        const geoResults = await Promise.allSettled(TOP_20.map(g => fetchGeoNews(g)));
        const geoItems = {};
        let total = 0;
        geoResults.forEach((r, i) => { const items = r.status === 'fulfilled' ? r.value : []; geoItems[TOP_20[i]] = items; total += items.length; });

        if (total === 0) {
            const fb = await fetchFallbackFeeds(500);
            if (fb.items.length) {
                if (translate) { const o = fb.items.map(i => i.original); const t = await translateBatchCached(o); fb.items.forEach((it, i) => { it.query = t[i]; }); }
                else fb.items.forEach(it => { it.query = it.original; });
                return { topics: fb.items, source: fb.source, geoCounts: {} };
            }
        }

        const seen = new Set(), items = [], geoCounts = {};
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
        if (translate) { const o = items.map(i => i.original); const t = await translateBatchCached(o); items.forEach((it, i) => { it.query = t[i]; }); }
        return { topics: items, source: null, geoCounts };
    }

    // ─── Clustering ─────────────────────────────────────────────────────
    function buildTopics(items) {
        const topicList = [], used = new Set();
        items.forEach((item, idx) => {
            if (used.has(idx)) return;
            const words = item.original.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            const related = [idx]; used.add(idx);
            items.forEach((other, j) => {
                if (used.has(j)) return;
                const otherWords = other.original.toLowerCase().split(/\s+/).filter(w => w.length > 3);
                if (words.some(w => otherWords.includes(w)) && item.geo === other.geo) { related.push(j); used.add(j); }
            });
            if (related.length >= 2) {
                const ci = related.map(i => items[i]);
                topicList.push({ id: topicList.length, items: ci, totalWeight: ci.reduce((s, i) => s + i.value, 0), geos: [...new Set(ci.map(i => i.geo))], representative: ci.slice(0, 3).map(i => i.query || i.original) });
            }
        });
        topicList.sort((a, b) => b.totalWeight - a.totalWeight);
        return topicList;
    }

    // ─── Loading ────────────────────────────────────────────────────────
    function showLoading(msg) { loadingText.textContent = msg || 'Loading...'; loadingOverlay.classList.remove('hidden'); }
    function hideLoading() { loadingOverlay.classList.add('hidden'); }

    // ─── Render topics ──────────────────────────────────────────────────
    async function renderTopics() {
        topicList.innerHTML = '';
        if (!allTopics.length) { emptyState.classList.remove('hidden'); return; }
        emptyState.classList.add('hidden');

        const doTranslate = translateCheck.checked;
        const displayTopics = [...allTopics];

        if (doTranslate) {
            const allOriginals = displayTopics.flatMap(t => t.items.slice(0, 3).map(i => i.original));
            const translated = await translateBatchCached(allOriginals);
            let offset = 0;
            displayTopics.forEach(t => { const c = Math.min(t.items.length, 3); t._displayRep = translated.slice(offset, offset + c); offset += c; });
        } else {
            displayTopics.forEach(t => { t._displayRep = t.items.slice(0, 3).map(i => i.query || i.original); });
        }

        displayTopics.forEach((topic, idx) => {
            const div = document.createElement('div');
            div.style.cssText = 'padding:12px 16px;cursor:pointer;border-bottom:1px solid #334155;';
            div.innerHTML = '<div style="display:flex;align-items:start;justify-content:space-between;gap:8px;">'
                + '<div style="flex:1;min-width:0;">'
                + '<div style="font-size:12px;color:#60a5fa;font-family:monospace;margin-bottom:4px;">#' + (idx + 1) + '</div>'
                + '<p style="font-size:14px;color:#e2e8f0;font-weight:500;line-height:1.4;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + (topic._displayRep || []).join(' · ') + '</p>'
                + '</div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">'
                + '<span style="font-size:12px;font-weight:700;color:#f59e0b;">' + topic.totalWeight + '</span>'
                + '<span style="font-size:10px;color:#64748b;">' + topic.items.length + ' items</span>'
                + '</div></div>'
                + '<div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">'
                + topic.geos.slice(0, 4).map(g => '<span style="font-size:12px;background:#334155;color:#94a3b8;padding:2px 8px;border-radius:9999px;">' + g + '</span>').join('')
                + '</div>';
            div.addEventListener('click', function () { selectTopic(idx); });
            topicList.appendChild(div);
        });

        statsText.textContent = allTopics.length + ' topics · ' + allTopics.reduce((s, t) => s + t.items.length, 0) + ' queries';
    }

    // ─── Render detail ──────────────────────────────────────────────────
    async function renderDetail(topicIdx) {
        if (topicIdx < 0 || topicIdx >= allTopics.length) {
            detailContent.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px;color:#64748b;"><p style="font-size:14px;margin:0;">Select a topic from the list</p></div>';
            return;
        }
        const topic = allTopics[topicIdx];
        const doTranslate = translateCheck.checked;
        let displayItems = topic.items.map(i => i.query || i.original);
        if (doTranslate) { displayItems = await translateBatchCached(topic.items.map(i => i.original)); }

        const geoChips = topic.geos.map(g => '<span style="font-size:12px;background:rgba(59,130,246,0.15);color:#60a5fa;padding:2px 8px;border-radius:9999px;">' + g + '</span>').join('');
        const itemsHtml = displayItems.map((item, i) => '<div style="padding:8px 12px;background:rgba(51,65,85,0.5);border-radius:8px;margin-bottom:6px;">'
            + '<span style="font-size:10px;color:#64748b;font-family:monospace;margin-right:6px;">' + (i + 1) + '.</span>'
            + '<span style="font-size:14px;color:#e2e8f0;">' + item + '</span>'
            + (topic.items[i].source ? '<span style="font-size:10px;color:#64748b;margin-left:4px;">via ' + topic.items[i].source + '</span>' : '')
            + '</div>').join('');

        detailContent.innerHTML = '<div class="fade-in">'
            + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px;">'
            + '<h2 style="font-size:16px;font-weight:700;color:#60a5fa;margin:0;">Topic #' + (topicIdx + 1) + '</h2>'
            + '<div style="display:flex;gap:8px;">'
            + '<span style="font-size:12px;background:rgba(245,158,11,0.15);color:#f59e0b;padding:2px 8px;border-radius:9999px;font-weight:700;">Weight: ' + topic.totalWeight + '</span>'
            + '<span style="font-size:12px;background:#334155;color:#94a3b8;padding:2px 8px;border-radius:9999px;">' + topic.items.length + ' items</span>'
            + '</div></div>'
            + '<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">' + geoChips + '</div>'
            + '<p style="font-size:12px;color:#64748b;margin:0 0 8px 0;font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Queries in this cluster</p>'
            + '<div>' + itemsHtml + '</div></div>';
    }

    function selectTopic(idx) { selectedTopicIdx = idx; renderDetail(idx); switchTab('details'); }

    // ─── Tabs ───────────────────────────────────────────────────────────
    function switchTab(tab) {
        const tabTable = $('tabTable'), tabDetails = $('tabDetails');
        const btnTable = $('tabBtnTable'), btnDetails = $('tabBtnDetails');
        if (tab === 'table') {
            tabTable.classList.remove('hidden'); tabDetails.classList.add('hidden');
            btnTable.style.color = '#3b82f6'; btnTable.style.borderTopColor = '#3b82f6';
            btnDetails.style.color = '#94a3b8'; btnDetails.style.borderTopColor = 'transparent';
        } else {
            tabTable.classList.add('hidden'); tabDetails.classList.remove('hidden');
            btnTable.style.color = '#94a3b8'; btnTable.style.borderTopColor = 'transparent';
            btnDetails.style.color = '#3b82f6'; btnDetails.style.borderTopColor = '#3b82f6';
        }
    }

    // ─── Data type toggle ───────────────────────────────────────────────
    function setDataType(type) {
        dataType = type;
        const btnQ = $('btnQueries'), btnN = $('btnNews');
        if (type === 'queries') {
            btnQ.className = 'btn-blue'; btnQ.style.cssText = 'padding:4px 10px;font-size:12px;border-radius:6px;font-weight:600;';
            btnN.style.cssText = 'padding:4px 10px;font-size:12px;border-radius:6px;background:transparent;color:#94a3b8;border:none;cursor:pointer;font-weight:600;';
        } else {
            btnN.className = 'btn-blue'; btnN.style.cssText = 'padding:4px 10px;font-size:12px;border-radius:6px;font-weight:600;';
            btnQ.style.cssText = 'padding:4px 10px;font-size:12px;border-radius:6px;background:transparent;color:#94a3b8;border:none;cursor:pointer;font-weight:600;';
        }
    }

    // ─── Refresh ────────────────────────────────────────────────────────
    async function doRefresh() {
        console.log('[v7] doRefresh called, WORKER_URL=', WORKER_URL);
        if (!WORKER_URL) { openSettings(); return; }

        refreshBtn.disabled = true;
        refreshBtn.style.opacity = '0.5';
        showLoading(dataType === 'queries' ? 'Fetching trending queries...' : 'Fetching trending news...');

        try {
            const translate = translateCheck.checked;
            Object.keys(translationCache).forEach(k => delete translationCache[k]);

            let result;
            if (dataType === 'queries') {
                const days = parseInt(periodSelect.value, 10);
                result = await Promise.race([
                    fetchTrendingQueries(days, translate),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout: 30s')), 30000)),
                ]);
            } else {
                result = await Promise.race([
                    fetchTrendingNews(translate),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout: 30s')), 30000)),
                ]);
            }

            if (!result.topics.length) {
                emptyState.classList.remove('hidden');
                emptyState.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#334155" stroke-width="1.5" style="margin-bottom:12px;"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>'
                    + '<p style="font-size:14px;margin:0;">No trends found</p>'
                    + '<p style="font-size:12px;color:#475569;margin-top:4px;">Google Trends may be blocked. Try again later.</p>';
                statsText.textContent = '0 topics';
                return;
            }

            if (result.source) { statusBadge.textContent = result.source; statusBadge.classList.remove('hidden'); }
            else statusBadge.classList.add('hidden');

            allTopics = buildTopics(result.topics);
            await renderTopics();
            selectedTopicIdx = -1;
            renderDetail(-1);

        } catch (err) {
            console.error('Refresh failed:', err);
            emptyState.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5" style="margin-bottom:12px;"><path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>'
                + '<p style="font-size:14px;color:#f87171;margin:0;">Error loading data</p>'
                + '<p style="font-size:12px;color:#475569;margin-top:4px;">' + err.message + '</p>';
        } finally {
            hideLoading();
            refreshBtn.disabled = false;
            refreshBtn.style.opacity = '1';
        }
    }

    // ─── Settings ───────────────────────────────────────────────────────
    function openSettings() { console.log('[v7] openSettings, WORKER_URL=', WORKER_URL); workerUrlInput.value = WORKER_URL; settingsModal.classList.remove('hidden'); }
    function closeSettings() { console.log('[v7] closeSettings'); settingsModal.classList.add('hidden'); }
    function saveSettings() {
        const val = workerUrlInput.value.trim().replace(/\/+$/, '');
        console.log('[v7] saveSettings, val=', val);
        WORKER_URL = val;
        localStorage.setItem('worker_url', val);
        closeSettings();
    }

    // ─── Event bindings (after all functions are defined) ───────────────
    $('settingsBtn').addEventListener('click', openSettings);
    $('settingsCloseBtn').addEventListener('click', closeSettings);
    $('settingsSaveBtn').addEventListener('click', saveSettings);
    $('loadingCloseBtn').addEventListener('click', hideLoading);
    loadingOverlay.addEventListener('click', function (e) { if (e.target === loadingOverlay) hideLoading(); });
    settingsModal.addEventListener('click', function (e) { if (e.target === settingsModal) closeSettings(); });
    refreshBtn.addEventListener('click', doRefresh);
    $('btnQueries').addEventListener('click', function () { setDataType('queries'); });
    $('btnNews').addEventListener('click', function () { setDataType('news'); });
    $('tabBtnTable').addEventListener('click', function () { switchTab('table'); });
    $('tabBtnDetails').addEventListener('click', function () { switchTab('details'); });
    translateCheck.addEventListener('change', function () { if (allTopics.length) { renderTopics(); if (selectedTopicIdx >= 0) renderDetail(selectedTopicIdx); } });

    // ─── PWA ────────────────────────────────────────────────────────────
    // Отключаем старый SW, чтобы браузер не раздавал кэшированный мусор
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function (regs) {
            regs.forEach(function (r) { r.unregister(); });
        });
    }
    // Очищаем всё кэшированное
    if ('caches' in window) {
        caches.keys().then(function (names) { names.forEach(function (n) { caches.delete(n); }); });
    }
})();
