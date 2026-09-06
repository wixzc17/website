// 标记徽章共用助手 —— 类 X 的 affiliate label（组织归属标记）
// 视觉：小圆角方形（1.1em 见方，1px 白线框），里面装授予方的头像
//
// 用法：
//   LabelBadge.attach(nameEl, userId)   // 异步：命中标记才在元素末尾插入徽章，返回 Promise<bool>
//   LabelBadge.check(['a','b'])         // 批量查，返回 Promise<Map>（id -> {grantedBy, ts, grantedByAvatar}）
//
// 接口：GET /api/labels?ids=a,b,c → { ok, labels: { a: {grantedBy, ts, grantedByAvatar}, ... } }
// 同一页面多个 attach 会合并成一次请求（40ms 微批），同一 id 结果全页缓存
(function () {
    var cache = {};          // id -> {grantedBy, ts, grantedByAvatar} | false
    var batch = {};          // id -> [resolveFn...]
    var batchScheduled = false;

    function ensureStyle() {
        if (!document.getElementById('label-badge-style')) {
            var style = document.createElement('style');
            style.id = 'label-badge-style';
            style.textContent =
                '.label-badge{display:inline-block;width:1.1em;height:1.1em;margin-left:0.25em;' +
                'vertical-align:-0.15em;border:1px solid var(--fg, #fff);border-radius:0.2em;' +
                'overflow:hidden;background:var(--bg, #000);box-sizing:border-box}' +
                '.label-badge img{display:block;width:100%;height:100%;object-fit:cover}';
            document.head.appendChild(style);
        }
    }

    function flushBatch() {
        batchScheduled = false;
        var ids = Object.keys(batch);
        var current = batch;
        batch = {};
        fetch('/api/labels?ids=' + encodeURIComponent(ids.join(',')))
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var map = (data && data.ok && data.labels) ? data.labels : {};
                ids.forEach(function (id) {
                    var rec = Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null;
                    cache[id] = rec || false;
                    (current[id] || []).forEach(function (fn) { fn(!!rec); });
                });
            })
            .catch(function () {
                ids.forEach(function (id) {
                    cache[id] = false;
                    (current[id] || []).forEach(function (fn) { fn(false); });
                });
            });
    }

    function checkOne(id) {
        if (id in cache) return Promise.resolve(!!cache[id]);
        if (!batch[id]) batch[id] = [];
        var fns = batch[id];
        return new Promise(function (resolve) {
            fns.push(resolve);
            if (!batchScheduled) {
                batchScheduled = true;
                setTimeout(flushBatch, 40);
            }
        });
    }

    window.LabelBadge = {
        check: function (ids) {
            var list = (Array.isArray(ids) ? ids : [ids])
                .map(function (x) { return String(x || '').trim().replace(/^@/, ''); })
                .filter(function (x) { return /^[a-zA-Z0-9]+$/.test(x); });
            return Promise.all(list.map(function (id) { return checkOne(id); })).then(function (flags) {
                var map = new Map();
                flags.forEach(function (ok, i) { if (ok) map.set(list[i], cache[list[i]]); });
                return map;
            });
        },

        attach: function (nameEl, userId) {
            ensureStyle();
            var id = String(userId || '').trim().replace(/^@/, '');
            if (!/^[a-zA-Z0-9]+$/.test(id)) return Promise.resolve(false);
            return checkOne(id).then(function (has) {
                if (!has || !nameEl || !nameEl.parentNode) return false;
                // 防重复插入
                if (nameEl.querySelector('.label-badge')) return true;
                var rec = cache[id];
                var span = document.createElement('span');
                span.className = 'label-badge';
                span.title = '由 @' + rec.grantedBy + ' 授予的标记';
                if (rec.grantedByAvatar) {
                    var img = document.createElement('img');
                    img.src = rec.grantedByAvatar;
                    img.alt = '@' + rec.grantedBy;
                    span.appendChild(img);
                } else {
                    // 授予方没设头像时，退化为显示 @ID 首字母
                    span.style.display = 'inline-flex';
                    span.style.alignItems = 'center';
                    span.style.justifyContent = 'center';
                    span.style.fontSize = '0.7em';
                    span.style.fontFamily = 'ui-monospace, monospace';
                    span.textContent = rec.grantedBy.charAt(0).toUpperCase();
                }
                nameEl.appendChild(span);
                return true;
            }).catch(function () { return false; });
        }
    };
})();
