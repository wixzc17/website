// Static 密钥工具库（浏览器端）
//
// v2 密钥体系的公共实现，登录/注册/聊天等页面共用。
// 设计原则：
//   1. 密码只用来解锁自己的私钥，绝不参与会话密钥的派生
//   2. 私钥永不明文离开浏览器，上传的是被 KEK 加密后的密文包
//   3. 服务器（Vercel + Cloudflare KV）全程只见密文和公钥
//
// 算法：ECDH P-256 做密钥协商，HKDF-SHA256 做密钥派生，AES-GCM 做对称加密

const StaticKeys = {
    // ---------- 编码工具 ----------

    toB64(buffer) {
        const bytes = new Uint8Array(buffer);
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    },

    fromB64(str) {
        const bin = atob(str);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    },

    async sha256Hex(text) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    },

    // ---------- 密钥派生 ----------

    // HKDF-SHA256 → AES-GCM 密钥
    async hkdfKey(ikm, salt, info) {
        const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits', 'deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: salt, info: new TextEncoder().encode(info) },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    },

    // KEK：由密码哈希派生，只用于加密自己的私钥包
    // 注意：ikm 用的是前端持有的密码哈希（登录时算好存 sessionStorage 的那个）
    async deriveKek(passwordHash, id) {
        const ikm = new TextEncoder().encode(passwordHash);
        const salt = new TextEncoder().encode('static-kek-v1:' + id);
        return this.hkdfKey(ikm, salt, 'static-private-key');
    },

    // ---------- 身份密钥对 ----------

    // 生成 ECDH 身份密钥对，返回 { pubB64, privKey }
    async generateIdentity() {
        const pair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveBits']
        );
        const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
        return { pubB64: this.toB64(spki), privKey: pair.privateKey };
    },

    // 用 KEK 加密私钥，输出可上传的密文包 { iv, ct }
    async exportEncryptedPrivate(privKey, passwordHash, id) {
        const pkcs8 = await crypto.subtle.exportKey('pkcs8', privKey);
        const kek = await this.deriveKek(passwordHash, id);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, kek, pkcs8);
        return { iv: this.toB64(iv), ct: this.toB64(ct) };
    },

    // 用 KEK 解出私钥（解密失败返回 null，通常是密码不对）
    async importEncryptedPrivate(enc, passwordHash, id) {
        try {
            const kek = await this.deriveKek(passwordHash, id);
            const pkcs8 = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: this.fromB64(enc.iv) },
                kek,
                this.fromB64(enc.ct)
            );
            return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        } catch (e) {
            return null;
        }
    },

    // 公钥指纹：用于线下比对，防止服务器偷偷换公钥
    async fingerprint(pubB64) {
        const hex = await this.sha256Hex(pubB64);
        return hex.slice(0, 20).toUpperCase().replace(/(.{4})/g, '$1 ').trim();
    },

    // ---------- 会话密钥封装 ----------

    // 生成随机的会话密钥（32 字节原始材料）
    generateSessionKey() {
        return crypto.getRandomValues(new Uint8Array(32));
    },

    // 把会话密钥用对方的公钥封装，返回 { ephPub, iv, ct }
    async wrapSessionKey(sessionKeyBytes, recipientPubB64) {
        const recipientPub = await crypto.subtle.importKey(
            'spki',
            this.fromB64(recipientPubB64),
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
        );
        const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipientPub }, eph.privateKey, 256);
        const ephPubRaw = await crypto.subtle.exportKey('spki', eph.publicKey);
        const wrapKey = await this.hkdfKey(new Uint8Array(shared), new Uint8Array(ephPubRaw), 'static-wrap-v1');

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, wrapKey, sessionKeyBytes);
        return { ephPub: this.toB64(ephPubRaw), iv: this.toB64(iv), ct: this.toB64(ct) };
    },

    // 用自己的私钥解封会话密钥，返回原始字节
    async unwrapSessionKey(wrapped, myPrivKey) {
        try {
            const ephPubRaw = this.fromB64(wrapped.ephPub);
            const ephPub = await crypto.subtle.importKey(
                'spki', ephPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
            );
            const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephPub }, myPrivKey, 256);
            const wrapKey = await this.hkdfKey(new Uint8Array(shared), ephPubRaw, 'static-wrap-v1');
            const raw = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: this.fromB64(wrapped.iv) },
                wrapKey,
                this.fromB64(wrapped.ct)
            );
            return new Uint8Array(raw);
        } catch (e) {
            return null;
        }
    },

    // 原始字节 → AES-GCM 密钥（用于消息加解密）
    importSessionKey(bytes) {
        return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    },

    // ---------- 消息加解密（格式与旧版一致：base64(iv).base64(ct)） ----------

    async encryptWith(key, plaintext) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(plaintext));
        return this.toB64(iv) + '.' + this.toB64(ct);
    },

    async decryptWith(key, payload) {
        try {
            const parts = payload.split('.');
            if (parts.length !== 2) return null;
            const pt = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: this.fromB64(parts[0]) },
                key,
                this.fromB64(parts[1])
            );
            return new TextDecoder().decode(pt);
        } catch (e) {
            return null;
        }
    }
};
