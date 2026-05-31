// Fullscreen image carousel modal ("lightbox") shared by the dashboard and
// the item-audit page. Click on any thumbnail's image opens it here so users
// can see the full uploaded photo without the 4:3 / square cropping the
// inline carousels apply.
//
// Usage from a module script:
//   import { openImageLightbox } from '/lightbox.js';
//   openImageLightbox(['url1', 'url2', ...], startIndex, alt);
//
// One persistent <div class="lightbox"> is lazy-mounted to <body> on first
// open and reused thereafter. Close on: ESC, backdrop click, or × button.
// Keyboard ← / → flip slides. Touch users swipe via the existing CSS
// scroll-snap track.

let root = null;
let track = null;
let counter = null;
let images = [];
let lastFocus = null;

function ensureMounted() {
  if (root) return;
  root = document.createElement('div');
  root.className = 'lightbox';
  root.hidden = true;
  // role=dialog + aria-modal so AT users understand they're in a modal layer.
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

  const closeBtn = root.querySelector('.lightbox-close');
  const prevBtn = root.querySelector('.lightbox-prev');
  const nextBtn = root.querySelector('.lightbox-next');

  closeBtn.addEventListener('click', close);
  // Backdrop click (anywhere on the root element that isn't a control or the
  // image track) closes the modal. Buttons stopPropagation so they don't
  // double-trigger close when clicked.
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  prevBtn.addEventListener('click', (e) => { e.stopPropagation(); step(-1); });
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); step(1); });

  // Update the counter as the user scrolls / swipes.
  track.addEventListener('scroll', () => {
    const idx = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    if (counter && images.length) counter.textContent = `${idx + 1} / ${images.length}`;
  }, { passive: true });

  // Keyboard handler is attached when the modal opens and removed on close
  // so it doesn't compete with page-level shortcuts while idle.
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    step(-1);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    step(1);
  }
}

function step(dir) {
  if (!track) return;
  const w = track.clientWidth;
  track.scrollBy({ left: dir * w, behavior: 'smooth' });
}

function close() {
  if (!root || root.hidden) return;
  root.hidden = true;
  // Don't leave the page scroll-locked.
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onKey);
  if (lastFocus && typeof lastFocus.focus === 'function') {
    try { lastFocus.focus(); } catch { /* ignore — element may have unmounted */ }
  }
  lastFocus = null;
}

export function openImageLightbox(urls, startIndex = 0, alt = '') {
  if (!Array.isArray(urls) || urls.length === 0) return;
  ensureMounted();
  images = urls.slice();
  lastFocus = document.activeElement;

  // Re-render the track with the requested image set. Build via createElement
  // so we don't have to worry about escaping the URLs into HTML.
  track.replaceChildren();
  for (const src of images) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.draggable = false;
    img.loading = 'lazy';
    track.appendChild(img);
  }

  // Scroll to the requested image *before* the modal becomes visible — once
  // visible we want the snap to be already in place, not a smooth animation
  // from the first slide.
  const clamped = Math.max(0, Math.min(startIndex, images.length - 1));
  root.hidden = false;
  document.body.style.overflow = 'hidden';
  // Defer the scroll until layout settles (the track has zero width while
  // hidden). Direct scrollLeft assignment (not scrollTo with behavior) so
  // it's instant — we don't want a smooth animation from slide 0 to the
  // user's chosen slide as the modal appears.
  requestAnimationFrame(() => {
    track.scrollLeft = clamped * track.clientWidth;
    if (counter) counter.textContent = `${clamped + 1} / ${images.length}`;
  });

  // Hide nav + counter when there's only one image — same convention as the
  // inline gallery.
  const single = images.length <= 1;
  root.classList.toggle('lightbox-single', single);

  document.addEventListener('keydown', onKey);
  // Focus moves into the modal so keyboard users can immediately use arrows
  // / ESC. The close button is a sensible focus target.
  const closeBtn = root.querySelector('.lightbox-close');
  if (closeBtn) closeBtn.focus();
}
