// Cycling image carousel mechanics, shared by the inline tile galleries
// (app.js, item.js) and the fullscreen lightbox modal (lightbox.js).
//
// Strategy: clone-pad. The track is built as
//   [last-clone, img1, img2, ..., imgN, first-clone]
// so swipes past either real edge land on a clone of the wrap-around image.
// A scrollend handler then silently warps scrollLeft to the real position.
// To the user this looks like a seamless wrap; under the hood the browser's
// native scroll-snap is doing all the swipe physics.
//
// attachCyclingCarousel returns a small handle the caller wires its
// prev/next buttons and any external "go to this image" calls to.

const SCROLLEND_FALLBACK_MS = 120;

// Detect when scroll settles. Native `scrollend` (Chrome 114, FF 109,
// Safari 17.4) is preferred; on older Safari we debounce scroll events.
function onScrollEnd(el, handler) {
  if ('onscrollend' in el) {
    el.addEventListener('scrollend', handler);
    return () => el.removeEventListener('scrollend', handler);
  }
  let timer;
  const onScroll = () => {
    clearTimeout(timer);
    timer = setTimeout(handler, SCROLLEND_FALLBACK_MS);
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    el.removeEventListener('scroll', onScroll);
    clearTimeout(timer);
  };
}

// track: empty <div> the caller has already styled as a scroll-snap track.
// opts:
//   images:        string[] — real image URLs (no clones; this fn adds them)
//   alt:           string — alt text for non-clone images
//   counterEl:     element? — receives "i / N" text on every snap change
//   onIndexChange: (realIdx) => void — fired when the snapped real index
//                  changes (for callers that need to sync external state)
//   startIndex:    number — initial real index (clamped to [0, N-1])
//
// Returns { step(dir), goTo(realIdx), getIndex(), destroy() }. step uses
// smooth scroll; goTo is instant.
export function attachCyclingCarousel(track, opts) {
  const { images, alt = '', counterEl, onIndexChange, startIndex = 0 } = opts;
  if (!Array.isArray(images) || images.length === 0) {
    return { step: () => {}, goTo: () => {}, getIndex: () => 0, destroy: () => {} };
  }

  const noop = { step: () => {}, goTo: () => {}, getIndex: () => 0, destroy: () => {} };

  // Single image: no cycling, no clones, no counter math.
  if (images.length === 1) {
    track.replaceChildren();
    const img = document.createElement('img');
    img.src = images[0];
    img.alt = alt;
    img.loading = 'lazy';
    img.draggable = false;
    track.appendChild(img);
    if (counterEl) counterEl.textContent = '';
    return noop;
  }

  // Build clone-padded track: [last-clone, ...images, first-clone].
  // Real images sit at DOM positions 1..N; clones at 0 and N+1.
  const buildImg = (src, isClone) => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = isClone ? '' : alt;
    img.loading = 'lazy';
    img.draggable = false;
    if (isClone) img.setAttribute('aria-hidden', 'true');
    return img;
  };
  track.replaceChildren();
  track.appendChild(buildImg(images[images.length - 1], true));
  for (const src of images) track.appendChild(buildImg(src, false));
  track.appendChild(buildImg(images[0], true));

  // Map between DOM snap position (0..N+1) and the user-facing real index
  // (0..N-1). Clone positions resolve to the image they're duplicating.
  const posFromReal = (real) => real + 1;
  const realFromPos = (pos) => {
    if (pos <= 0) return images.length - 1;
    if (pos >= images.length + 1) return 0;
    return pos - 1;
  };

  let currentReal = Math.max(0, Math.min(startIndex, images.length - 1));
  // `.gallery-track` has CSS `scroll-behavior: smooth`, which applies to
  // *all* programmatic scroll-position assignments — including the silent
  // warp from clone to real position. If we don't disable it for snapTo,
  // the warp animates smoothly all the way across the track, looking like
  // the carousel "flies through" every slide after a wrap-around. Toggle
  // scroll-behavior to auto for the assignment and restore immediately.
  const snapTo = (pos) => {
    const prev = track.style.scrollBehavior;
    track.style.scrollBehavior = 'auto';
    track.scrollLeft = pos * track.clientWidth;
    track.style.scrollBehavior = prev;
  };
  const animateTo = (pos) => { track.scrollTo({ left: pos * track.clientWidth, behavior: 'smooth' }); };

  const writeCounter = () => {
    if (counterEl) counterEl.textContent = `${currentReal + 1} / ${images.length}`;
  };
  writeCounter();

  // Initialise position once the track has a real width. When this helper
  // is used inside the lightbox, the modal is hidden at attach time so
  // clientWidth is 0; the ResizeObserver below catches the resize when the
  // modal becomes visible.
  let initialised = false;
  const tryInit = () => {
    if (initialised || track.clientWidth === 0) return;
    snapTo(posFromReal(currentReal));
    initialised = true;
  };
  tryInit();
  if (!initialised) requestAnimationFrame(tryInit);

  // Resize: re-snap so the current image stays centred when the viewport
  // changes (phone rotation, etc.).
  const ro = new ResizeObserver(() => {
    if (!initialised) { tryInit(); return; }
    snapTo(posFromReal(currentReal));
  });
  ro.observe(track);

  // Live counter update on every scroll tick — gives immediate feedback
  // mid-swipe rather than waiting for scroll to fully settle.
  const onScroll = () => {
    const w = track.clientWidth;
    if (w === 0) return;
    const pos = Math.round(track.scrollLeft / w);
    const real = realFromPos(pos);
    if (real !== currentReal) {
      currentReal = real;
      writeCounter();
      if (onIndexChange) onIndexChange(currentReal);
    }
  };
  track.addEventListener('scroll', onScroll, { passive: true });

  // When scroll settles on a clone, instantly warp to the real position of
  // the image the clone is duplicating. Visually identical (same image
  // pixels), so the wrap looks seamless.
  const detach = onScrollEnd(track, () => {
    const w = track.clientWidth;
    if (w === 0) return;
    const pos = Math.round(track.scrollLeft / w);
    if (pos === 0) snapTo(images.length);
    else if (pos === images.length + 1) snapTo(1);
  });

  return {
    step: (dir) => {
      const w = track.clientWidth;
      if (w === 0) return;
      const pos = Math.round(track.scrollLeft / w);
      animateTo(pos + dir);
    },
    goTo: (realIdx) => {
      const clamped = Math.max(0, Math.min(realIdx, images.length - 1));
      currentReal = clamped;
      snapTo(posFromReal(clamped));
      writeCounter();
    },
    getIndex: () => currentReal,
    destroy: () => {
      track.removeEventListener('scroll', onScroll);
      detach();
      ro.disconnect();
    },
  };
}
