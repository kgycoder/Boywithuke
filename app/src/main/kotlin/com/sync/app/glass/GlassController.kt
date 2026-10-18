package com.sync.app.glass

import android.animation.ValueAnimator
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.animation.PathInterpolator
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject

/**
 * Frontend(WebView) <-> Native(Compose) channel.
 *
 *  JS  -> Kotlin : window.GlassBridge.push(json)   (DOM state mirror, rects in CSS px)
 *  Kotlin -> JS  : window.__glassCmd({...})        (taps / text input forwarded to the existing app.js functions)
 *
 * The WebView + app.js + AndroidBridge keep running exactly as before; they remain the single source of
 * truth for playback / search / playlists. Compose only renders the glass surfaces and their controls.
 */
class GlassController(private val webView: WebView) {

    var state by mutableStateOf(GlassState())
        private set

    /**
     * WebView.getScrollY() (px) at the last onScrollChange. This is only the *invalidation signal*:
     * reading it inside a layout/draw block makes that block run again when the page scrolls.
     * The value that is actually used for positioning is read live from the WebView (see [cssScroll]).
     */
    var nativeScrollPx by mutableIntStateOf(0)
        private set

    /** Bumped once a scroll has settled, so every layout/draw block that reads [cssScroll] runs once more and
     *  re-reads the final offset (a rapid burst of scroll/reflow could otherwise leave the last frame's
     *  invalidation behind, which showed up as a capsule that stayed misaligned until the next scroll). */
    var settleTick by mutableIntStateOf(0)
        private set

    /** 스와이프 메뉴 전환 중 검색 캡슐의 가로 오프셋(CSS px == dp).
     *  [swipeDx] = 현재 페이지의 캡슐, [swipeDx2] = 넘어오는 페이지의 캡슐. state 푸시와 별개로 프레임마다 갱신된다. */
    var swipeDx by mutableFloatStateOf(0f)
        private set
    var swipeDx2 by mutableFloatStateOf(0f)
        private set

    /* ── 스와이프 메뉴 전환: 캡슐 오프셋을 JS 왕복 없이 네이티브가 터치에서 직접 계산한다 ──
     * JS(swipe-nav.js)는 "시작(원점/폭/이웃 유무)"과 "정착(확정 여부/방향/시간)" 두 번만 알려 주고,
     * 드래그 중 매 프레임의 위치는 WebView 로 들어오는 같은 터치 스트림(onTouch)에서 같은 공식으로 계산한다.
     * (프레임마다 JS→Java 동기 IPC → UI 스레드 post → 재배치를 거치던 지연 제거) */
    private var swActive = false
    private var swOx = 0f
    private var swW = 0f
    private var swHasPrev = false
    private var swHasNext = false
    private var swDir = 1
    private var swTouching = false
    private var swTouchX = 0f
    private var swAnim: ValueAnimator? = null

    /** WebView 의 터치를 관찰만 한다(소비하지 않음). UI 스레드에서 호출. */
    fun onTouch(ev: MotionEvent) {
        val d = webView.resources.displayMetrics.density
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> { swTouching = true; swTouchX = ev.x / d }
            MotionEvent.ACTION_MOVE -> {
                swTouchX = ev.x / d
                if (swActive && swTouching && ev.pointerCount == 1) applySwipeTouch()
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> swTouching = false
        }
    }

    private fun applySwipeTouch() {
        val dx = swTouchX - swOx
        val dir = if (dx < 0f) 1 else if (dx > 0f) -1 else swDir
        swDir = dir
        val has = if (dir == 1) swHasNext else swHasPrev
        val cur = if (has) dx.coerceIn(-swW, swW) else dx * 0.28f      // swipe-nav.js 의 render() 와 동일 공식
        swipeDx = cur
        swipeDx2 = if (has) cur + dir * swW else 0f
    }

    @JavascriptInterface
    fun swipeBegin(originX: Float, width: Float, hasPrev: Boolean, hasNext: Boolean) {
        main.post {
            swAnim?.cancel()
            swOx = originX; swW = width; swHasPrev = hasPrev; swHasNext = hasNext
            swActive = true
            if (swTouching) applySwipeTouch()      // JS 가 잠금을 확정하기 전에 이미 들어온 이동량까지 즉시 반영
        }
    }

