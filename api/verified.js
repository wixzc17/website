// Static 账号认证接口 —— 可信身份标记（防冒充）
//
// 数据模型（Cloudflare KV）：
//   verified:<id>  →  { ts }    被站长认证的账号（ts = 授予时间戳，毫秒）
//
// 接口：
//   GET  /api/verified?ids=a,b,c
//        公开查询（无需登录），返回 { ok, verified: { a: ts, ... } }
//        未认证的 id 不会出现在 verified 里
//   GET  /api/verified?id=a
//        单查一个，返回 { ok, id, verified: bool, ts }
//   POST /api/verified { token, targetId, action: 'grant' | 'revoke' }
//        仅站长（wixzc17 / lixs17）可操作
//        grant：目标账号必须真实存在（有密码哈希），写入 verified:<targetId>
//        revoke：删除 verified:<targetId>（不存在也没关系）

import crypto from 'crypto';

const ADMINS = ['wixzc17', 'lixs17'];

const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;
const KV_AUTH = { 'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}` };
const KV_HEADERS = {
    'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}`,
    'Content-Type': 'application/json'
};

export default async function handler(request, response) {
    // 读取用户密码哈希：STATIC_USERS 优先，KV 注册账号兜底
    async function findUserHash(id) {
        let users = {};
        try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
        if (users[id] && users[id].hash) return users[id].hash;
        try {
            const res = await fetch(KV_URL + encodeURIComponent('user:' + id), { headers: KV_AUTH });
            if (res.ok) {
                const acct = await res.json();
                if (acct && typeof acct.hash === 'string') return acct.hash;
            }
        } catch (e) {}
        return null;
    }

    // 验证会话 token（与 contacts.js / users.js 相同签名逻辑），返回 { id } 或 null
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

    // 读单条认证记录：返回 {ts, type} 或 null（type 缺省按 personal 兼容旧数据）
    async function readVerified(id) {
        try {
            const res = await fetch(KV_URL + encodeURIComponent('verified:' + id), { headers: KV_AUTH });
            if (!res.ok) return null;
            const data = await res.json();
            if (!data || typeof data.ts !== 'number') return null;
            return { ts: data.ts, type: data.type === 'business' ? 'business' : 'personal' };
        } catch (e) {
            return null;
        }
    }

    try {
        // ================= GET：公开查询 =================
        if (request.method === 'GET') {
            const url = new URL(request.url, 'https://x.local');

            // 单查模式：?id=a
            const single = (url.searchParams.get('id') || '').toString().trim().replace(/^@/, '');
            if (single) {
                if (!/^[a-zA-Z0-9]+$/.test(single)) {
                    return response.status(400).json({ ok: false, message: '参数不合法' });
                }
                const rec = await readVerified(single);
                return response.status(200).json({ ok: true, id: single, verified: rec !== null, ts: rec ? rec.ts : null, type: rec ? rec.type : null });
            }

            // 批量模式：?ids=a,b,c（最多 50 个）
            const rawIds = (url.searchParams.get('ids') || '').toString().split(',');
            const ids = rawIds
                .map(x => x.trim().replace(/^@/, ''))
                .filter(x => /^[a-zA-Z0-9]+$/.test(x))
                .slice(0, 50);
            if (!ids.length) {
                return response.status(400).json({ ok: false, message: '参数不合法' });
            }
            const tsList = await Promise.all(ids.map(id => readVerified(id)));
            const verified = {};
            ids.forEach((id, i) => {
                if (tsList[i] !== null) verified[id] = tsList[i];
            });
            return response.status(200).json({ ok: true, verified: verified });
        }

        // ================= POST：授予 / 撤销（仅站长） =================
        if (request.method !== 'POST') {
            return response.status(405).json({ ok: false, message: '方法不允许' });
        }

        const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
        const session = await parseToken(body && body.token);
        if (!session) {
            return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
        }
        if (ADMINS.indexOf(session.id) === -1) {
            return response.status(403).json({ ok: false, message: '没有权限' });
        }

        const targetId = (body && body.targetId || '').toString().trim().replace(/^@/, '');
        if (!/^[a-zA-Z0-9]+$/.test(targetId)) {
            return response.status(400).json({ ok: false, message: '参数不合法' });
        }

        const action = (body && body.action || '').toString().trim().toLowerCase();

        // ---- 授予认证 ----
        if (action === 'grant') {
            // 目标账号必须真实存在，防止给不存在的 ID 发认证
            if (!(await findUserHash(targetId))) {
                return response.status(404).json({ ok: false, message: '用户不存在' });
            }
            const grantType = (body && body.type === 'business') ? 'business' : 'personal';
            const res = await fetch(KV_URL + encodeURIComponent('verified:' + targetId), {
                method: 'PUT', headers: KV_HEADERS, body: JSON.stringify({ ts: Date.now(), type: grantType })
            });
            if (!res.ok) throw new Error('KV write failed: ' + res.status);
            return response.status(200).json({ ok: true, targetId: targetId, action: 'grant', type: grantType });
        }

        // ---- 撤销认证 ----
        if (action === 'revoke') {
            await fetch(KV_URL + encodeURIComponent('verified:' + targetId), {
                method: 'DELETE', headers: KV_AUTH
            });
            return response.status(200).json({ ok: true, targetId: targetId, action: 'revoke' });
        }

        return response.status(400).json({ ok: false, message: '未知操作' });
    } catch (e) {
        console.error('verified handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
