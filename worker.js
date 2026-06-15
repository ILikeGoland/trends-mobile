// Cloudflare Worker — CORS proxy for Google Trends RSS
// Deploy: https://dash.cloudflare.com → Workers & Pages → Create Worker
// Free tier: 100,000 requests/day

const ALLOWED_HOSTS = [
    'trends.google.com',
    'news.google.com',
    'newssearch.yandex.ru',
    'dzen.ru',
    'news.mail.ru',
];

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const target = url.searchParams.get('url');

        if (!target) {
            return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
                status: 400,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
        }

        let targetUrl;
        try {
            targetUrl = new URL(target);
        } catch {
            return new Response(JSON.stringify({ error: 'Invalid URL' }), {
                status: 400,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
        }

        if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
            return new Response(JSON.stringify({ error: `Host not allowed: ${targetUrl.hostname}` }), {
                status: 403,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
        }

        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const cached = await cache.match(cacheKey);
        if (cached) {
            const resp = new Response(cached.body, cached);
            resp.headers.set('X-Cache', 'HIT');
            return resp;
        }

        const upstream = await fetch(target, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml, */*',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
        });

        const resp = new Response(upstream.body, {
            status: upstream.status,
            headers: {
                ...CORS_HEADERS,
                'Content-Type': upstream.headers.get('Content-Type') || 'text/xml',
                'X-Cache': 'MISS',
            },
        });

        if (upstream.ok) {
            const ttl = targetUrl.hostname.includes('google.com') ? 300 : 120;
            const cacheable = new Response(resp.clone().body, {
                status: resp.status,
                headers: { ...Object.fromEntries(resp.headers), 'Cache-Control': `public, max-age=${ttl}` },
            });
            ctx.waitUntil(cache.put(cacheKey, cacheable));
        }

        return resp;
    },
};
