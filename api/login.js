// Static 登录验证函数
// 环境变量 STATIC_USERS 格式：
// { "用户ID": { "hash": "密码的SHA-256", "name": "显示用户名" }, ... }

import crypto from 'crypto';

const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;

// 判断用户是否已有身份密钥（v2 密钥体系）
// 没有的话前端会在登录后自动补一对，旧账号无需任何手动操作
async function hasIdentityKeys(id) {
    try {
        const res = await fetch(KV_URL + encodeURIComponent('keys:' + id), {
            headers: { 'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}` }
        });
        if (!res.ok) return false;
        const data = await res.json();
        return !!(data && typeof data.pub === 'string');
    } catch (e) {
        return false;
    }
}

export default async function handler(request, response) {
    // 只接受 POST
    if (request.method !== 'POST') {
        return response.status(405).json({ ok: false, message: '方法不允许' });
    }

    let body;
    try {
        body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    } catch (e) {
        return response.status(400).json({ ok: false, message: '请求格式错误' });
    }

    const id = (body && body.id || '').toString().trim().replace(/^@/, '');
    const hash = (body && body.hash || '').toString().toLowerCase();

    // 基本格式校验：ID 非空且只含字母数字；哈希是 64 位十六进制
    if (!/^[a-zA-Z0-9]+$/.test(id) || !/^[a-f0-9]{64}$/.test(hash)) {
        return response.status(400).json({ ok: false, message: 'ID 或密码不正确' });
    }

    // 读取环境变量
    const raw = process.env.STATIC_USERS;
    if (!raw) {
        console.error('STATIC_USERS 环境变量未配置');
        return response.status(500).json({ ok: false, message: '服务器尚未配置用户数据' });
    }

    let users;
    try {
        users = JSON.parse(raw);
    } catch (e) {
        console.error('STATIC_USERS 环境变量不是合法的 JSON');
        return response.status(500).json({ ok: false, message: '服务器尚未配置用户数据' });
    }

    const user = users[id];

    // 统一错误信息，不区分「ID 不存在」和「密码错误」
    if (!user || !user.hash || user.hash.toLowerCase() !== hash) {
        // 硬编码账号没命中 → 查 KV 注册账号（user:<id>）
        try {
            const kvUrl = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/` + encodeURIComponent('user:' + id);
            const kvRes = await fetch(kvUrl, {
                headers: { 'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}` }
            });
            if (kvRes.ok) {
                const acct = await kvRes.json();
                if (acct && typeof acct.hash === 'string' && acct.hash.toLowerCase() === hash) {
                    // KV 账号命中：签发 token 继续走下面的正常流程
                    const token = issueToken(id, hash);
                    return response.status(200).json({
                        ok: true,
                        name: acct.name || ('@' + id),
                        token: token,
                        hasKeys: await hasIdentityKeys(id)
                    });
                }
            }
        } catch (e) { /* KV 异常按登录失败处理 */ }
        return response.status(200).json({ ok: false, message: 'ID 或密码不正确' });
    }

    // 签发会话 token（有效期 7 天），用于后续接口的身份验证
    const token = issueToken(id, hash);

    // 登录成功
    return response.status(200).json({
        ok: true,
        name: user.name || ('@' + id),
        token: token,
        hasKeys: await hasIdentityKeys(id)
    });
}

// 生成会话 token：ID.时间戳.签名（签名用登录哈希加盐，够用且无外部依赖）
function issueToken(id, hash) {
    const ts = Date.now();
    const material = id + '.' + ts + '.' + hash + '.static-salt';
    const sig = crypto.createHash('md5').update(material).digest('hex').slice(0, 16);
    return id + '.' + ts + '.' + sig;
}
