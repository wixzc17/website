// Static 个人资料接口
// 用户名和头像存在 Cloudflare KV，所有登录用户可见（同步给对方）
//
// GET  /api/profile?id=xxx          读取某用户的资料（码表/聊天页展示用）
// POST /api/profile { token, name, avatar }   修改自己的资料（需登录）
//
// KV 结构：key = profile:用户ID，value = { "name": "...", "avatar": "data:image/..." }

import crypto from 'crypto';

const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;
const KV_HEADERS = {
    'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}`,
    'Content-Type': 'application/json'
};

// 验证会话 token（与 chat.js 相同的签名方案），返回 { id } 或 null
function parseToken(token) {
    if (!token || typeof token !== 'string' || token.length > 512) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [id, ts, sig] = parts;
    if (!/^[a-zA-Z0-9]+$/.test(id) || !/^\d+$/.test(ts) || !/^[a-f0-9]{16}$/.test(sig)) return null;
    const age = Date.now() - parseInt(ts, 10);
    if (age < 0 || age > 7 * 24 * 3600 * 1000) return null;

    let users = {};
    try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) { return null; }
    const user = users[id];
    if (!user || !user.hash) return null;

    const material = id + '.' + ts + '.' + user.hash + '.static-salt';
    const expected = crypto.createHash('md5').update(material).digest('hex').slice(0, 16);
    if (sig !== expected) return null;
    return { id };
}

// 读取 KV 中的资料
async function readProfile(id) {
    try {
        const res = await fetch(KV_URL + encodeURIComponent('profile:' + id), { headers: KV_HEADERS });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('KV read failed: ' + res.status);
        const data = JSON.parse(await res.text());
        return typeof data === 'object' && data !== null ? data : null;
    } catch (e) {
        console.error(e.message);
        return undefined; // undefined = 存储故障，区别于「无资料」的 null
    }
}

async function writeProfile(id, profile) {
    const res = await fetch(KV_URL + encodeURIComponent('profile:' + id), {
        method: 'PUT',
        headers: KV_HEADERS,
        body: JSON.stringify(profile)
    });
    if (!res.ok) throw new Error('KV write failed: ' + res.status);
}

export default async function handler(request, response) {
    try {
        if (request.method === 'GET') {
            const url = new URL(request.url, 'https://x.local');
            const id = (url.searchParams.get('id') || '').toString().trim().replace(/^@/, '');
            if (!/^[a-zA-Z0-9]+$/.test(id)) {
                return response.status(400).json({ ok: false, message: 'ID 不合法' });
            }

            // 确认是注册用户（不向外人泄露任意 KV key 探测能力）
            let users = {};
            try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
            if (!users[id]) {
                return response.status(404).json({ ok: false, message: '用户不存在' });
            }

            const profile = await readProfile(id);
            if (profile === undefined) {
                return response.status(500).json({ ok: false, message: '存储暂时不可用' });
            }

            // KV 没有则回退到环境变量里的初始名字
            const name = (profile && profile.name) || users[id].name || ('@' + id);
            const avatar = (profile && profile.avatar) || null;
            return response.status(200).json({ ok: true, name: name, avatar: avatar });
        }

        if (request.method === 'POST') {
            const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
            const session = parseToken(body && body.token);
            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }

            // 校验用户名：1-16 个字符
            const name = (body && body.name || '').toString().trim();
            if (!name || name.length > 16) {
                return response.status(400).json({ ok: false, message: '用户名需为 1-16 个字符' });
            }

            // 校验头像：null（清除）或 data:image/ 开头且不超过 100KB
            const avatar = body ? body.avatar : undefined;
            if (avatar !== null && avatar !== undefined) {
                if (typeof avatar !== 'string' || !avatar.startsWith('data:image/') || avatar.length > 102400) {
                    return response.status(400).json({ ok: false, message: '头像格式不正确或过大' });
                }
            }

            // 读取现有资料（保留未修改的字段）
            const existing = await readProfile(session.id);
            if (existing === undefined) {
                return response.status(500).json({ ok: false, message: '存储暂时不可用' });
            }

            const profile = existing || {};
            profile.name = name;
            if (avatar !== undefined) profile.avatar = avatar; // null = 清除头像，undefined = 不动

            await writeProfile(session.id, profile);
            return response.status(200).json({ ok: true, name: profile.name, avatar: profile.avatar || null });
        }

        return response.status(405).json({ ok: false, message: '方法不允许' });
    } catch (e) {
        console.error('profile handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
