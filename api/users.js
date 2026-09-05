// Static 用户列表接口（token 鉴权）
// 码表联系人列表数据源：初始硬编码账号 + KV 注册账号
//
// GET /api/users?token=xxx  → { ok, ids: [id, ...] }

import crypto from 'crypto';

export default async function handler(request, response) {
    if (request.method !== 'GET') {
        return response.status(405).json({ ok: false, message: '方法不允许' });
    }

    // 验证会话 token（与 chat.js 相同的签名逻辑，兼容 KV 注册账号）
    const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;
    const KV_HEADERS = {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}`
    };

    async function findUserHash(id) {
        let users = {};
        try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
        if (users[id] && users[id].hash) return users[id].hash;
        try {
            const res = await fetch(KV_URL + encodeURIComponent('user:' + id), {
                headers: KV_HEADERS
            });
            if (res.ok) {
                const acct = await res.json();
                if (acct && typeof acct.hash === 'string') return acct.hash;
            }
        } catch (e) {}
        return null;
    }

    async function parseToken(token) {
        if (!token || typeof token !== 'string' || token.length > 512) return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [id, ts, sig] = parts;
        if (!/^[a-zA-Z0-9]+$/.test(id) || !/^\d+$/.test(ts) || !/^[a-f0-9]{16}$/.test(sig)) return null;
        const age = Date.now() - parseInt(ts, 10);
        if (age < 0 || age > 7 * 24 * 3600 * 1000) return null;

        const userHash = await findUserHash(id);
        if (!userHash) return null;

        const material = id + '.' + ts + '.' + userHash + '.static-salt';
        const expected = crypto.createHash('md5').update(material).digest('hex').slice(0, 16);
        if (sig !== expected) return null;

        return { id };
    }

    try {
        const url = new URL(request.url, 'https://x.local');
        const session = await parseToken(url.searchParams.get('token') || '');
        if (!session) {
            return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
        }

        // 初始硬编码账号
        let staticIds = [];
        try {
            const users = JSON.parse(process.env.STATIC_USERS || '{}');
            staticIds = Object.keys(users);
        } catch (e) {}

        // KV 注册账号
        let registry = [];
        try {
            const res = await fetch(KV_URL + encodeURIComponent('users:registry'), { headers: KV_HEADERS });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) registry = data.filter(x => typeof x === 'string');
            }
        } catch (e) {}

        return response.status(200).json({ ok: true, ids: staticIds.concat(registry) });
    } catch (e) {
        console.error('users handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
