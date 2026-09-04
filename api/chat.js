// Static 消息读写接口
// 消息以密文形式存储在 Cloudflare KV，服务器永远见不到明文
//
// POST /api/chat  { token, to, ciphertext }   发送消息
// GET  /api/chat?token=xxx&peer=xxx           拉取消息
//
// token 是登录后由 /api/login 签发的会话凭证

import crypto from 'crypto';

export default async function handler(request, response) {
    // CORS 不需要（同源），只接受 POST 和 GET
    if (request.method !== 'POST' && request.method !== 'GET') {
        return response.status(405).json({ ok: false, message: '方法不允许' });
    }

    const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;
    const KV_HEADERS = {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}`,
        'Content-Type': 'application/json'
    };

    // ---------- 工具函数 ----------

    // 验证会话 token，返回 { id } 或 null
    function parseToken(token) {
        if (!token || typeof token !== 'string' || token.length > 512) return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [id, ts, sig] = parts;
        // 格式校验
        if (!/^[a-zA-Z0-9]+$/.test(id) || !/^\d+$/.test(ts) || !/^[a-f0-9]{16}$/.test(sig)) return null;
        // 有效期 7 天
        const age = Date.now() - parseInt(ts, 10);
        if (age < 0 || age > 7 * 24 * 3600 * 1000) return null;

        // 验证签名：需要该用户的密码哈希参与计算
        let users = {};
        try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) { return null; }
        const user = users[id];
        if (!user || !user.hash) return null;

        const material = id + '.' + ts + '.' + user.hash + '.static-salt';
        const expected = crypto.createHash('md5').update(material).digest('hex').slice(0, 16);
        if (sig !== expected) return null;

        return { id };
    }

    // 两人会话的唯一 key（排序保证双方一致）
    function convoKey(a, b) {
        return 'dm:' + [a, b].sort().join('_');
    }

    // 读 KV 中的消息列表
    async function readMessages(key) {
        try {
            const res = await fetch(KV_URL + encodeURIComponent(key), { headers: KV_HEADERS });
            if (res.status === 404) return [];
            if (!res.ok) throw new Error('KV read failed: ' + res.status);
            const text = await res.text();
            const data = JSON.parse(text);
            return Array.isArray(data) ? data : [];
        } catch (e) {
            console.error(e.message);
            return null;
        }
    }

    // 写 KV 中的消息列表
    async function writeMessages(key, messages) {
        const res = await fetch(KV_URL + encodeURIComponent(key), {
            method: 'PUT',
            headers: KV_HEADERS,
            body: JSON.stringify(messages)
        });
        if (!res.ok) throw new Error('KV write failed: ' + res.status);
    }

    // 校验消息条目格式
    function validEntry(entry) {
        return entry &&
            typeof entry === 'object' &&
            typeof entry.from === 'string' &&
            typeof entry.ct === 'string' &&
            typeof entry.ts === 'number' &&
            entry.ct.length <= 8192;
    }

    // ---------- 请求处理 ----------

    try {
        if (request.method === 'POST') {
            const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            const session = parseToken(body && body.token);
            const to = (body && body.to || '').toString().trim().replace(/^@/, '');
            const ciphertext = (body && body.ciphertext || '').toString();

            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }
            if (!/^[a-zA-Z0-9]+$/.test(to)) {
                return response.status(400).json({ ok: false, message: '目标 ID 不合法' });
            }
            if (to === session.id) {
                return response.status(400).json({ ok: false, message: '不能给自己发消息' });
            }
            if (!ciphertext || ciphertext.length > 8192) {
                return response.status(400).json({ ok: false, message: '消息内容不合法' });
            }

            // 确认目标用户存在（读 STATIC_USERS）
            let users = {};
            try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
            if (!users[to]) {
                return response.status(400).json({ ok: false, message: '目标用户不存在' });
            }

            const key = convoKey(session.id, to);
            const messages = await readMessages(key);
            if (messages === null) {
                return response.status(500).json({ ok: false, message: '存储暂时不可用' });
            }

            // 每个会话最多保留 500 条，防止无限增长
            const entry = { from: session.id, ct: ciphertext, ts: Date.now() };
            messages.push(entry);
            const trimmed = messages.slice(-500);

            await writeMessages(key, trimmed);
            return response.status(200).json({ ok: true });

        } else {
            // GET：拉取消息
            const url = new URL(request.url, 'https://x.local');
            const token = url.searchParams.get('token') || '';
            const peer = (url.searchParams.get('peer') || '').toString().trim().replace(/^@/, '');

            const session = parseToken(token);
            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }
            if (!/^[a-zA-Z0-9]+$/.test(peer)) {
                return response.status(400).json({ ok: false, message: '目标 ID 不合法' });
            }

            const key = convoKey(session.id, peer);
            const messages = await readMessages(key);
            if (messages === null) {
                return response.status(500).json({ ok: false, message: '存储暂时不可用' });
            }

            // 只返回格式合法的条目
            const clean = messages.filter(validEntry);
            return response.status(200).json({ ok: true, messages: clean });
        }
    } catch (e) {
        console.error('chat handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
