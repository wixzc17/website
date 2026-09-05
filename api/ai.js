// Static AI 对话接口（智谱 GLM-4.7-Flash，永久免费模型）
//
// POST /api/ai  { token, messages }
//   messages: [{ role: 'user'|'assistant'|'system', content: '...' }]
//   返回 { ok: true, reply: '...' }
//
// 鉴权沿用会话 token（同 chat.js），API Key 只存服务端环境变量，
// 前端永远接触不到 Key —— 外人也无法调用这个接口

import crypto from 'crypto';

// 模型的基础设定（服务端写死，前端无法覆盖）
// 每次请求自动插到对话最前面，模型由此知道自己是谁、在哪、该干什么
const BASE_SYSTEM_PROMPT = [
    '你是 prism，Static 的内置 AI 助手。',
    'Static 是一个极简风格的私人网站（wangwang-momo.cn），黑白配色，',
    '由汪子雯（@wixzc17）和任继锋（@lixs17）两人使用，具备加密私聊、推文广场等功能。',
    '你未来的任务包括：日常对话、分析推文广场的内容、分析聊天上下文等。',
    '回复风格：简洁、自然、中文为主。不确定的事就说不确定，不要编造。'
].join('\n');

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        return response.status(405).json({ ok: false, message: '方法不允许' });
    }

    // ---------- 验证会话 token（与 chat.js 相同的签名逻辑，兼容 KV 注册账号） ----------
    const KV_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CLOUDFLARE_KV_NAMESPACE_ID}/values/`;

    async function findUserHash(id) {
        let users = {};
        try { users = JSON.parse(process.env.STATIC_USERS || '{}'); } catch (e) {}
        if (users[id] && users[id].hash) return users[id].hash;
        try {
            const res = await fetch(KV_URL + encodeURIComponent('user:' + id), {
                headers: { 'Authorization': `Bearer ${process.env.CLOUDFLARE_KV_TOKEN}` }
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
        const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
        const session = await parseToken(body && body.token);
        if (!session) {
            return response.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
        }

        if (!process.env.ZHIPU_API_KEY) {
            return response.status(500).json({ ok: false, message: 'AI 服务未配置' });
        }
        // 防御：粘贴时可能带入空白字符，统一去掉
        const apiKey = process.env.ZHIPU_API_KEY.trim();

        // 校验消息数组格式，限制长度防滥用
        const msgs = body && body.messages;
        if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > 40) {
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

        // 基础设定永远排最前；前端传来的 system 消息作为场景补充跟在后面
        clean.unshift({ role: 'system', content: BASE_SYSTEM_PROMPT });

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
                max_tokens: 2048,
                thinking: { type: 'disabled' }  // 关闭思考模式，避免回复被推理内容占满
            })
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error('zhipu api error:', res.status, errText.slice(0, 500));
            // 429 = 上游模型繁忙，提示用户稍后重试；其他错误笼统提示
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

        return response.status(200).json({ ok: true, reply });
    } catch (e) {
        console.error('ai handler error:', e.message);
        return response.status(500).json({ ok: false, message: '服务器内部错误' });
    }
}
