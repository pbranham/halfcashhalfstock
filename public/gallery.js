import { openImageLightbox } from '/lightbox.js';
import { attachCyclingCarousel } from '/carousel.js';
import { el, hiResImg } from '/shared.js';

// Build a cycling image carousel for an item's gallery — the one used by the
// dashboard tiles and the item page header. Pass `[primary, ...additional]`.
// The track wrap-cycles in both directions (swipe past either end → other
// end) and clicking an image opens the lightbox at the same index; when the
// lightbox closes, the inline gallery jumps to whatever image the user was
// on in the modal so they stay continuous. With `keyboard`, the gallery is
// focusable: arrow keys flip slides, Enter/Space opens the lightbox.
export function imageGallery(images, alt, { keyboard = false } = {}) {
  const cleaned = (images || []).filter(Boolean).map((u) => hiResImg(u));
  // Dedupe while preserving order so a listing whose primary equals
  // additional[0] doesn't flash the same image twice.
  const seen = new Set();
  const ordered = [];
  for (const u of cleaned) {
    if (seen.has(u)) continue;
    seen.add(u);
    ordered.push(u);
  }
  const single = ordered.length <= 1;
  const wrap = el('div', { class: `item-gallery${single ? ' single-image' : ''}` });
  if (ordered.length === 0) return wrap;

  const track = el('div', { class: 'gallery-track' });
  wrap.appendChild(track);
  // Counter goes on every gallery (consistent indicator regardless of how
  // many images the listing has — eBay caps at 24, which would overflow
  // any dot strip on a 160px tile).
  const counter = el('div', { class: 'gallery-counter', 'aria-hidden': 'true' });
  wrap.appendChild(counter);

  const prev = el('button', { class: 'gallery-nav gallery-prev', type: 'button', 'aria-label': 'Previous image', textContent: '‹' });
  const next = el('button', { class: 'gallery-nav gallery-next', type: 'button', 'aria-label': 'Next image', textContent: '›' });
  if (!single) wrap.append(prev, next);

  const carousel = attachCyclingCarousel(track, {
    images: ordered,
    alt: alt || '',
    counterEl: counter,
  });
  prev.addEventListener('click', (e) => { e.stopPropagation(); carousel.step(-1); });
  next.addEventListener('click', (e) => { e.stopPropagation(); carousel.step(1); });

  // Open the lightbox at the currently-visible slide; when it closes, jump
  // this inline carousel to the index the user landed on.
  const openLightbox = () => {
    openImageLightbox(ordered, carousel.getIndex(), alt || '', {
      onClose: (finalIdx) => carousel.goTo(finalIdx),
    });
  };
  track.style.cursor = 'zoom-in';
  track.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLImageElement)) return;
    e.stopPropagation();
    openLightbox();
  });

  if (keyboard && !single) {
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Image gallery — use arrow keys to browse');
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        carousel.step(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        carousel.step(1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openLightbox();
      }
    });
  }
  return wrap;
}
