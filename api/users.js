// Static 用户列表 / 搜索接口（token 鉴权）
// 「添加好友」的用户池：初始硬编码账号 + KV 注册账号
// 注意：码表联系人不从这里取，改由 /api/contacts 返回各自的通讯录
//
// GET /api/users?token=xxx           → { ok, ids: [id, ...] }（全量，向后兼容）
// GET /api/users?token=xxx&q=关键字  → { ok, users: [{id, name}, ...] }（模糊搜索）

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

    // 解析用户显示名：STATIC_USERS 优先，KV 注册账号兜底，默认 @id
    async function resolveName(id) {
        let users = {};
        try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
        if (users[id] && users[id].name) return users[id].name;
        try {
            const res = await fetch(KV_URL + encodeURIComponent('user:' + id), {
                headers: KV_HEADERS
            });
            if (res.ok) {
                const acct = await res.json();
                if (acct && typeof acct.name === 'string' && acct.name) return acct.name;
            }
        } catch (e) {}
        return '@' + id;
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

        const allIds = staticIds.concat(registry);

        // 搜索模式：按 ID / 昵称模糊匹配，返回 { id, name } 列表（供「添加好友」用户池用）
        // 去掉开头 @，让「@lixs17」也能命中 id「lixs17」（与登录/注册一致）
        const q = (url.searchParams.get('q') || '').toString().trim().toLowerCase().replace(/^@/, '');
        if (q) {
            const resolved = await Promise.all(allIds.map(async id => ({ id: id, name: await resolveName(id) })));
            const users = resolved.filter(u => u.id.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
            return response.status(200).json({ ok: true, users: users });
        }

        return response.status(200).json({ ok: true, ids: allIds });
    } catch (e) {
        console.error('users handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
