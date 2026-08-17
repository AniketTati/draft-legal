/* eslint-disable */
/**
 * overlay.js — the "camera crew" that rides along inside the page.
 *
 * Injected with page.addInitScript(), so it survives every navigation and is
 * present before the app's own scripts run. Everything it draws is
 * pointer-events:none and lives above the app, which means Playwright's real
 * clicks pass straight through it — the pointer you see is a drawing of where
 * the automation is about to click, not a thing that intercepts the click.
 *
 * Exposes window.__demo:
 *   moveTo(x, y, ms)          glide the pointer, eased
 *   press(x, y)               click ripple where the pointer is
 *   spotlight(rect, opts)     dim the page except for one rectangle
 *   clearSpotlight()
 *   caption(text)             lower-third label
 *   clearCaption()
 *   zoom(cx, cy, scale, ms)   ease the whole page in toward a point
 *   unzoom(ms)
 *   pos()                     current pointer position
 */
;(() => {
  if (window.__demo) return

  const Z = 2147483000
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  let root, cursor, spot, ring, cap, mounted = false
  let x = window.innerWidth / 2
  let y = window.innerHeight / 2

  function el(tag, css, html) {
    const n = document.createElement(tag)
    n.style.cssText = css
    if (html) n.innerHTML = html
    return n
  }

  function mount() {
    if (mounted && document.body.contains(root)) return
    if (!document.body) return
    root = el(
      'div',
      `position:fixed;inset:0;z-index:${Z};pointer-events:none;overflow:hidden;`
    )
    root.setAttribute('data-demo-overlay', '')

    // Spotlight: a transparent rect with a huge box-shadow, which dims
    // everything outside it. Cheaper and softer than an SVG mask, and it
    // animates without repainting the page underneath.
    spot = el(
      'div',
      `position:fixed;left:0;top:0;width:0;height:0;border-radius:12px;` +
        `box-shadow:0 0 0 9999px rgba(2,6,23,0);pointer-events:none;opacity:0;` +
        `transition:opacity .35s ease, box-shadow .35s ease, transform .45s cubic-bezier(.4,0,.2,1),` +
        `width .45s cubic-bezier(.4,0,.2,1), height .45s cubic-bezier(.4,0,.2,1);`
    )
    ring = el(
      'div',
      `position:fixed;left:0;top:0;width:0;height:0;border-radius:12px;` +
        `border:2px solid rgba(16,185,129,.95);box-shadow:0 0 0 4px rgba(16,185,129,.18);` +
        `pointer-events:none;opacity:0;` +
        `transition:opacity .35s ease, transform .45s cubic-bezier(.4,0,.2,1),` +
        `width .45s cubic-bezier(.4,0,.2,1), height .45s cubic-bezier(.4,0,.2,1);`
    )

    cap = el(
      'div',
      `position:fixed;left:50%;bottom:52px;transform:translateX(-50%) translateY(8px);` +
        `padding:12px 22px;border-radius:999px;background:rgba(2,6,23,.88);` +
        `backdrop-filter:blur(8px);color:#f8fafc;opacity:0;` +
        `font:600 19px/1.35 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;` +
        `letter-spacing:.2px;box-shadow:0 12px 40px rgba(0,0,0,.35);` +
        `transition:opacity .3s ease, transform .3s ease;white-space:nowrap;`
    )

    cursor = el(
      'div',
      `position:fixed;left:0;top:0;width:26px;height:26px;will-change:transform;` +
        `transform:translate(${x}px,${y}px);pointer-events:none;`,
      `<svg width="26" height="26" viewBox="0 0 26 26" fill="none"
            style="filter:drop-shadow(0 3px 6px rgba(0,0,0,.45))">
         <path d="M5 2.5 L5 19.5 L9.4 15.4 L12.3 22 L15.6 20.5 L12.8 14.1 L18.7 13.9 Z"
               fill="#ffffff" stroke="#0f172a" stroke-width="1.4" stroke-linejoin="round"/>
       </svg>`
    )

    root.append(spot, ring, cap, cursor)
    document.body.appendChild(root)
    mounted = true
  }

  const ensure = () => {
    if (!document.body) return false
    mount()
    // Keep the overlay last in the DOM so app-rendered modals can't cover it.
    if (root && document.body.lastElementChild !== root) document.body.appendChild(root)
    return true
  }

  function moveTo(tx, ty, ms = 700) {
    if (!ensure()) return Promise.resolve()
    const sx = x
    const sy = y
    const start = performance.now()
    return new Promise((resolve) => {
      const step = (now) => {
        const t = ms <= 0 ? 1 : Math.min(1, (now - start) / ms)
        const e = easeInOutCubic(t)
        x = sx + (tx - sx) * e
        y = sy + (ty - sy) * e
        cursor.style.transform = `translate(${x}px,${y}px)`
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  }

  async function press() {
    if (!ensure()) return
    const r = el(
      'div',
      `position:fixed;left:${x - 6}px;top:${y - 6}px;width:12px;height:12px;border-radius:50%;` +
        `background:rgba(16,185,129,.45);border:2px solid rgba(16,185,129,.9);` +
        `transform:scale(1);opacity:1;pointer-events:none;` +
        `transition:transform .5s cubic-bezier(.2,.8,.3,1), opacity .5s ease;`
    )
    root.appendChild(r)
    cursor.style.transform = `translate(${x}px,${y}px) scale(.82)`
    requestAnimationFrame(() => {
      r.style.transform = 'scale(4.2)'
      r.style.opacity = '0'
    })
    await sleep(120)
    cursor.style.transform = `translate(${x}px,${y}px) scale(1)`
    setTimeout(() => r.remove(), 600)
  }

  function spotlight(rect, opts = {}) {
    if (!ensure()) return
    const pad = opts.pad ?? 10
    const dim = opts.dim ?? 0.58
    const radius = opts.radius ?? 12
    for (const n of [spot, ring]) {
      n.style.borderRadius = radius + 'px'
      n.style.width = rect.width + pad * 2 + 'px'
      n.style.height = rect.height + pad * 2 + 'px'
      n.style.transform = `translate(${rect.x - pad}px,${rect.y - pad}px)`
      n.style.opacity = '1'
    }
    spot.style.boxShadow = `0 0 0 9999px rgba(2,6,23,${dim})`
  }

  function clearSpotlight() {
    if (!mounted) return
    spot.style.opacity = '0'
    spot.style.boxShadow = '0 0 0 9999px rgba(2,6,23,0)'
    ring.style.opacity = '0'
  }

  function caption(text) {
    if (!ensure()) return
    cap.textContent = text
    cap.style.opacity = '1'
    cap.style.transform = 'translateX(-50%) translateY(0)'
  }

  function clearCaption() {
    if (!mounted) return
    cap.style.opacity = '0'
    cap.style.transform = 'translateX(-50%) translateY(8px)'
  }

  // Zoom scales <html>, which takes fixed-position chrome (sidebar, modals)
  // along with it — so the frame reads like a camera push, not a CSS bug.
  // Only ever used on hold beats, never while clicking, so hit-testing is
  // never affected.
  //
  // The target is CENTRED, not used as the transform origin. Origin-based
  // zoom keeps the target pinned wherever it already was, so anything near an
  // edge stays at that edge and gets cropped — which is exactly what happened
  // to the approval card the narration names. With origin at 0 0, a point P
  // maps to P*k + t, so t = centre - P*k puts the target dead centre.
  function zoom(px, py, scale = 1.35, ms = 900) {
    const h = document.documentElement
    const vw = window.innerWidth
    const vh = window.innerHeight
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
    // Then clamp the pan so the scaled page still fills the frame — otherwise
    // a target near a corner drags blank space in beside it.
    const tx = clamp(vw / 2 - px * scale, vw - vw * scale, 0)
    const ty = clamp(vh / 2 - py * scale, vh - vh * scale, 0)
    h.style.transformOrigin = '0 0'
    h.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`
    h.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    return sleep(ms)
  }

  function unzoom(ms = 700) {
    const h = document.documentElement
    h.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`
    h.style.transform = 'translate(0px, 0px) scale(1)'
    return sleep(ms)
  }

  window.__demo = {
    mount: ensure,
    moveTo,
    press,
    spotlight,
    clearSpotlight,
    caption,
    clearCaption,
    zoom,
    unzoom,
    pos: () => ({ x, y }),
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensure)
  } else {
    ensure()
  }
})()