    @JavascriptInterface
    fun swipeSettle(commit: Boolean, dir: Int, ms: Int) {
        main.post {
            swActive = false
            swAnim?.cancel()
            val c0 = swipeDx; val o0 = swipeDx2
            val cT = if (commit) -dir * swW else 0f
            val oT = if (commit) 0f else dir * swW
            swAnim = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = ms.toLong()
                interpolator = PathInterpolator(0.22f, 0.82f, 0.28f, 1f)    // CSS 정착 애니메이션과 동일 곡선
                addUpdateListener {
                    val e = it.animatedValue as Float
                    swipeDx = c0 + (cT - c0) * e
                    if (o0 != 0f || commit) swipeDx2 = o0 + (oT - o0) * e
                }
                start()
            }
        }
    }

    /** 이전 버전 호환용 (사용하지 않음) */
    @JavascriptInterface
    fun swipe(dx: Float, dx2: Float) {
        main.post { swipeDx = dx; swipeDx2 = dx2 }
    }

    /** CSS px. Non-zero only if the page (JS) reported a settled scroll offset that differs from WebView.getScrollY(). */
    private var settleBias = 0f
    private var lastNativeY = 0
    private val settle = Runnable { settleTick++ }

    fun onNativeScroll(y: Int) {
        if (y != lastNativeY) { lastNativeY = y; settleBias = 0f }   // new scroll → drop any stale correction
        nativeScrollPx = y
        main.removeCallbacks(settle)
        main.postDelayed(settle, 120)
        main.postDelayed(settle, 400)
    }

    /**
     * Called once by glass-bridge.js ~150ms after the last scroll event (one call per scroll gesture, not per event).
     * [y] is window.scrollY (CSS px) = ground truth of what the page is showing. If WebView.getScrollY() disagrees,
     * the glass follows the page, not the stale Java value.
     */
    @JavascriptInterface
    fun settled(y: Float) {
        main.post {
            val d = webView.resources.displayMetrics.density
            val diff = y - webView.scrollY / d
            settleBias = if (kotlin.math.abs(diff) > 1f) diff else 0f
            settleTick++
        }
    }

    /** Kept for backward compatibility with older bridge scripts. Per-scroll-event JS→Java calls are synchronous
     *  IPC that stall the renderer's main thread (= scroll jank), so glass-bridge.js no longer calls this. */
    @JavascriptInterface
    fun scroll(y: Float) { /* no-op */ }

    /**
     * Current document scroll in CSS px (== dp).
     *
     * Subscribes to [nativeScrollPx] / [settleTick] (so callers re-run on scroll and once more after it settles) but
     * returns WebView.getScrollY() *at call time*.
     * WebView syncs its scroll offset inside its own onDraw; a draw block that runs after the WebView was drawn
     * (glass is a later sibling) therefore sees the offset of the frame that is being produced right now,
     * instead of the previous frame's value that a state snapshot would give.
     */
    fun cssScroll(density: Float): Float {
        @Suppress("UNUSED_VARIABLE") val a = nativeScrollPx
        @Suppress("UNUSED_VARIABLE") val b = settleTick
        return webView.scrollY / density + settleBias
    }

    private val main = Handler(Looper.getMainLooper())
    private var lastJson = ""

    @JavascriptInterface
    fun push(json: String) {
        if (json == lastJson) return
        lastJson = json
        // parse on the JS bridge thread; only the already-built immutable state hops to the UI thread
        val parsed = try { GlassState.parse(json) } catch (_: Exception) { return }
        main.post {
            if (!parsed.swiping) { swAnim?.cancel(); swActive = false; swipeDx = 0f; swipeDx2 = 0f }   // 스와이프 종료: 오프셋 초기화와 상태 교체를 같은 프레임에
            state = parsed
        }
    }

    fun cmd(build: JSONObject.() -> Unit) {
        val js = JSONObject().apply(build).toString()
        webView.post { webView.evaluateJavascript("window.__glassCmd&&window.__glassCmd($js)", null) }
    }
}
