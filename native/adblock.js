// Bloqueador de anúncios do navegador compartilhado.
// - Listas do uBlock Origin / EasyList (via @ghostery/adblocker) para os sites em geral.
// - No YouTube, que entrega anúncio pelo mesmo servidor dos vídeos, um script que
//   detecta o anúncio, deixa mudo, pula para o fim e clica em "Pular".
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CACHE_DAYS = 3;
const isYouTube = (url) => {
  try {
    return /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};
let blockerPromise = null;
let blocked = 0;
const skipperIds = new Map(); // sessão -> id do script do YouTube

function getBlocker() {
  if (!blockerPromise) {
    blockerPromise = (async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const file = path.join(app.getPath('userData'), 'bloqueador-anuncios.bin');
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > CACHE_DAYS * 86400e3) fs.unlinkSync(file);
      } catch { /* sem cache ainda */ }
      const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: file,
        read: fs.promises.readFile,
        write: fs.promises.writeFile,
      });
      blocker.on('request-blocked', () => { blocked++; });
      blocker.on('request-redirected', () => { blocked++; });
      // No YouTube não bloqueia nada: bloquear faz o YouTube detectar e atrasar os
      // vídeos ("Enfrentando interrupções?"). Lá quem age é o pulador de anúncios.
      const onRequest = blocker.onBeforeRequest;
      blocker.onBeforeRequest = (details, callback) => {
        const top = details.frame && details.frame.top ? details.frame.top.url : '';
        if (isYouTube(top) || isYouTube(details.referrer) || isYouTube(details.url)) {
          callback({});
          return;
        }
        onRequest(details, callback);
      };
      const onCosmetics = blocker.onInjectCosmeticFilters;
      blocker.onInjectCosmeticFilters = async (event, url, msg) => {
        if (isYouTube(url)) return undefined;
        return onCosmetics(event, url, msg);
      };
      return blocker;
    })().catch((e) => {
      blockerPromise = null;
      throw e;
    });
  }
  return blockerPromise;
}

function setSkipper(ses, on) {
  const id = skipperIds.get(ses);
  if (on && id === undefined) {
    skipperIds.set(ses, ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'youtube-noads.js') }));
  } else if (!on && id !== undefined) {
    ses.unregisterPreloadScript(id);
    skipperIds.delete(ses);
  }
}

// Liga/desliga para a sessão do navegador. Devolve se as listas estão ativas
// (o pulador do YouTube funciona mesmo se as listas não baixarem).
async function setAdblock(ses, on) {
  setSkipper(ses, on);
  try {
    const blocker = await getBlocker();
    if (on && !blocker.isBlockingEnabled(ses)) blocker.enableBlockingInSession(ses);
    if (!on && blocker.isBlockingEnabled(ses)) blocker.disableBlockingInSession(ses);
    return { on, lists: on };
  } catch (e) {
    console.warn('[anúncios] listas indisponíveis:', e.message);
    return { on, lists: false };
  }
}

const blockedCount = () => blocked;

module.exports = { setAdblock, blockedCount };
