/* ════════════════════════════════════════════════════════════════════
   SWIPE NAV  (iOS 스타일 좌우 스와이프 메뉴 전환)
   - 순서: 홈 → 검색 → 즐겨찾기 → 대기열 → 플레이리스트 (하단 메뉴 순서와 동일)
   - 스와이프 중 "현재 페이지 + 넘어오는 페이지"가 손가락을 따라 함께 이동한다.
   - 확정(거리/속도) 시 기존 gv() 를 그대로 호출 → 하단 메뉴(네이티브 Liquid Glass 포함)의
     활성 탭/렌더링/라우팅 로직은 기존과 100% 동일하게 동작한다. (app.js 수정 없음)
   - 가로 스크롤 영역(캐러셀 등)이 해당 방향으로 스크롤 가능하면 스와이프를 가로채지 않는다.
   - NP/미니플레이어/다이얼로그/모달 위에서는 동작하지 않는다.
════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const ORDER = ['home', 'search', 'fav', 'queue', 'playlists'];
    const root = document.documentElement;
    const views = {};
    for (const v of ORDER) {
        views[v] = document.getElementById('v-' + v);
        if (!views[v]) return;                       // 구조가 다르면 아무것도 하지 않는다
    }

    const LOCK_SLOP = 6;          // 방향 판정 시작 거리(px)
    const COMMIT_RATIO = 0.33;    // 화면 폭 대비 확정 거리
    const COMMIT_VELOCITY = 0.45; // px/ms
    const EDGE_RESIST = 0.28;     // 첫/마지막 페이지에서의 저항
    const EASE = 'cubic-bezier(.22,.82,.28,1)';

    let st = null;        // 현재 제스처 상태
    let animating = false;
    let settleTimer = 0;

    const inner = v => v.querySelector(':scope > .view-inner');
    const curIndex = () => ORDER.findIndex(v => views[v].classList.contains('on'));

    /* ── 스와이프를 시작하면 안 되는 상황 ── */
    function blocked(target) {
        if (!target || !target.closest) return true;
        if (target.closest('#np,#bar,#mob-nav,#toast,.sug-drop,#pl-ctx-menu,input,textarea,select')) return true;
        if (root.classList.contains('np-open')) return true;
        const np = document.getElementById('np');
        if (np && np.classList.contains('on')) return true;
        if (document.querySelector('#pl-ctx-menu.on,#pl-dialog-overlay.on,#pl-confirm-overlay.on,#pl-add-modal-overlay.on')) return true;
        return false;
    }

    /* 터치 시작 지점의 조상 중, 같은 방향으로 아직 스크롤 가능한 가로 스크롤러가 있는가 */
    function hScrollerCanMove(el, dx) {
        for (let n = el; n && n !== document.body && n !== root; n = n.parentElement) {
            const ox = getComputedStyle(n).overflowX;
            if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth + 1) {
                const max = n.scrollWidth - n.clientWidth;
                if (dx < 0 && n.scrollLeft < max - 1) return true;
                if (dx > 0 && n.scrollLeft > 1) return true;
            }
        }
        return false;
    }

    function resetInner(el) {
        if (!el) return;
        el.style.transform = '';
        el.style.opacity = '';
        el.style.transition = '';
        el.style.willChange = '';
    }

    /* 넘어올 페이지의 최신 내용 (gv 가 하던 렌더링과 동일한 함수만 호출) */
    function prerender(v) {
        try {
            if (v === 'home' && typeof renderRecentPlayed === 'function') renderRecentPlayed();
            else if (v === 'fav' && typeof renderFavGrid === 'function') renderFavGrid();
            else if (v === 'queue' && typeof renderQueue === 'function') renderQueue();
            else if (v === 'playlists' && typeof plRenderGrid === 'function') plRenderGrid();
        } catch (e) { /* 렌더 실패가 제스처를 깨뜨리지 않도록 */ }
    }

    /* 네이티브 글래스에 알림: 상태 즉시 재전송 요청 / 캡슐 가로 오프셋 전달 */
    function kickGlass() { try { if (window.__glassKick) window.__glassKick(300); } catch (e) {} }
    /* 드래그 중 캡슐 위치는 네이티브가 같은 터치 스트림에서 직접 계산한다(프레임당 IPC 없음) — 시작/정착 시에만 1회 통보 */
    function nativeBegin(x) {
        try {
            const W = root.clientWidth || window.innerWidth;
            if (window.GlassBridge && window.GlassBridge.swipeBegin)
                window.GlassBridge.swipeBegin(x, W, st.idx > 0, st.idx < ORDER.length - 1);
        } catch (e) {}
    }
    function nativeSettle(commit, dir, ms) {
        try { if (window.GlassBridge && window.GlassBridge.swipeSettle) window.GlassBridge.swipeSettle(commit, dir, ms); } catch (e) {}
    }

    /* 넘어오는 페이지의 검색 캡슐 위치(고정 컨테이너 기준, 스크롤 0) — 네이티브 캡슐(search2)용 */
    function peekCapsule(v) {
        const wrap = v.querySelector('.mob-srch-wrap');
        const inp = wrap && wrap.querySelector('.srch-inp');
        if (!wrap || !inp) return null;
        const r = wrap.getBoundingClientRect();
        return {
            r: { x: r.left, y: r.top, w: r.width, h: r.height }, pin: r.top,
            id: inp.id, value: inp.value, ph: inp.getAttribute('placeholder') || '', focused: false
        };
    }

    function clearPeek() {
        if (window.__swipe) window.__swipe.peek2 = null;
        if (!st || !st.peek) return;
        st.peek.classList.remove('swipe-peek');
        st.peek.style.animation = '';
        resetInner(st.peekInner);
        st.peek = st.peekInner = null;
    }

    function setPeek(dir) {
        clearPeek();
        st.dir = dir;
        const t = st.idx + dir;
        if (t < 0 || t >= ORDER.length) return;     // 가장자리: 이웃 페이지 없음
        const name = ORDER[t];
        const v = views[name];
        st.tIdx = t;
        st.tName = name;
        st.peek = v;
        st.peekInner = inner(v);
        setTimeout(() => { if (st && st.peek === v && st.locked === 'x') prerender(name); }, 0);   // 드래그 첫 프레임을 막지 않도록 지연
        v.style.animation = 'none';                 // 표시될 때 vIn 애니메이션이 재생되지 않도록
        v.classList.add('swipe-peek');
        if (st.peekInner) st.peekInner.style.willChange = 'transform, opacity';
        if (window.__swipe) { window.__swipe.peek2 = peekCapsule(v); kickGlass(); }
    }

    function begin(x) {
        st.locked = 'x';
        st.ox = x;
        window.__swipe = { active: true, frozen: undefined, peek2: null };   // glass-bridge.js 가 참조
        root.classList.add('swiping');
        st.cur.classList.add('swipe-cur');
        if (st.curInner) st.curInner.style.willChange = 'transform, opacity';
        nativeBegin(x);
        const a = document.activeElement;
        if (a && a !== document.body && a.blur) { try { a.blur(); } catch (e) {} }
    }

    function render(dx) {
        const W = root.clientWidth || window.innerWidth;
        const dir = dx < 0 ? 1 : (dx > 0 ? -1 : st.dir || 1);
        if (dir !== st.dir) setPeek(dir);
        let tx;
        if (st.peek) {
            tx = Math.max(-W, Math.min(W, dx));
        } else {
            tx = dx * EDGE_RESIST;                  // 고무줄 저항
        }
        st.tx = tx;
        const p = Math.min(1, Math.abs(tx) / W);
        if (st.curInner) {
            st.curInner.style.transform = 'translate3d(' + tx + 'px,0,0)';
            st.curInner.style.opacity = String(1 - 0.35 * p);
        }
        if (st.peek && st.peekInner) {
            st.peekInner.style.transform = 'translate3d(' + (tx + st.dir * W) + 'px,0,0)';
            st.peekInner.style.opacity = String(0.65 + 0.35 * p);
        }
    }

    function cleanup(commit) {
        if (!st) return;
        clearTimeout(settleTimer);
        window.__swipe = null;
        root.classList.remove('swiping');
        if (commit) {
            try { window.scrollTo(0, 0); } catch (e) {}
            /* 네이티브 글래스는 WebView.getScrollY() 가 갱신되기 전까지 이전 페이지의 스크롤값으로 캡슐 위치(sticky)를 계산한다.
               → 새 페이지 캡슐이 잠깐 상단에 고정된(=이전 검색 화면 같은) 위치로 보이는 원인. 확정 스크롤(0)을 즉시 알려준다. */
            try { if (window.GlassBridge && window.GlassBridge.settled) window.GlassBridge.settled(0); } catch (e) {}
        }
        resetInner(st.curInner);
        resetInner(st.peekInner);
        st.cur.classList.remove('swipe-cur');
        if (st.peek) {
            st.peek.classList.remove('swipe-peek');
            if (!commit) st.peek.style.animation = '';   // 확정된 페이지는 옵저버가 정리
        }
        /* 최종 상태(새 페이지의 캡슐)를 즉시 push → 네이티브가 같은 프레임에 오프셋 초기화 + 캡슐 교체 */
        try { if (window.__glassSync) window.__glassSync(); } catch (e) {}
        st = null;
        animating = false;
        kickGlass();
    }

    function finishNow() {
        if (!st) { animating = false; return; }
        cleanup(!!st.commit);
    }

    function settle(commit) {
        const W = root.clientWidth || window.innerWidth;
        const remain = commit ? (W - Math.abs(st.tx)) : Math.abs(st.tx);
        const ms = Math.round(Math.max(190, Math.min(340, 170 + (remain / W) * 200)));
        const tr = 'transform ' + ms + 'ms ' + EASE + ', opacity ' + ms + 'ms ' + EASE;
        st.commit = commit && !!st.peek;
        animating = true;
        nativeSettle(st.commit, st.dir || 1, ms);   // 네이티브 캡슐도 같은 시간/곡선으로 즉시 정착 시작 (gv 렌더링보다 먼저)

        if (st.commit) {
            /* 기존 라우팅 그대로 호출 → .on / 하단 메뉴 활성 탭 / 렌더링이 즉시 갱신(글래스 인디케이터도 동시에 이동) */
            const name = st.tName;
            try { if (typeof window.gv === 'function') window.gv(name); } catch (e) {}
        }

        if (st.curInner) {
            st.curInner.style.transition = tr;
            st.curInner.style.transform = 'translate3d(' + (st.commit ? -st.dir * W : 0) + 'px,0,0)';
            st.curInner.style.opacity = st.commit ? '0.65' : '1';
        }
        if (st.peek && st.peekInner) {
            st.peekInner.style.transition = tr;
            st.peekInner.style.transform = 'translate3d(' + (st.commit ? 0 : st.dir * W) + 'px,0,0)';
            st.peekInner.style.opacity = st.commit ? '1' : '0.65';
        }

        const mine = st;
        const done = () => { if (st === mine) cleanup(mine.commit); };
        if (st.curInner) {
            const onEnd = e => {
                if (e.target !== mine.curInner || e.propertyName !== 'transform') return;
                mine.curInner.removeEventListener('transitionend', onEnd);
                done();
            };
            st.curInner.addEventListener('transitionend', onEnd);
        }
        settleTimer = setTimeout(done, ms + 90);     // transitionend 가 오지 않는 경우(이동 거리 0 등)의 안전망
    }

    /* ── 터치 이벤트 ── */
    document.addEventListener('touchstart', e => {
        if (animating) finishNow();
        st = null;
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (blocked(e.target)) return;
        const idx = curIndex();
        if (idx < 0) return;
        st = {
            x0: t.clientX, y0: t.clientY, target: e.target, idx: idx,
            locked: null, dir: 0, tx: 0, ox: 0,
            cur: views[ORDER[idx]], curInner: inner(views[ORDER[idx]]),
            peek: null, peekInner: null, tIdx: -1, tName: '', commit: false,
            samples: [{ x: t.clientX, t: performance.now() }]
        };
    }, { passive: true, capture: true });

    document.addEventListener('touchmove', e => {
        if (!st || animating) return;
        if (e.touches.length !== 1) { if (st.locked === 'x') settle(false); else st = null; return; }
        const t = e.touches[0];
        const dx = t.clientX - st.x0, dy = t.clientY - st.y0;

        if (st.locked === null) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_SLOP) return;
            if (Math.abs(dx) > Math.abs(dy) * 1.3 && !hScrollerCanMove(st.target, dx)) {
                begin(t.clientX);
            } else {
                st.locked = 'y';                    // 세로 스크롤/가로 캐러셀 → 기존 동작에 맡김
                return;
            }
        }
        if (st.locked !== 'x') return;

        if (e.cancelable) e.preventDefault();       // 스와이프 중 문서 스크롤 방지

        const now = performance.now();
        st.samples.push({ x: t.clientX, t: now });
        while (st.samples.length > 2 && now - st.samples[0].t > 100) st.samples.shift();

        render(t.clientX - st.ox);
    }, { passive: false, capture: true });

    function end(cancelled) {
        if (!st || animating) return;
        if (st.locked !== 'x') { st = null; return; }
        const W = root.clientWidth || window.innerWidth;
        const s = st.samples, a = s[0], b = s[s.length - 1];
        const v = (b.t - a.t) > 8 ? (b.x - a.x) / (b.t - a.t) : 0;   // px/ms (좌: 음수)
        const towards = st.dir === 1 ? v < 0 : v > 0;
        const commit = !cancelled && !!st.peek &&
            (Math.abs(st.tx) > W * COMMIT_RATIO || (towards && Math.abs(v) > COMMIT_VELOCITY && Math.abs(st.tx) > 12));
        settle(commit);
    }
    document.addEventListener('touchend', () => end(false), { passive: true, capture: true });
    document.addEventListener('touchcancel', () => end(true), { passive: true, capture: true });

    /* 확정된 페이지에 남겨 둔 animation:none 인라인 스타일은, 그 페이지가 비활성화되는 시점에 제거
       (이후 하단 메뉴 탭으로 진입할 때는 기존 vIn 애니메이션이 그대로 재생된다) */
    const mo = new MutationObserver(recs => {
        for (const r of recs) {
            const el = r.target;
            if (!el.classList.contains('on') && !el.classList.contains('swipe-cur') &&
                !el.classList.contains('swipe-peek') && el.style.animation) {
                el.style.animation = '';
            }
        }
    });
    for (const v of ORDER) mo.observe(views[v], { attributes: true, attributeFilter: ['class'] });
})();
