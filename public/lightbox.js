// Fullscreen image carousel modal ("lightbox") shared by the dashboard and
// the item-audit page. Click on any thumbnail's image opens it here so users
// can see the full uploaded photo without the cropping the inline carousels
// apply.
//
// Usage from a module script:
//   import { openImageLightbox } from '/lightbox.js';
//   openImageLightbox(urls, startIndex, alt, { onClose: (realIdx) => ... });
//
// One persistent <div class="lightbox"> is lazy-mounted to <body> on first
// open and reused thereafter. The carousel mechanics (clone-pad cycling,
// counter, swipe physics) are delegated to attachCyclingCarousel so this
// module only handles modal chrome (backdrop, close, keyboard, focus).

import { attachCyclingCarousel } from '/carousel.js';

let root = null;
let track = null;
let counter = null;
let closeBtn = null;
let prevBtn = null;
let nextBtn = null;

let carousel = null; // current attached carousel, destroyed on close
let onCloseFn = null;
let lastFocus = null;

function ensureMounted() {
  if (root) return;
  root = document.createElement('div');
  root.className = 'lightbox';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Image viewer');
  root.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="Close">×</button>
    <button class="lightbox-nav lightbox-prev" type="button" aria-label="Previous image">‹</button>
    <button class="lightbox-nav lightbox-next" type="button" aria-label="Next image">›</button>
    <div class="lightbox-track" tabindex="-1"></div>
    <div class="lightbox-counter" aria-hidden="true"></div>
  `;
  document.body.appendChild(root);
  track = root.querySelector('.lightbox-track');
  counter = root.querySelector('.lightbox-counter');
  closeBtn = root.querySelector('.lightbox-close');
  prevBtn = root.querySelector('.lightbox-prev');
  nextBtn = root.querySelector('.lightbox-next');

  closeBtn.addEventListener('click', close);
  // Backdrop click closes (clicks on controls stopPropagation so they don't
  // bubble up here).
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  prevBtn.addEventListener('click', (e) => { e.stopPropagation(); carousel?.step(-1); });
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); carousel?.step(1); });
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); carousel?.step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); carousel?.step(1); }
}

function close() {
  if (!root || root.hidden) return;
  // Capture the final real index BEFORE we tear the carousel down so the
  // caller can sync their inline gallery to where the user landed.
  const finalIdx = carousel?.getIndex() ?? 0;
  carousel?.destroy();
  carousel = null;

  root.hidden = true;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onKey);
  if (lastFocus && typeof lastFocus.focus === 'function') {
    try { lastFocus.focus(); } catch { /* opener unmounted, ignore */ }
  }
  lastFocus = null;

  const cb = onCloseFn;
  onCloseFn = null;
  if (cb) cb(finalIdx);
}

export function openImageLightbox(urls, startIndex = 0, alt = '', opts = {}) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  ensureMounted();
  onCloseFn = opts.onClose ?? null;
  lastFocus = document.activeElement;

  // Tear down any previous carousel (in case the lightbox was reopened
  // before closing — shouldn't happen in normal flow but defensive).
  if (carousel) { carousel.destroy(); carousel = null; }

  // Single image: no nav UI, no counter.
  root.classList.toggle('lightbox-single', urls.length <= 1);

  // Show the modal BEFORE attaching the carousel so the track has layout
  // and the carousel can compute clientWidth on init. (The helper also has
  // a ResizeObserver fallback, so this isn't strictly required, but it
  // avoids one frame of misalignment.)
  root.hidden = false;
  document.body.style.overflow = 'hidden';

  carousel = attachCyclingCarousel(track, {
    images: urls,
    alt,
    counterEl: counter,
    startIndex,
  });

  document.addEventListener('keydown', onKey);
  if (closeBtn) closeBtn.focus();
}
