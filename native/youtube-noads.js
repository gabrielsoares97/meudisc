// Roda dentro das páginas do navegador compartilhado (antes do site), só no YouTube.
// Quando entra anúncio: deixa mudo, pula para o fim, clica em "Pular" e esconde banners.
'use strict';

(() => {
  if (window !== window.top || !/(^|\.)youtube\.com$/.test(location.hostname)) return;

  const SKIP = [
    '.ytp-skip-ad-button', '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-slot button', 'button[id^="skip-button"]',
  ];
  const HIDE = [
    '#player-ads', '#masthead-ad', '.ytp-ad-overlay-container', '.ytp-ad-text-overlay', '.ytp-ad-image-overlay',
    'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', 'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer', 'ytd-display-ad-renderer', 'ytd-banner-promo-renderer',
    'ytd-compact-promoted-video-renderer', 'ytd-action-companion-ad-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer', 'ytd-statement-banner-renderer',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)', 'ytd-reel-video-renderer:has(.ytd-ad-slot-renderer)',
    'tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)', 'ytd-enforcement-message-view-model',
  ];

  let inAd = false;
  let adSince = 0;
  let mutedBefore = false;
  let rateBefore = 1;

  function addStyle() {
    if (document.getElementById('meudisc-sem-anuncios')) return;
    const root = document.head || document.documentElement;
    if (!root) return;
    const s = document.createElement('style');
    s.id = 'meudisc-sem-anuncios';
    s.textContent = `${HIDE.join(',')}{display:none!important}`;
    root.appendChild(s);
  }

  function tick() {
    addStyle();
    const player = document.querySelector('#movie_player, .html5-video-player');
    const video = player && player.querySelector('video');
    const ad = !!(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
    if (ad && video) {
      if (!inAd) {
        inAd = true;
        adSince = Date.now();
        mutedBefore = video.muted;
        rateBefore = video.playbackRate || 1;
      }
      // Anúncio mudo e acelerado: termina sozinho em ~1 s (pular direto para o fim
      // às vezes deixa o YouTube parado alguns segundos).
      video.muted = true;
      if (video.playbackRate !== 16) video.playbackRate = 16;
      if (video.paused) video.play().catch(() => {});
      for (const sel of SKIP) document.querySelectorAll(sel).forEach((b) => b.click());
      // Se mesmo assim travar, vai para o fim.
      if (Date.now() - adSince > 3000 && Number.isFinite(video.duration) && video.duration > 0
        && video.currentTime < video.duration - 0.2) {
        video.currentTime = video.duration;
      }
    } else if (inAd) {
      inAd = false;
      if (video) {
        video.muted = mutedBefore;
        video.playbackRate = rateBefore;
      }
      // Registro simples (quantos anúncios e quanto tempo durou o último), para diagnóstico.
      const d = document.documentElement.dataset;
      d.meudiscAnuncios = String((Number(d.meudiscAnuncios) || 0) + 1);
      d.meudiscUltimoAnuncioMs = String(Date.now() - adSince);
    }
    // Aviso de "bloqueadores de anúncios não são permitidos": fecha e volta a tocar.
    const warn = document.querySelector('ytd-enforcement-message-view-model');
    if (warn) {
      const dialog = warn.closest('tp-yt-paper-dialog');
      if (dialog) dialog.remove();
      document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach((e) => e.remove());
      if (video && video.paused) video.play().catch(() => {});
    }
  }

  setInterval(tick, 250);
  document.addEventListener('DOMContentLoaded', tick);
})();
