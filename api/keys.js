// Static 密钥接口（v2 密钥体系）
//
// 身份密钥：
//   GET  /api/keys?token=xxx&mine=1     读取自己的公钥 + 加密私钥包
//   GET  /api/keys?token=xxx&id=yyy     读取某人的公钥（用于封装会话密钥）
//   POST /api/keys { token, pub, privEnc, rotate? }   上传或更新自己的密钥
//
// 会话密钥：
//   GET  /api/keys?token=xxx&conv=yyy   读取我和某人会话里「属于我」的那份封装
//   POST /api/keys { token, peer, wrapped }   建立会话密钥（已存在则只补缺失成员）
//
// KV 结构：
//   keys:<id>            → { pub, privEnc: { iv, ct }, v: 1, ts }
//   convkey:dm:<a_b>     → { v: 1, ts, wrapped: { 成员ID: { ephPub, iv, ct } } }
//
// 服务器全程只见公钥和密文，拿不到任何一方的私钥，也拿不到会话密钥明文

import crypto from 'crypto';

export default async function handler(request, response) {
    if (request.method !== 'GET' && request.method !== 'POST') {
        return response.status(405).json({ ok: false, message: '方法不允许' });
    }

    const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;
    const KV_HEADERS = {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}`,
        'Content-Type': 'application/json'
    };

    // 读取用户密码哈希：STATIC_USERS 优先，KV 注册账号兜底
    async function findUserHash(id) {
        let users = {};
        try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
        if (users[id] && users[id].hash) return users[id].hash;
        try {
            const res = await fetch(KV_URL + encodeURIComponent('user:' + id), {
                headers: { 'Authorization': KV_HEADERS.Authorization }
            });
            if (res.ok) {
                const acct = await res.json();
                if (acct && typeof acct.hash === 'string') return acct.hash;
            }
        } catch (e) {}
        return null;
    }

    // 验证会话 token（与 chat.js 相同的签名逻辑）
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

    // 读 KV：undefined = 存储故障，null = 没有这个 key
    async function readRaw(key) {
        try {
            const res = await fetch(KV_URL + encodeURIComponent(key), {
                headers: { 'Authorization': KV_HEADERS.Authorization }
            });
            if (res.status === 404) return null;
            if (!res.ok) throw new Error('KV read failed: ' + res.status);
            const data = await res.json();
            return (data && typeof data === 'object') ? data : null;
        } catch (e) {
            console.error('keys read error:', e.message);
            return undefined;
        }
    }

    async function writeRaw(key, value) {
        const res = await fetch(KV_URL + encodeURIComponent(key), {
            method: 'PUT',
            headers: KV_HEADERS,
            body: JSON.stringify(value)
        });
        if (!res.ok) throw new Error('KV write failed: ' + res.status);
    }

    // 两人会话的 ID（排序保证双方算出的一样，与 chat.js 的 convoKey 一致）
    function convIdOf(a, b) {
        return 'dm:' + [a, b].sort().join('_');
    }

    // 校验一份封装数据 { ephPub, iv, ct }
    function validWrapped(w) {
        return w && typeof w === 'object' &&
            typeof w.ephPub === 'string' && w.ephPub.length > 0 && w.ephPub.length <= 2048 &&
            typeof w.iv === 'string' && w.iv.length > 0 && w.iv.length <= 64 &&
            typeof w.ct === 'string' && w.ct.length > 0 && w.ct.length <= 4096;
    }

    try {
        // ================= GET =================
        if (request.method === 'GET') {
            const url = new URL(request.url, 'https://x.local');
            const session = await parseToken(url.searchParams.get('token') || '');
            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }

            // ---- 会话密钥：只返回属于当前用户自己的那一份 ----
            const convPeer = (url.searchParams.get('conv') || '').toString().trim().replace(/^@/, '');
            if (convPeer) {
                if (!/^[a-zA-Z0-9]+$/.test(convPeer)) {
                    return response.status(400).json({ ok: false, message: 'ID 不合法' });
                }
                if (!(await findUserHash(convPeer))) {
                    return response.status(404).json({ ok: false, message: '用户不存在' });
                }
                const data = await readRaw('convkey:' + convIdOf(session.id, convPeer));
                if (data === undefined) {
                    return response.status(500).json({ ok: false, message: '存储暂时不可用' });
                }
                const mine = (data && data.wrapped && data.wrapped[session.id]) || null;
                return response.status(200).json({
                    ok: true,
                    convId: convIdOf(session.id, convPeer),
                    wrapped: mine ? { [session.id]: mine } : {}
                });
            }

            // ---- 身份密钥 ----
            const mine = url.searchParams.get('mine') === '1';
            const target = mine
                ? session.id
                : (url.searchParams.get('id') || '').toString().trim().replace(/^@/, '');

            if (!/^[a-zA-Z0-9]+$/.test(target)) {
                return response.status(400).json({ ok: false, message: 'ID 不合法' });
            }
            if (!mine) {
                // 只给真实用户发公钥，避免被当成任意 KV key 的探测口子
                if (!(await findUserHash(target))) {
                    return response.status(404).json({ ok: false, message: '用户不存在' });
                }
            }

            const keys = await readRaw('keys:' + target);
            if (keys === undefined) {
                return response.status(500).json({ ok: false, message: '存储暂时不可用' });
            }
            if (!keys || typeof keys.pub !== 'string') {
                return response.status(404).json({ ok: false, message: '该用户还没有密钥' });
            }

            return response.status(200).json({
                ok: true,
                pub: keys.pub,
                privEnc: mine ? (keys.privEnc || null) : undefined
            });
        }

        // ================= POST =================
        const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
        const session = await parseToken(body && body.token);
        if (!session) {
            return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
        }

        // ---- 会话密钥：建立 / 补齐成员 ----
        const convPeer = (body && body.peer || '').toString().trim().replace(/^@/, '');
        if (convPeer) {
            if (!/^[a-zA-Z0-9]+$/.test(convPeer) || convPeer === session.id) {
                return response.status(400).json({ ok: false, message: '会话参数不合法' });
            }
            if (!(await findUserHash(convPeer))) {
                return response.status(404).json({ ok: false, message: '用户不存在' });
            }

            const wrapped = body && body.wrapped;
            if (!wrapped || typeof wrapped !== 'object') {
                return response.status(400).json({ ok: false, message: '封装数据不合法' });
            }
            // 只允许写自己和对方两个成员，且每人一份合法封装
            const allowed = { [session.id]: true, [convPeer]: true };
            const entries = Object.keys(wrapped);
            if (entries.length === 0 || entries.length > 2) {
                return response.status(400).json({ ok: false, message: '成员数量不合法' });
            }
            for (const member of entries) {
                if (!allowed[member] || !validWrapped(wrapped[member])) {
                    return response.status(400).json({ ok: false, message: '封装数据不合法' });
                }
            }

            const convKeyName = 'convkey:' + convIdOf(session.id, convPeer);
            const existing = await readRaw(convKeyName);
            if (existing === undefined) {
                return response.status(500).json({ ok: false, message: '存储暂时不可用' });
            }

            let merged;
            if (!existing || !existing.wrapped) {
                merged = { v: 1, ts: Date.now(), wrapped: {} };
            } else {
                merged = { v: existing.v || 1, ts: existing.ts || Date.now(), wrapped: existing.wrapped };
            }

            // 合并规则：已有的成员份额绝不覆盖（会话密钥一旦定下就不变），
            // 只补此前缺失的成员 —— 这样双方同时创建也不会互相破坏
            let changed = false;
            for (const member of entries) {
                if (!merged.wrapped[member]) {
                    merged.wrapped[member] = {
                        ephPub: wrapped[member].ephPub,
                        iv: wrapped[member].iv,
                        ct: wrapped[member].ct
                    };
                    changed = true;
                }
            }
            if (!changed) {
                return response.status(200).json({ ok: true, unchanged: true });
            }

            await writeRaw(convKeyName, merged);
            return response.status(200).json({ ok: true });
        }

        // ---- 身份密钥：上传 / 更新 ----
        const pub = (body && body.pub || '').toString();
        const privEnc = body && body.privEnc;

        if (!pub || pub.length > 2048 || !/^[A-Za-z0-9+/=]+$/.test(pub)) {
            return response.status(400).json({ ok: false, message: '公钥格式不正确' });
        }
        if (!privEnc || typeof privEnc !== 'object' ||
            typeof privEnc.iv !== 'string' || typeof privEnc.ct !== 'string' ||
            privEnc.iv.length > 64 || privEnc.ct.length > 4096) {
            return response.status(400).json({ ok: false, message: '私钥包格式不正确' });
        }

        const existingKeys = await readRaw('keys:' + session.id);
        if (existingKeys === undefined) {
            return response.status(500).json({ ok: false, message: '存储暂时不可用' });
        }
        // 覆盖已有密钥会让旧会话变成永远解不开的死数据，必须显式声明 rotate
        if (existingKeys && body.rotate !== true) {
            return response.status(409).json({ ok: false, message: '密钥已存在，如需更换请显式声明 rotate' });
        }

        await writeRaw('keys:' + session.id, {
            pub: pub,
            privEnc: { iv: privEnc.iv, ct: privEnc.ct },
            v: 1,
            ts: Date.now()
        });
        return response.status(200).json({ ok: true });
    } catch (e) {
        console.error('keys handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
