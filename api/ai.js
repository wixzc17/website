// Static AI 对话接口（智谱 GLM-4.7-Flash，永久免费模型）
//
// POST /api/ai  { token, messages }     登录用户通道（无对话轮数限制）
// POST /api/ai  { anonymous: true, messages }  匿名通道（首页访客用）
//   匿名频控：按 IP + 1 小时时间窗，最多 3 轮（KV 计数）
//   messages: [{ role: 'user'|'assistant'|'system', content: '...' }]
//   返回 { ok: true, reply: '...' }
//
// API Key 只存服务端环境变量，前端永远接触不到

import crypto from 'crypto';

// 登录用户的 prism 设定（服务端写死，前端无法覆盖）
const BASE_SYSTEM_PROMPT = [
    '你是 prism（棱镜），Static 的内置 AI 助手。',
    'Static 是一个极简风格的加密通讯网站（wangwang-momo.cn），黑白配色，',
    '由汪子雯（@wixzc17）和任继锋（@lixs17）两人创建，具备加密私聊、推文广场等功能。',
    '你的任务包括：日常对话、分析推文广场的内容、分析聊天上下文等。',
    '回复风格：简洁、自然、中文为主。不确定的事就说不确定，不要编造。'
].join('\n');

// 匿名访客的棱镜设定（首页迎宾模式）
const ANON_SYSTEM_PROMPT = [
    '你是棱镜（Prism），由矩阵工作室（Matrix Studio）定义并部署的模型交流界面。',
    '矩阵工作室是由大学生任继锋与汪子雯两人组成的独立个人工作室。',
    '',
    '你当前处在网站 wangwang-momo.cn 的首页（模块选择页）。这个页面分为上下两半：',
    '- index：致力于无广告与快速检索的搜索引擎（目前形态为搜索窗口）。',
    '- Static：测试期中的加密通讯软件，支持双向与多向交流，以及广域网范围内的推文发送。',
    '',
    '当前是登录前的匿名对话界面，规则：每位访客最多进行 3 轮对话，',
    '且匿名请求处于低优先级，回复可能较慢或偶有繁忙。',
    '回复风格：简洁、自然、礼貌、中文。主动帮助访客了解这两个模块，给出使用建议。',
    '不确定的事就说不确定，不要编造。超出介绍网站范围的问题可以简短回答，',
    '并提醒访客你在这里主要提供导览服务。'
].join('\n');

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ ok: false, message: '方法不允许' });
    }

    const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;
    const KV_HEADERS = {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}`,
        'Content-Type': 'application/json'
    };

    // ---------- 验证会话 token（与 chat.js 相同的签名逻辑，兼容 KV 注册账号） ----------
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

    // ---------- 匿名频控：IP + 1 小时窗口，最多 3 轮（KV 计数） ----------
    const ANON_MAX_TURNS = 3;
    const ANON_WINDOW_MS = 3600 * 1000;

    function clientIp(req) {
        // Vercel 会把真实 IP 放在 x-forwarded-for 第一位
        const fwd = req.headers && req.headers['x-forwarded-for'];
        if (typeof fwd === 'string' && fwd.split(',').length > 0) {
            return fwd.split(',')[0].trim();
        }
        return (req.headers && req.headers['x-real-ip']) || 'unknown';
    }

    async function readAnonQuota(ip) {
        const key = 'aiquota:' + ip;
        try {
            const res = await fetch(KV_URL + encodeURIComponent(key), { headers: KV_HEADERS });
            if (res.ok) {
                const data = await res.json();
                if (data && typeof data.n === 'number' && typeof data.since === 'number') {
                    // 窗口过期 → 配额重置
                    if (Date.now() - data.since > ANON_WINDOW_MS) return { n: 0, since: Date.now(), key: key };
                    return { n: data.n, since: data.since, key: key };
                }
            }
        } catch (e) {}
        return { n: 0, since: Date.now(), key: key };
    }

    async function bumpAnonQuota(quota) {
        try {
            await fetch(KV_URL + encodeURIComponent(quota.key), {
                method: 'PUT', headers: KV_HEADERS,
                body: JSON.stringify({ n: quota.n + 1, since: quota.since })
            });
        } catch (e) {}
    }

    try {
        const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;

        // 匿名通道（无 token，走频控）；登录通道（token 鉴权）
        let session = null;
        let isAnon = false;

        if (body && body.anonymous === true && !body.token) {
            isAnon = true;
        } else {
            session = await parseToken(body && body.token);
            if (!session) {
                return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
            }
        }

        if (!process.env.ZHIPU_API_KEY) {
            return response.status(500).json({ ok: false, message: 'AI 服务未配置' });
        }
        const apiKey = process.env.ZHIPU_API_KEY.trim();

        // 校验消息数组格式，限制长度防滥用
        const msgs = body && body.messages;
        const maxMsgs = isAnon ? 8 : 40;   // 匿名最多 3 轮的上下文（3 问 + 3 答 + 开场）
        if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > maxMsgs) {
            return response.status(400).json({ ok: false, message: '对话内容不合法' });
        }
        const clean = [];
        for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            const role = m.role === 'user' || m.role === 'assistant' || m.role === 'system' ? m.role : null;
            const content = typeof m.content === 'string' ? m.content.slice(0, 4000) : null;
            if (role && content && content.trim()) {
                clean.push({ role, content });
            }
        }
        if (clean.length === 0) {
            return response.status(400).json({ ok: false, message: '对话内容不合法' });
        }

        // 匿名频控检查（放在消息校验之后、调用模型之前）
        let quota = null;
        if (isAnon) {
            quota = await readAnonQuota(clientIp(request));
            if (quota.n >= ANON_MAX_TURNS) {
                return response.status(200).json({
                    ok: false,
                    quotaExceeded: true,
                    message: '匿名对话已达 3 轮上限。登录 Static 后可继续与棱镜交流。'
                });
            }
        }

        // 基础设定永远排最前（登录/匿名两套不同身份）
        clean.unshift({ role: 'system', content: isAnon ? ANON_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT });

        // ---------- 调用智谱 OpenAI 兼容接口 ----------
        const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'glm-4.7-flash',
                messages: clean,
                temperature: 0.7,
                max_tokens: isAnon ? 512 : 2048,   // 匿名导览不需要长回复
                thinking: { type: 'disabled' }
            })
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error('zhipu api error:', res.status, errText.slice(0, 500));
            if (res.status === 429) {
                return response.status(200).json({ ok: false, message: 'AI 正忙，请稍后再试' });
            }
            return response.status(502).json({ ok: false, message: 'AI 服务暂时不可用' });
        }

        const data = await res.json();
        const reply = data && data.choices && data.choices[0] &&
                      data.choices[0].message && data.choices[0].message.content;

        if (typeof reply !== 'string' || !reply.trim()) {
            return response.status(502).json({ ok: false, message: 'AI 没有返回内容' });
        }

        // 匿名对话成功才计数（失败重试不扣配额）
        if (isAnon && quota) {
            await bumpAnonQuota(quota);
        }

        return response.status(200).json({
            ok: true,
            reply: reply,
            turnsLeft: isAnon ? (ANON_MAX_TURNS - quota.n - 1) : undefined
        });
    } catch (e) {
        console.error('ai handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
