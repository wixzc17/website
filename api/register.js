// Static 注册接口
// 注册账号存在 Cloudflare KV（区别于环境变量 STATIC_USERS 里的初始硬编码账号）
//
// POST /api/register  { id, hash, name?, invite }
//   id:      2-20 位字母数字
//   hash:    密码的 SHA-256（64 位十六进制，前端算好，明文密码永不上传）
//   name:    可选显示名（≤16 字符，默认 @id）
//   invite:  注册邀请码（服务端硬编码校验）
//
// KV 结构：
//   user:<id>       → { hash, name, ts }
//   users:registry  → [id, id, ...]（注册账号登记表，上限 100）

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ ok: false, message: '方法不允许' });
    }

    const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;
    const KV_HEADERS = {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}`,
        'Content-Type': 'application/json'
    };

    const MAX_USERS = 100;
    const INVITE_CODE = '200512'; // 注册邀请码（想加入请联系站长）

    try {
        const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
        const id = (body && body.id || '').toString().trim().replace(/^@/, '');
        const hash = (body && body.hash || '').toString().toLowerCase();
        const name = (body && body.name || '').toString().trim();
        const invite = (body && body.invite || '').toString().trim();

        if (invite !== INVITE_CODE) {
            return response.status(400).json({ ok: false, message: '邀请码不正确' });
        }
        if (!/^[a-zA-Z0-9]{2,20}$/.test(id)) {
            return response.status(400).json({ ok: false, message: 'ID 需为 2-20 位字母或数字' });
        }
        if (!/^[a-f0-9]{64}$/.test(hash)) {
            return response.status(400).json({ ok: false, message: '密码数据不合法' });
        }
        if (name.length > 16) {
            return response.status(400).json({ ok: false, message: '名字最多 16 个字符' });
        }

        // 与硬编码初始账号冲突
        let staticUsers = {};
        try { staticUsers = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
        if (staticUsers[id]) {
            return response.status(400).json({ ok: false, message: '这个 ID 已被使用' });
        }

        // 读注册表
        let registry = [];
        try {
            const res = await fetch(KV_URL + encodeURIComponent('users:registry'), { headers: KV_HEADERS });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) registry = data.filter(x => typeof x === 'string');
            }
        } catch (e) {
            return response.status(500).json({ ok: false, message: '存储暂时不可用' });
        }

        if (registry.includes(id)) {
            return response.status(400).json({ ok: false, message: '这个 ID 已被使用' });
        }
        if (registry.length >= MAX_USERS) {
            return response.status(400).json({ ok: false, message: '注册名额已满' });
        }

        // 写账号（写失败直接报错，避免出现「登记了但没账号」的半成品）
        const account = { hash: hash, name: name || ('@' + id), ts: Date.now() };
        const putRes = await fetch(KV_URL + encodeURIComponent('user:' + id), {
            method: 'PUT', headers: KV_HEADERS, body: JSON.stringify(account)
        });
        if (!putRes.ok) {
            return response.status(500).json({ ok: false, message: '注册失败，请稍后再试' });
        }

        registry.push(id);
        const regRes = await fetch(KV_URL + encodeURIComponent('users:registry'), {
            method: 'PUT', headers: KV_HEADERS, body: JSON.stringify(registry)
        });
        if (!regRes.ok) {
            // 回滚账号，保持一致性
            await fetch(KV_URL + encodeURIComponent('user:' + id), {
                method: 'DELETE', headers: { 'Authorization': KV_HEADERS.Authorization }
            }).catch(() => {});
            return response.status(500).json({ ok: false, message: '注册失败，请稍后再试' });
        }

        return response.status(200).json({ ok: true });
    } catch (e) {
        console.error('register handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
