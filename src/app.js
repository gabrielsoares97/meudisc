'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const desktop = window.desktop || null;
  // App de celular (Android): ponte com o sistema para convite, notificação da sala e botão voltar.
  const android = window.MeuDiscAndroid || null;
  const platform = desktop
    ? desktop.platform
    : android ? 'android' : /Mac/i.test(navigator.platform) ? 'darwin' : /Win/i.test(navigator.platform) ? 'win32' : 'other';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- constantes
  // v2: salas de até 8 pessoas. Cada pessoa se conecta direto com todas as outras.
  const PREFIX = 'meudisc-v2-';
  const MAX_PEOPLE = 8;
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 6;
  // Cada conexão tem 4 "canais" fixos, na mesma ordem dos dois lados.
  const ROLES = ['mic', 'cam', 'screen', 'screenAudio'];
  const KIND = { mic: 'audio', cam: 'video', screen: 'video', screenAudio: 'audio' };
  const RES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 0: null };
  const DEFAULT_RATE = { // Mb/s sugeridos por resolução e fps
    720: { 30: 4, 60: 6, 120: 10 },
    1080: { 30: 8, 60: 12, 120: 20 },
    1440: { 30: 12, 60: 20, 120: 32 },
    0: { 30: 12, 60: 20, 120: 32 },
  };
  const BASE_ICE = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Relay gratuito do PeerJS: só é usado se a conexão direta não for possível.
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  ];
  const AVATAR_COLORS = ['#f5a524', '#7cc4ff', '#ff8fa3', '#8be3b5', '#c7a6ff', '#ffd166'];

  // ---------------------------------------------------------------- preferências
  const DEFAULTS = {
    name: '', micId: '', camId: '', speakerId: '',
    turnUrl: '', turnUser: '', turnPass: '',
    screenVol: 1, screenMuted: false, vols: {},
    share: { res: '1080', fps: 120, mode: 'motion', rate: 20, codec: 'auto', audio: true },
  };
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('meudisc:settings') || '{}');
      return { ...DEFAULTS, ...s, vols: { ...(s.vols || {}) }, share: { ...DEFAULTS.share, ...(s.share || {}) } };
    } catch {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }
  function saveSettings() {
    try { localStorage.setItem('meudisc:settings', JSON.stringify(settings)); } catch { /* sem armazenamento */ }
  }
  const settings = loadSettings();

  // ---------------------------------------------------------------- estado
  const S = {
    code: '',
    inRoom: false,
    joining: false,
    joinTimer: 0,
    peer: null,          // Peer principal (id aleatório): conexões com as outras pessoas
    anchor: null,        // Peer com o id da sala: só entrega a lista de quem está na sala
    claiming: false,
    lobby: null,
    links: new Map(),    // id da outra pessoa -> conexão com ela
    heard: new Map(),    // ids que outras pessoas conhecem e nós ainda não
    gone: new Map(),     // quem saiu há pouco (não reconectar)
    local: { mic: null, cam: null, screen: null, screenAudio: null },
    micOn: false,
    startingShare: false,
    shareInfo: null,
    native: null,        // captura direta da tela inteira (Windows/DXGI) em andamento
    pointer: null,       // posição do mouse na tela transmitida (captura direta)
    pointerSentAt: 0,
    watching: null,      // id de quem você está assistindo
    dismissed: new Set(),
    timers: [],
    beat: 0,
    unread: 0,
    tx: { limitedFor: 0, limitReason: '' },
  };
  window.__meudisc = S; // para depuração no DevTools

  // ---------------------------------------------------------------- elementos
  const el = {
    home: $('home'), room: $('room'),
    nameInput: $('name-input'), codeInput: $('code-input'), createBtn: $('create-btn'),
    joinForm: $('join-form'), joinBtn: $('join-btn'), homeError: $('home-error'),
    roomCode: $('room-code'), waitingCode: $('waiting-code'), connStatus: $('conn-status'), connText: $('conn-text'),
    stage: $('stage'), people: $('people'), screenView: $('screen-view'), localShareView: $('local-share-view'),
    remoteScreen: $('remote-screen'), localScreen: $('local-screen'), localCam: $('local-cam'),
    tileMe: $('tile-me'), nameMe: $('name-me'), avatarMe: $('avatar-me'), inviteTile: $('invite-tile'), tileTpl: $('tile-tpl'),
    micBtn: $('mic-btn'), camBtn: $('cam-btn'), shareBtn: $('share-btn'), shareBtnLabel: $('share-btn-label'),
    chatBtn: $('chat-btn'), chatBadge: $('chat-badge'), leaveBtn: $('leave-btn'),
    chat: $('chat'), chatLog: $('chat-log'), chatForm: $('chat-form'), chatInput: $('chat-input'),
    screenCaption: $('screen-caption'), screenVolWrap: $('screen-vol-wrap'), screenVol: $('screen-vol'),
    screenMute: $('screen-mute'), screenAudioStatus: $('screen-audio-status'),
    shareName: $('share-name'), txViewers: $('tx-viewers'), txFps: $('tx-fps'), txRes: $('tx-res'), txRate: $('tx-rate'), txEnc: $('tx-enc'), txHint: $('tx-hint'),
    txCapture: $('tx-capture'), txSound: $('tx-sound'), remoteCursor: $('remote-cursor'),
    optAudioTitle: $('opt-audio-title'), optAudioHelp: $('opt-audio-help'),
    browserBtn: $('browser-btn'), browserBtnLabel: $('browser-btn-label'), browserView: $('browser-view'),
    bBack: $('b-back'), bForward: $('b-forward'), bReload: $('b-reload'), bForm: $('b-form'), bUrl: $('b-url'),
    bOwner: $('b-owner'), bAllow: $('b-allow'), bClose: $('b-close'), bLeave: $('b-leave'), bSurface: $('b-surface'), bLocked: $('b-locked'),
    browserVideo: $('browser-video'), browserAudio: $('browser-audio'),
    bAdblock: $('b-adblock'), bAdblockLabel: $('b-adblock-label'), bMute: $('b-mute'), bVol: $('b-vol'), bFullscreen: $('b-fullscreen'),
    bKeyboard: $('b-keyboard'), bIme: $('b-ime'),
    shareDialog: $('share-dialog'), sourceGrid: $('source-grid'), sourceTabs: $('source-tabs'), sourceArea: $('source-area'),
    refreshSources: $('refresh-sources'),
    sourceBrowserNote: $('source-browser-note'), shareGo: $('share-go'), shareError: $('share-error'),
    optRes: $('opt-res'), optFps: $('opt-fps'), optMode: $('opt-mode'), optRate: $('opt-rate'), optRateOut: $('opt-rate-out'),
    optCodec: $('opt-codec'), optAudio: $('opt-audio'), optAudioWrap: $('opt-audio-wrap'),
    settingsDialog: $('settings-dialog'), macScreenDialog: $('mac-screen-dialog'),
    toasts: $('toasts'),
  };

  // ---------------------------------------------------------------- utilidades
  function toast(text, isError = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (isError ? ' err' : '');
    t.textContent = text;
    el.toasts.append(t);
    setTimeout(() => t.remove(), isError ? 6000 : 3200);
  }

  function randomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
    return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  }

  function normalizeCode(text) {
    const up = String(text || '').toUpperCase();
    const exact = up.match(new RegExp(`\\b[${ALPHABET}]{${CODE_LEN}}\\b`));
    if (exact) return exact[0];
    return up.replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
  }

  const cleanName = (n) => String(n || '').trim().slice(0, 24) || 'Amigo';
  const myName = () => cleanName(settings.name || el.nameInput.value);
  const myId = () => (S.peer && S.peer.id) || '';
  const welcomedLinks = () => [...S.links.values()].filter((l) => l.welcomed);
  const listNames = (links) => links.map((l) => l.name).join(', ');

  function initials(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function colorFor(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function iceServers() {
    const list = BASE_ICE.slice();
    if (settings.turnUrl.trim()) {
      list.push({ urls: settings.turnUrl.trim(), username: settings.turnUser, credential: settings.turnPass });
    }
    return list;
  }

  const fmtRate = (bps) => `${(bps / 1e6).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Mb/s`;

  async function copyInvite() {
    const text = `Bora no MeuDisc! Abre o app e entra na minha sala com o código ${S.code}`;
    // No celular abre o menu de compartilhar (WhatsApp etc.), que também tem "Copiar".
    if (android) { android.shareText(text); return; }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Convite copiado. Agora é só colar para seus amigos.');
  }

  // Sons curtos para entrada, saída e mensagem.
  let audioCtx = null;
  function ctx() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  function tone(kind) {
    try {
      const c = ctx();
      const notes = kind === 'join' ? [587, 880] : kind === 'leave' ? [740, 494] : [988];
      const t0 = c.currentTime + 0.02;
      notes.forEach((f, i) => {
        const o = c.createOscillator();
        const g = c.createGain();
        const t = t0 + i * 0.11;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.08, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.connect(g).connect(c.destination);
        o.start(t);
        o.stop(t + 0.25);
      });
    } catch { /* sem áudio */ }
  }

  // ---------------------------------------------------------------- SDP
  // Faz o controle de banda começar alto (em vez de ~300 kb/s) e libera áudio estéreo.
  function boostSdp(sdp) {
    const nl = sdp.includes('\r\n') ? '\r\n' : '\n';
    const lines = sdp.split(nl);
    const videoPts = new Set();
    const opusPts = new Set();
    const withFmtp = new Set();
    for (const l of lines) {
      let m = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\/90000/i.exec(l);
      if (m) videoPts.add(m[1]);
      m = /^a=rtpmap:(\d+) opus\/48000/i.exec(l);
      if (m) opusPts.add(m[1]);
      m = /^a=fmtp:(\d+) /.exec(l);
      if (m) withFmtp.add(m[1]);
    }
    const VIDEO_X = 'x-google-start-bitrate=10000;x-google-min-bitrate=600;x-google-max-bitrate=80000';
    const OPUS_X = 'stereo=1;sprop-stereo=1';
    const out = [];
    for (const l of lines) {
      const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (f && videoPts.has(f[1]) && !f[2].includes('x-google-')) { out.push(`${l};${VIDEO_X}`); continue; }
      if (f && opusPts.has(f[1]) && !/(^|;)stereo=/.test(f[2])) { out.push(`${l};${OPUS_X}`); continue; }
      out.push(l);
      const r = /^a=rtpmap:(\d+) /.exec(l);
      if (r && videoPts.has(r[1]) && !withFmtp.has(r[1])) out.push(`a=fmtp:${r[1]} ${VIDEO_X}`);
    }
    return out.join(nl);
  }

  function codecOrder(pref) {
    const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
    if (!caps) return null;
    const want = ['H264', 'VP8', 'VP9', 'AV1'];
    if (pref && pref !== 'auto') want.unshift(pref);
    const rank = (c) => {
      const i = want.indexOf(c.mimeType.split('/')[1].toUpperCase());
      return i === -1 ? 99 : i;
    };
    return caps.codecs.slice().sort((a, b) => rank(a) - rank(b));
  }

  // Câmeras em VP8 (processador) deixam o codificador da placa de vídeo livre para as telas,
  // que podem precisar de uma cópia por pessoa assistindo.
  function applyCodecPrefs(pc) {
    const trs = pc.getTransceivers();
    [['cam', 'VP8'], ['screen', settings.share.codec]].forEach(([role, pref]) => {
      const tr = trs[ROLES.indexOf(role)];
      const order = codecOrder(pref);
      if (tr && order && tr.setCodecPreferences) {
        try { tr.setCodecPreferences(order); } catch (e) { console.warn('codec prefs', e); }
      }
    });
  }

  // ---------------------------------------------------------------- PeerJS
  function peerOpts() {
    return { config: { iceServers: iceServers() }, debug: 1 };
  }

  function openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, peerOpts()) : new Peer(peerOpts());
      const done = () => { clearTimeout(timer); peer.off('open', onOpen); peer.off('error', onErr); };
      const onOpen = () => { done(); resolve(peer); };
      const onErr = (err) => { done(); peer.destroy(); reject(err); };
      const timer = setTimeout(() => onErr(Object.assign(new Error('timeout'), { type: 'timeout' })), 15000);
      peer.on('open', onOpen);
      peer.on('error', onErr);
    });
  }

  function peerErrorText(err) {
    switch (err && err.type) {
      case 'browser-incompatible': return 'Este navegador não suporta chamadas. Use o app do MeuDisc, Chrome ou Edge.';
      case 'network': case 'socket-error': case 'socket-closed': case 'server-error': case 'timeout':
        return 'Não foi possível falar com o servidor de salas. Confira sua internet e tente de novo.';
      case 'peer-unavailable': return 'Sala não encontrada. Confira o código ou peça para alguém criar a sala de novo.';
      default: return `Algo deu errado (${(err && (err.type || err.message)) || 'erro desconhecido'}). Tente de novo.`;
    }
  }

  function watchPeer(peer) {
    peer.on('disconnected', () => {
      setTimeout(() => {
        if ((S.peer === peer || S.anchor === peer) && !peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); } catch { /* tenta de novo no próximo aviso */ }
        }
      }, 1500);
    });
    peer.on('error', (err) => {
      console.warn('peer error', err.type, err.message);
      if (S.peer === peer && err.type === 'peer-unavailable' && S.joining
        && String(err.message || '').includes(PREFIX + S.code)) {
        failJoin(peerErrorText(err));
      }
    });
  }

  // ---------------------------------------------------------------- criar / entrar
  function requireName() {
    const n = el.nameInput.value.trim();
    if (!n) {
      showHomeError('Escreva seu nome primeiro. É assim que seus amigos vão te ver.');
      el.nameInput.focus();
      return false;
    }
    settings.name = n.slice(0, 24);
    saveSettings();
    return true;
  }

  function showHomeError(text) {
    el.homeError.textContent = text || '';
  }

  function setHomeBusy(busy, which) {
    el.createBtn.disabled = busy;
    el.joinBtn.disabled = busy;
    el.createBtn.textContent = busy && which === 'create' ? 'Criando sala…' : 'Criar sala';
    el.joinBtn.textContent = busy && which === 'join' ? 'Entrando…' : 'Entrar';
  }

  async function createRoom() {
    if (!requireName()) return;
    showHomeError('');
    setHomeBusy(true, 'create');
    let anchor = null;
    let code = '';
    try {
      for (let attempt = 0; attempt < 4 && !anchor; attempt++) {
        code = randomCode();
        try {
          anchor = await openPeer(PREFIX + code);
        } catch (err) {
          if (err.type !== 'unavailable-id') throw err;
        }
      }
      if (!anchor) throw Object.assign(new Error('sem código livre'), { type: 'server-error' });
      const peer = await openPeer(null);
      S.peer = peer;
      watchPeer(peer);
      peer.on('connection', onIncomingConnection);
      setAnchor(anchor);
      enterRoom(code);
    } catch (err) {
      if (anchor && S.anchor !== anchor) anchor.destroy();
      showHomeError(peerErrorText(err));
    } finally {
      setHomeBusy(false);
    }
  }

  async function joinRoom(code) {
    if (!requireName()) return;
    if (code.length !== CODE_LEN) return showHomeError(`O código tem ${CODE_LEN} letras e números.`);
    showHomeError('');
    setHomeBusy(true, 'join');
    S.joining = true;
    S.code = code;
    let peer;
    try {
      peer = await openPeer(null);
    } catch (err) {
      S.joining = false;
      S.code = '';
      setHomeBusy(false);
      return showHomeError(peerErrorText(err));
    }
    if (!S.joining) { peer.destroy(); return; }
    S.peer = peer;
    watchPeer(peer);
    peer.on('connection', onIncomingConnection);

    // Primeiro pergunta para a sala quem já está lá; depois conecta com cada pessoa.
    const lobby = peer.connect(PREFIX + code, { reliable: true, serialization: 'json', metadata: { lobby: true } });
    S.lobby = lobby;
    lobby.on('data', (m) => {
      if (!S.joining || !m || typeof m !== 'object') return;
      if (m.t === 'full') { failJoin(`Essa sala já está cheia (${MAX_PEOPLE} pessoas).`); return; }
      if (m.t !== 'roster' || !Array.isArray(m.members)) return;
      const members = m.members
        .filter((x) => x && typeof x.id === 'string' && x.id !== peer.id)
        .slice(0, MAX_PEOPLE);
      if (members.length >= MAX_PEOPLE) { failJoin(`Essa sala já está cheia (${MAX_PEOPLE} pessoas).`); return; }
      S.joining = false;
      clearTimeout(S.joinTimer);
      setHomeBusy(false);
      try { lobby.close(); } catch { /* ok */ }
      S.lobby = null;
      enterRoom(code);
      addSystemChat(members.length
        ? `Você entrou na sala. Estão aqui: ${members.map((x) => cleanName(x.name)).join(', ')}.`
        : 'Você entrou na sala.');
      for (const mb of members) connectTo(mb.id, mb.name, true);
    });
    S.joinTimer = setTimeout(() => {
      if (S.joining) failJoin('Não deu para entrar na sala. Confira o código e se alguém está com a sala aberta.');
    }, 25000);
  }

  function failJoin(text) {
    resetSession();
    setHomeBusy(false);
    showHome();
    showHomeError(text);
  }

  // ---------------------------------------------------------------- código da sala (âncora)
  // Quem segura o código só entrega a lista de presentes para quem chega.
  // Se essa pessoa sair, a próxima da lista assume o código.
  function setAnchor(p) {
    S.anchor = p;
    watchPeer(p);
    p.on('connection', onLobbyConnection);
    p.on('error', (err) => {
      if (S.anchor === p && err.type === 'unavailable-id') { S.anchor = null; p.destroy(); }
    });
    p.on('close', () => { if (S.anchor === p) S.anchor = null; });
    sendStates();
  }

  function roster() {
    const list = [{ id: myId(), name: myName() }];
    for (const l of welcomedLinks()) list.push({ id: l.id, name: l.name });
    return list;
  }

  function onLobbyConnection(conn) {
    conn.on('open', () => {
      const members = roster();
      try {
        conn.send(members.length >= MAX_PEOPLE ? { t: 'full' } : { t: 'roster', members, max: MAX_PEOPLE });
      } catch { /* ok */ }
      setTimeout(() => { try { conn.close(); } catch { /* ok */ } }, 4000);
    });
    conn.on('error', () => {});
  }

  function anchorHeld() {
    if (S.anchor) return true;
    return welcomedLinks().some((l) => l.remote.anchor);
  }

  function checkAnchor() {
    if (!S.inRoom || !S.peer || S.anchor || S.claiming || anchorHeld()) return;
    const ids = [myId(), ...welcomedLinks().map((l) => l.id)].sort();
    if (ids[0] === myId()) claimAnchor();
  }

  async function claimAnchor() {
    S.claiming = true;
    const code = S.code;
    for (let i = 0; i < 30 && S.inRoom && S.code === code && !S.anchor; i++) {
      if (welcomedLinks().some((l) => l.remote.anchor)) break;
      try {
        const p = await openPeer(PREFIX + code);
        if (!S.inRoom || S.code !== code) { p.destroy(); break; }
        setAnchor(p);
        break;
      } catch (err) {
        if (err.type !== 'unavailable-id') console.warn('âncora', err.type);
        await sleep(3000);
      }
    }
    S.claiming = false;
  }

  // ---------------------------------------------------------------- conexões com cada pessoa
  function onIncomingConnection(conn) {
    if (!S.inRoom && !S.joining) { try { conn.close(); } catch { /* ok */ } return; }
    const id = conn.peer;
    const existing = S.links.get(id);
    let preexisting = false;
    if (existing) {
      // Os dois abriram conexão ao mesmo tempo: fica a de quem tem o menor id.
      if (existing.initiator && myId() < id) { try { conn.close(); } catch { /* ok */ } return; }
      preexisting = existing.welcomed;
      removeLink(existing, true);
    } else if (S.links.size >= MAX_PEOPLE - 1) {
      conn.on('open', () => {
        try { conn.send({ t: 'full' }); } catch { /* ok */ }
        setTimeout(() => { try { conn.close(); } catch { /* ok */ } }, 800);
      });
      return;
    }
    const link = newLink(id, conn, false, '');
    link.preexisting = preexisting;
  }

  function connectTo(id, name, preexisting) {
    if (!S.peer || !id || id === myId() || S.links.has(id)) return;
    if (S.links.size >= MAX_PEOPLE - 1) return;
    const conn = S.peer.connect(id, { reliable: true, serialization: 'json', metadata: { name: myName() } });
    const link = newLink(id, conn, true, name);
    link.preexisting = !!preexisting;
  }

  function emptyRemote() {
    return { mic: false, cam: false, screen: false, screenAudio: false, screenName: '', fps: 0, anchor: false, screenKind: '', browser: null };
  }

  function newLink(id, conn, initiator, name) {
    const link = {
      id, conn, initiator,
      offerer: !initiator,      // quem recebeu a conexão faz a oferta de mídia
      name: name ? cleanName(name) : '',
      welcomed: false, preexisting: false, created: Date.now(), lastSeen: Date.now(),
      pc: null, negotiated: false, connected: false, kind: '',
      sig: Promise.resolve(), pendingIce: [], restartTimer: 0,
      remote: emptyRemote(), watchingMe: false,
      streams: {}, prev: {}, ui: null,
    };
    link.ui = makeTile(link);
    S.links.set(id, link);
    conn.on('open', () => {
      if (link.conn !== conn) return;
      link.lastSeen = Date.now();
      if (link.initiator) sendTo(link, { t: 'hello', name: myName(), v: 2 });
    });
    conn.on('data', (m) => { if (link.conn === conn) onMessage(link, m); });
    conn.on('close', () => { if (link.conn === conn) removeLink(link, false); });
    conn.on('error', (e) => console.warn('conn', id, e && e.type));
    return link;
  }

  function sendTo(link, msg) {
    if (link && link.conn && link.conn.open) {
      try { link.conn.send(msg); } catch (e) { console.warn('send', e); }
    }
  }

  function removeLink(link, silent) {
    if (S.links.get(link.id) !== link) return;
    S.links.delete(link.id);
    const conn = link.conn;
    link.conn = null;
    clearTimeout(link.restartTimer);
    closePeerConnection(link);
    try { if (conn) conn.close(); } catch { /* ok */ }
    unwatchLevel(link.id);
    link.ui.tile.remove();
    S.dismissed.delete(link.id);
    if (!silent) S.gone.set(link.id, Date.now());
    if (S.watching === link.id) {
      S.watching = null;
      el.remoteScreen.srcObject = null;
      autoWatch();
    }
    if (link.welcomed && !silent) {
      tone('leave');
      toast(`${link.name} saiu da sala.`);
      addSystemChat(`${link.name} saiu da sala.`);
    }
    if (link.remote.anchor) setTimeout(checkAnchor, 300);
    retuneCams();
    updateUI();
  }

  function onMessage(link, m) {
    if (!m || typeof m !== 'object') return;
    link.lastSeen = Date.now();
    switch (m.t) {
      case 'hello':
        if (link.initiator || link.welcomed) return;
        link.name = cleanName(m.name);
        sendTo(link, { t: 'welcome', name: myName(), v: 2 });
        onWelcomed(link);
        break;
      case 'welcome':
        if (!link.initiator || link.welcomed) return;
        link.name = cleanName(m.name);
        onWelcomed(link);
        break;
      case 'full':
        removeLink(link, true);
        toast(`A sala está cheia (${MAX_PEOPLE} pessoas).`, true);
        break;
      case 'sdp':
        queueSignal(link, () => onRemoteDescription(link, m.d));
        break;
      case 'ice':
        queueSignal(link, () => onRemoteCandidate(link, m.c));
        break;
      case 'state':
        if (link.welcomed) applyRemoteState(link, m);
        break;
      case 'watch':
        setWatchingMe(link, !!m.on);
        break;
      case 'ptr':
        showRemotePointer(link, m);
        break;
      case 'bstate':
        link.remote.browser = cleanBrowserState(m.b);
        if (S.watching === link.id) updateBrowserBar();
        break;
      case 'bin':
        if (canControlMine(link) && m.e && typeof m.e === 'object') desktop.browser.input(m.e);
        break;
      case 'bnav':
        if (canControlMine(link)) desktop.browser.nav(String(m.a || ''), String(m.url || '').slice(0, 2000));
        break;
      case 'btext':
        if (canControlMine(link)) desktop.browser.text(String(m.text || '').slice(0, 5000));
        break;
      case 'chat':
        if (link.welcomed) addChat(link.name, String(m.text || '').slice(0, 1000), false);
        break;
      case 'bye':
        removeLink(link, false);
        break;
      default:
        break;
    }
  }

  function queueSignal(link, fn) {
    link.sig = link.sig.then(fn).catch((e) => console.warn('signal', e));
  }

  function onWelcomed(link) {
    link.welcomed = true;
    createPeerConnection(link);
    if (!link.preexisting) {
      tone('join');
      toast(`${link.name} entrou na sala.`);
      addSystemChat(`${link.name} entrou na sala.`);
    }
    sendStateTo(link);
    retuneCams();
    updateUI();
  }

  // ---------------------------------------------------------------- WebRTC (mídia)
  function createPeerConnection(link) {
    closePeerConnection(link);
    const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
    link.pc = pc;
    link.negotiated = false;
    link.connected = false;
    link.sig = Promise.resolve();
    link.pendingIce = [];
    link.prev = {};

    pc.onicecandidate = (e) => { if (e.candidate && link.pc === pc) sendTo(link, { t: 'ice', c: e.candidate.toJSON() }); };
    pc.ontrack = (e) => { if (link.pc === pc) onRemoteTrack(link, pc, e); };
    pc.onconnectionstatechange = () => { if (link.pc === pc) onConnectionState(link, pc); };
    pc.onnegotiationneeded = async () => {
      if (link.pc !== pc || !link.offerer) return;
      try {
        await pc.setLocalDescription();
        sendTo(link, { t: 'sdp', d: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      } catch (e) {
        console.warn('offer', e);
      }
    };

    if (link.offerer) {
      for (const role of ROLES) pc.addTransceiver(trackFor(link, role) || KIND[role], { direction: 'sendrecv' });
      applyCodecPrefs(pc);
    }
    return pc;
  }

  function closePeerConnection(link) {
    if (!link.pc) return;
    const pc = link.pc;
    link.pc = null;
    link.negotiated = false;
    link.connected = false;
    try { pc.close(); } catch { /* ok */ }
  }

  async function onRemoteDescription(link, d) {
    if (!d || !d.sdp || !link.welcomed) return;
    const pc = link.pc || createPeerConnection(link);
    if (d.type === 'offer') {
      if (link.offerer) return;
      await pc.setRemoteDescription({ type: 'offer', sdp: boostSdp(d.sdp) });
      const trs = pc.getTransceivers();
      await Promise.all(ROLES.map(async (role, i) => {
        const tr = trs[i];
        if (!tr) return;
        if (tr.direction !== 'sendrecv') tr.direction = 'sendrecv';
        const track = trackFor(link, role);
        if (tr.sender.track !== track) await tr.sender.replaceTrack(track);
      }));
      applyCodecPrefs(pc);
      await pc.setLocalDescription();
      sendTo(link, { t: 'sdp', d: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      await flushCandidates(link);
      onNegotiated(link);
    } else if (d.type === 'answer') {
      if (!link.offerer || pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription({ type: 'answer', sdp: boostSdp(d.sdp) });
      await flushCandidates(link);
      onNegotiated(link);
    }
  }

  async function onRemoteCandidate(link, c) {
    if (!link.pc || !c) return;
    if (!link.pc.remoteDescription) { link.pendingIce.push(c); return; }
    try { await link.pc.addIceCandidate(c); } catch (e) { console.warn('ice', e); }
  }

  async function flushCandidates(link) {
    const list = link.pendingIce.splice(0);
    for (const c of list) {
      try { await link.pc.addIceCandidate(c); } catch (e) { console.warn('ice', e); }
    }
  }

  function onNegotiated(link) {
    link.negotiated = true;
    for (const role of ROLES) syncSender(link, role);
    if (S.watching === link.id) sendTo(link, { t: 'watch', on: true });
  }

  function onConnectionState(link, pc) {
    const st = pc.connectionState;
    if (st === 'connected') {
      link.connected = true;
      clearTimeout(link.restartTimer);
      updateConnKind(link);
    } else if (st === 'disconnected') {
      link.connected = false;
      clearTimeout(link.restartTimer);
      link.restartTimer = setTimeout(() => {
        if (link.pc === pc && pc.connectionState !== 'connected') restartIce(link, pc);
      }, 4000);
    } else if (st === 'failed') {
      link.connected = false;
      restartIce(link, pc);
    }
    updateUI();
  }

  function restartIce(link, pc) {
    if (link.offerer && link.pc === pc && pc.restartIce) pc.restartIce();
  }

  function onRemoteTrack(link, pc, e) {
    const role = ROLES[pc.getTransceivers().indexOf(e.transceiver)];
    if (!role) return;
    const stream = new MediaStream([e.track]);
    link.streams[role] = stream;
    if (role === 'mic') {
      link.ui.micAudio.srcObject = stream;
      link.ui.micAudio.play().catch(() => {});
      watchLevel(link.id, stream);
    } else if (role === 'cam') {
      link.ui.video.srcObject = stream;
    } else if (role === 'screen') {
      if (S.watching === link.id) {
        el.remoteScreen.srcObject = stream;
        updateUI();
      }
    } else {
      link.ui.screenAudio.srcObject = stream;
      applyStreamVolume();
      link.ui.screenAudio.play().catch(() => {});
    }
  }

  function senderFor(link, role) {
    if (!link.pc) return null;
    const tr = link.pc.getTransceivers()[ROLES.indexOf(role)];
    return tr ? tr.sender : null;
  }

  // A tela só vai para quem está assistindo: cada pessoa assistindo custa uma cópia de upload.
  function trackFor(link, role) {
    if (role === 'mic' || role === 'cam') return S.local[role];
    return link.watchingMe ? S.local[role] : null;
  }

  async function syncSender(link, role) {
    const sender = senderFor(link, role);
    if (!sender) return;
    const track = trackFor(link, role);
    try {
      if (sender.track !== track) await sender.replaceTrack(track);
      if (track) await tuneSender(link, role);
    } catch (e) {
      console.warn('replaceTrack', role, e);
    }
  }

  async function setLocalTrack(role, track) {
    S.local[role] = track;
    await Promise.all([...S.links.values()].map((l) => syncSender(l, role)));
  }

  function setWatchingMe(link, on) {
    if (link.watchingMe === on) return;
    link.watchingMe = on;
    syncSender(link, 'screen');
    syncSender(link, 'screenAudio');
    if (on) sendPointer(true);
    updateUI();
  }

  function encodingFor(role) {
    if (role === 'mic') return { enc: { maxBitrate: 96000, priority: 'high', networkPriority: 'high' } };
    if (role === 'screenAudio') return { enc: { maxBitrate: 192000 } };
    if (role === 'screen' && S.browser) {
      return {
        enc: { maxBitrate: 8000000, maxFramerate: 60, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high' },
        degradation: 'balanced',
        codec: null,
      };
    }
    if (role === 'cam') {
      // Com mais gente, cada câmera vai em resolução menor (são várias cópias de upload).
      const n = welcomedLinks().length;
      if (n <= 1) return { enc: { maxBitrate: 1500000, maxFramerate: 30, scaleResolutionDownBy: 1 } };
      if (n <= 3) return { enc: { maxBitrate: 800000, maxFramerate: 30, scaleResolutionDownBy: 1.5 } };
      return { enc: { maxBitrate: 450000, maxFramerate: 24, scaleResolutionDownBy: 2 } };
    }
    const o = settings.share;
    const track = S.local.screen;
    const st = track ? track.getSettings() : {};
    const w = st.width || (S.shareInfo && S.shareInfo.width);
    const h = st.height || (S.shareInfo && S.shareInfo.height);
    const target = RES[o.res];
    let scale = 1;
    if (target && w && h) scale = Math.max(1, w / target[0], h / target[1]);
    return {
      enc: {
        maxBitrate: Math.round(o.rate * 1e6),
        maxFramerate: o.fps,
        scaleResolutionDownBy: scale,
        priority: 'high',
        networkPriority: 'high',
      },
      degradation: o.mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
      codec: o.codec !== 'auto' ? o.codec : null,
    };
  }

  // Aplica fps máximo, taxa de bits, escala e codec no envio.
  async function tuneSender(link, role) {
    const sender = senderFor(link, role);
    if (!sender || !sender.track || !link.negotiated) return;
    const conf = encodingFor(role);
    for (let level = 0; level < 3; level++) {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) return;
      Object.assign(p.encodings[0], conf.enc);
      if (level === 0 && conf.codec && p.codecs) {
        const c = p.codecs.find((x) => x.mimeType.toUpperCase() === `VIDEO/${conf.codec}`);
        if (c) p.encodings[0].codec = c;
      }
      if (level < 2 && conf.degradation) p.degradationPreference = conf.degradation;
      try {
        await sender.setParameters(p);
        return;
      } catch (e) {
        console.warn(`setParameters ${role} nível ${level}`, e);
      }
    }
  }

  function retuneCams() {
    if (!S.local.cam) return;
    for (const l of S.links.values()) tuneSender(l, 'cam');
  }

  // ---------------------------------------------------------------- assistir transmissões
  function watch(id) {
    const link = S.links.get(id);
    if (!link || !link.remote.screen) return;
    if (S.watching && S.watching !== id) {
      const prev = S.links.get(S.watching);
      if (prev) sendTo(prev, { t: 'watch', on: false });
    }
    S.watching = id;
    S.dismissed.delete(id);
    link.prev.rx = null;
    el.remoteCursor.hidden = true;
    el.remoteScreen.srcObject = link.streams.screen || null;
    sendTo(link, { t: 'watch', on: true });
    applyStreamVolume();
    updateUI();
  }

  function stopWatching() {
    const id = S.watching;
    if (!id) return;
    S.watching = null;
    S.dismissed.add(id);
    sendTo(S.links.get(id), { t: 'watch', on: false });
    el.remoteScreen.srcObject = null;
    el.remoteCursor.hidden = true;
    applyStreamVolume();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    updateUI();
  }

  // Se você não está assistindo nada, começa a assistir quem estiver transmitindo.
  function autoWatch() {
    if (S.watching) return;
    for (const l of welcomedLinks()) {
      if (l.remote.screen && !S.dismissed.has(l.id)) { watch(l.id); return; }
    }
  }

  // ---------------------------------------------------------------- microfone e câmera
  async function getMedia(kind) {
    if (desktop && platform === 'darwin') await desktop.askAccess(kind === 'audio' ? 'microphone' : 'camera');
    const id = kind === 'audio' ? settings.micId : settings.camId;
    const base = kind === 'audio'
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    const make = (withId) => ({ [kind]: withId && id ? { ...base, deviceId: { exact: id } } : base });
    try {
      return await navigator.mediaDevices.getUserMedia(make(true));
    } catch (e) {
      if (id && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError' || e.name === 'NotReadableError')) {
        return navigator.mediaDevices.getUserMedia(make(false));
      }
      throw e;
    }
  }

  function mediaErrorText(e, what) {
    if (!e) return `Não foi possível ligar ${what}.`;
    if (e.name === 'NotAllowedError') {
      return platform === 'darwin'
        ? `Sem permissão para ${what}. Libere em Ajustes do Sistema, Privacidade e Segurança.`
        : `Sem permissão para ${what}. Libere nas configurações de privacidade do sistema.`;
    }
    if (e.name === 'NotFoundError') return `Nenhum dispositivo encontrado para ${what}.`;
    if (e.name === 'NotReadableError') return `${what[0].toUpperCase() + what.slice(1)} está em uso por outro programa.`;
    return `Não foi possível ligar ${what} (${e.name || e.message}).`;
  }

  async function startMic(enabled = true) {
    const previous = S.local.mic;
    const previousOn = S.micOn;
    try {
      const stream = await getMedia('audio');
      const track = stream.getAudioTracks()[0];
      if (!S.inRoom) { track.stop(); return; }
      track.enabled = enabled;
      S.micOn = enabled;
      await setLocalTrack('mic', track);
      if (previous) previous.stop();
      track.addEventListener('ended', () => {
        if (S.local.mic !== track) return;
        S.micOn = false;
        setLocalTrack('mic', null).then(() => { sendStates(); updateUI(); });
        toast('O microfone foi desconectado. Escolha outro em Configurações.', true);
      });
      watchLevel('me', new MediaStream([track]));
    } catch (e) {
      S.micOn = previous ? previousOn : false;
      toast(mediaErrorText(e, 'o microfone'), true);
    }
    sendStates();
    updateUI();
  }

  async function toggleMic() {
    if (!S.local.mic || S.local.mic.readyState === 'ended') return startMic();
    S.micOn = !S.micOn;
    S.local.mic.enabled = S.micOn;
    sendStates();
    updateUI();
  }

  async function startCam() {
    try {
      const stream = await getMedia('video');
      const track = stream.getVideoTracks()[0];
      if (!S.inRoom) { track.stop(); return; }
      const old = S.local.cam;
      el.localCam.srcObject = new MediaStream([track]);
      await setLocalTrack('cam', track);
      if (old) old.stop();
    } catch (e) {
      toast(mediaErrorText(e, 'a câmera'), true);
    }
    sendStates();
    updateUI();
  }

  async function stopCam() {
    const t = S.local.cam;
    await setLocalTrack('cam', null);
    if (t) t.stop();
    el.localCam.srcObject = null;
    sendStates();
    updateUI();
  }

  // ---------------------------------------------------------------- nível de voz
  const meters = {};
  function tileOf(key) {
    if (key === 'me') return el.tileMe;
    const l = S.links.get(key);
    return l ? l.ui.tile : null;
  }
  function watchLevel(key, stream) {
    unwatchLevel(key);
    try {
      const c = ctx();
      const src = c.createMediaStreamSource(stream);
      const an = c.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      meters[key] = { src, an, buf: new Float32Array(an.fftSize), until: 0 };
    } catch (e) {
      console.warn('meter', e);
    }
  }
  function unwatchLevel(key) {
    const m = meters[key];
    if (m) { try { m.src.disconnect(); } catch { /* ok */ } }
    delete meters[key];
    const tile = tileOf(key);
    if (tile) tile.dataset.speaking = 'false';
  }
  function tickMeters() {
    const now = performance.now();
    for (const [key, m] of Object.entries(meters)) {
      const link = key === 'me' ? null : S.links.get(key);
      const active = key === 'me' ? S.micOn : !!(link && link.remote.mic);
      let speaking = false;
      if (active) {
        m.an.getFloatTimeDomainData(m.buf);
        let sum = 0;
        for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
        if (Math.sqrt(sum / m.buf.length) > 0.02) m.until = now + 280;
        speaking = now < m.until;
      }
      const tile = tileOf(key);
      const v = speaking ? 'true' : 'false';
      if (tile && tile.dataset.speaking !== v) tile.dataset.speaking = v;
    }
  }

  // ---------------------------------------------------------------- compartilhar tela
  let sources = [];
  let sourceKind = 'screen';
  let selectedSource = null;

  function setSeg(container, value) {
    for (const b of container.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(value)));
  }

  function syncShareForm() {
    const o = settings.share;
    setSeg(el.optRes, o.res);
    setSeg(el.optFps, o.fps);
    setSeg(el.optMode, o.mode);
    el.optRate.value = o.rate;
    el.optRateOut.textContent = `${o.rate} Mb/s por pessoa assistindo`;
    el.optCodec.value = o.codec;
    const audioOk = platform === 'win32' || !desktop;
    el.optAudio.disabled = !audioOk;
    el.optAudio.checked = audioOk && o.audio;
    el.optAudioWrap.classList.toggle('disabled', !audioOk);
    updateAudioOption();
  }

  // O texto do "enviar o som" muda com o que vai ser compartilhado.
  function updateAudioOption() {
    if (desktop && platform !== 'win32') {
      el.optAudioTitle.textContent = 'Enviar o som';
      el.optAudioHelp.textContent = 'Disponível no Windows.';
    } else if (!desktop) {
      el.optAudioTitle.textContent = 'Enviar o som';
      el.optAudioHelp.textContent = 'O navegador pergunta se quer incluir o som.';
    } else if (sourceKind === 'window') {
      el.optAudioTitle.textContent = 'Enviar o som desta janela';
      el.optAudioHelp.textContent = 'Só o som do programa escolhido. O resto do seu PC e as vozes da sala não vão junto.';
    } else {
      el.optAudioTitle.textContent = 'Enviar o som do computador';
      el.optAudioHelp.textContent = 'Tudo que toca no seu PC, menos o próprio MeuDisc: as vozes da sala não voltam como eco.';
    }
  }

  function renderSources() {
    updateAudioOption();
    el.sourceGrid.textContent = '';
    for (const b of el.sourceTabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.kind === sourceKind));
    const list = sources.filter((s) => s.kind === sourceKind);
    if (!list.length) {
      selectedSource = null;
      const p = document.createElement('p');
      p.className = 'source-empty';
      p.textContent = sourceKind === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela aberta para compartilhar.';
      el.sourceGrid.append(p);
      return;
    }
    if (!selectedSource || selectedSource.kind !== sourceKind) selectedSource = list[0];
    for (const s of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'source';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(selectedSource && selectedSource.id === s.id));
      const thumb = document.createElement('div');
      thumb.className = 'source-thumb';
      if (s.thumb) thumb.style.backgroundImage = `url("${s.thumb}")`;
      const name = document.createElement('div');
      name.className = 'source-name';
      if (s.icon) { const img = document.createElement('img'); img.src = s.icon; img.alt = ''; name.append(img); }
      const label = document.createElement('span');
      label.textContent = s.kind === 'screen' ? screenLabel(s) : s.name;
      name.append(label);
      b.append(thumb, name);
      b.addEventListener('click', () => { selectedSource = s; renderSources(); });
      b.addEventListener('dblclick', () => { selectedSource = s; goShare(); });
      el.sourceGrid.append(b);
    }
  }

  function screenLabel(s) {
    const screens = sources.filter((x) => x.kind === 'screen');
    if (screens.length === 1) return 'Tela inteira';
    const m = /(\d+)$/.exec(s.name);
    return m ? `Tela ${m[1]}` : s.name;
  }

  async function openShareDialog() {
    if (S.startingShare) return;
    if (S.local.screen && !S.browser) return stopShare();
    el.shareError.textContent = '';
    syncShareForm();
    if (desktop) {
      if (platform === 'darwin') {
        const st = await desktop.accessStatus('screen');
        if (st === 'denied' || st === 'restricted') { el.macScreenDialog.showModal(); return; }
      }
      el.sourceArea.hidden = false;
      el.sourceBrowserNote.hidden = true;
      el.sourceGrid.textContent = '';
      el.shareDialog.showModal();
      selectedSource = null;
      await refreshSources();
    } else {
      el.sourceArea.hidden = true;
      el.sourceBrowserNote.hidden = false;
      el.shareDialog.showModal();
    }
  }

  async function refreshSources() {
    if (!desktop) return;
    el.refreshSources.disabled = true;
    el.sourceGrid.textContent = 'Buscando telas e janelas…';
    try {
      sources = await desktop.listSources();
      if (selectedSource) selectedSource = sources.find((s) => s.id === selectedSource.id) || null;
      el.shareError.textContent = '';
    } catch (e) {
      sources = [];
      selectedSource = null;
      el.shareError.textContent = 'Não foi possível listar as telas. Tente atualizar.';
    } finally {
      el.refreshSources.disabled = false;
      renderSources();
    }
  }

  async function goShare() {
    if (S.startingShare) return;
    if (desktop && !selectedSource) {
      el.shareError.textContent = 'Escolha uma tela ou janela.';
      return;
    }
    saveSettings();
    const src = selectedSource;
    S.startingShare = true;
    el.shareGo.disabled = true;
    el.shareGo.textContent = 'Iniciando…';
    for (const b of el.shareDialog.querySelectorAll('[value="cancel"]')) b.disabled = true;
    updateUI();
    try {
      await startShare(src);
      el.shareDialog.close();
    } catch (e) {
      console.warn('share', e);
      if (e && e.name === 'NotAllowedError' && platform === 'darwin' && desktop) {
        el.shareDialog.close();
        el.macScreenDialog.showModal();
      } else if (e && e.name === 'NotAllowedError' && !desktop) {
        el.shareError.textContent = 'O compartilhamento foi cancelado. Escolha uma tela para tentar de novo.';
      } else {
        el.shareError.textContent = `Não foi possível compartilhar (${(e && (e.name || e.message)) || 'erro'}).`;
      }
    } finally {
      S.startingShare = false;
      el.shareGo.disabled = false;
      el.shareGo.textContent = 'Compartilhar';
      for (const b of el.shareDialog.querySelectorAll('[value="cancel"]')) b.disabled = false;
      updateUI();
    }
  }

  async function captureScreen(src, wantAudio) {
    const o = settings.share;
    const video = { frameRate: { ideal: o.fps, max: o.fps } };
    if (!desktop) {
      return navigator.mediaDevices.getDisplayMedia({ video, audio: wantAudio, selfBrowserSurface: 'exclude', systemAudio: 'include' });
    }
    try {
      await desktop.chooseSource({ id: src.id, audio: wantAudio });
      return await navigator.mediaDevices.getDisplayMedia({ video, audio: wantAudio });
    } catch (e) {
      if (e && !['TypeError', 'NotSupportedError'].includes(e.name)) throw e;
      console.warn('getDisplayMedia falhou, tentando o modo antigo', e);
      return navigator.mediaDevices.getUserMedia({
        audio: wantAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxFrameRate: o.fps } },
      });
    }
  }

  // Tela inteira no Windows: captura direta da placa de vídeo (DXGI), que acompanha a
  // taxa do monitor. A captura padrão do Windows usada pelo Chromium fica em ~60 fps.
  // Transforma as texturas da GPU que chegam do processo principal numa trilha de vídeo.
  const gpuFramesOk = () => typeof MediaStreamTrackGenerator !== 'undefined' && typeof VideoFrame !== 'undefined';
  // repeatIdle: quando a imagem para de mudar (página parada), continua mandando o último
  // quadro algumas vezes por segundo, para quem chegou agora ver e a qualidade se ajustar.
  function createFrameSink(register, { repeatIdle = false } = {}) {
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = gen.writable.getWriter();
    const sink = { gen, writer, busy: 0, frames: 0, stopped: false, lastAt: 0, unregister: () => register(null) };
    const write = async (frame) => {
      try {
        await writer.write(frame);
        sink.frames++;
      } finally {
        try { frame.close(); } catch { /* ok */ }
      }
    };
    register(async (imported) => {
      if (sink.stopped || sink.busy > 1) return;
      sink.busy++;
      let raw = null;
      try {
        raw = imported.getVideoFrame();
        sink.lastAt = performance.now();
        if (repeatIdle) keepForRepeat(sink, raw);
        // Cada quadro precisa de um horário crescente para o WebRTC não descartá-lo.
        await write(new VideoFrame(raw, { timestamp: Math.round(performance.now() * 1000) }));
      } catch (e) {
        if (sink.frames === 0) console.warn('quadro da GPU', e);
      } finally {
        try { if (raw) raw.close(); } catch { /* ok */ }
        sink.busy--;
      }
    });
    if (repeatIdle) {
      sink.repeatTimer = setInterval(() => {
        if (sink.stopped || !sink.canvas || sink.busy || performance.now() - sink.lastAt < 150) return;
        write(new VideoFrame(sink.canvas, { timestamp: Math.round(performance.now() * 1000) })).catch(() => {});
      }, 150);
    }
    return sink;
  }

  // Guarda uma cópia do último quadro (numa tela fora da página) sem segurar a textura
  // original, que o navegador precisa reaproveitar.
  function keepForRepeat(sink, raw) {
    clearTimeout(sink.snapTimer);
    if (sink.pendingSnap) sink.pendingSnap.close();
    sink.pendingSnap = raw.clone();
    sink.snapTimer = setTimeout(() => {
      const f = sink.pendingSnap;
      sink.pendingSnap = null;
      if (!f) return;
      try {
        const w = f.displayWidth;
        const h = f.displayHeight;
        if (!sink.canvas || sink.canvas.width !== w || sink.canvas.height !== h) sink.canvas = new OffscreenCanvas(w, h);
        sink.canvas.getContext('2d').drawImage(f, 0, 0, w, h);
      } catch (e) {
        console.warn('cópia do quadro', e);
      } finally {
        f.close();
      }
    }, 60);
  }

  function closeFrameSink(sink) {
    if (!sink || sink.stopped) return;
    sink.stopped = true;
    clearInterval(sink.repeatTimer);
    clearTimeout(sink.snapTimer);
    if (sink.pendingSnap) { try { sink.pendingSnap.close(); } catch { /* ok */ } sink.pendingSnap = null; }
    sink.unregister();
    try { sink.writer.close().catch(() => {}); } catch { /* ok */ }
    try { sink.gen.stop(); } catch { /* ok */ }
  }

  async function startNativeCapture(src, fps) {
    const nc = desktop && desktop.nativeCapture;
    if (!nc || !nc.supported || platform !== 'win32' || !src || src.kind !== 'screen') return null;
    if (!gpuFramesOk()) return null;
    if (!(await nc.available())) return null;
    const state = createFrameSink((cb) => nc.onFrame(cb));
    nc.onPointer((p) => { S.pointer = p; sendPointer(); });
    nc.onError((msg) => console.warn('captura direta:', msg));
    let info;
    try {
      info = await nc.start({ sourceId: src.id, fps });
    } catch (e) {
      nc.onPointer(null);
      closeFrameSink(state);
      throw e;
    }
    if (!info || !info.ok) {
      console.warn('captura direta indisponível:', info && info.error);
      nc.onPointer(null);
      closeFrameSink(state);
      return null;
    }
    // Espera o primeiro quadro chegar; se não vier, volta para a captura padrão.
    for (let i = 0; i < 40 && state.frames === 0; i++) await sleep(50);
    if (state.frames === 0) {
      console.warn('captura direta: nenhum quadro chegou');
      stopNativeCapture(state);
      return null;
    }
    state.info = info;
    return state;
  }

  function stopNativeCapture(state) {
    if (!state || state.stopped) return;
    const nc = desktop.nativeCapture;
    nc.onPointer(null);
    nc.stop();
    closeFrameSink(state);
  }

  // Posição do mouse para quem assiste (a captura direta não desenha o cursor na imagem).
  function sendPointer(force) {
    const p = S.pointer;
    const now = performance.now();
    if (!p || (!force && now - S.pointerSentAt < 16)) return;
    S.pointerSentAt = now;
    const msg = { t: 'ptr', x: Math.round(p.x * 10000) / 10000, y: Math.round(p.y * 10000) / 10000, v: !!p.visible };
    for (const l of S.links.values()) if (l.watchingMe) sendTo(l, msg);
  }

  function showRemotePointer(link, m) {
    if (S.watching !== link.id) return;
    const v = el.remoteScreen;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    if (!vw || !vh || !m.v) { el.remoteCursor.hidden = true; return; }
    const W = v.clientWidth;
    const H = v.clientHeight;
    const s = Math.min(W / vw, H / vh);
    const x = (W - vw * s) / 2 + Number(m.x) * vw * s;
    const y = (H - vh * s) / 2 + Number(m.y) * vh * s;
    el.remoteCursor.style.transform = `translate(${x}px, ${y}px)`;
    el.remoteCursor.hidden = false;
  }

  // Som do compartilhamento no Windows: só o programa da janela escolhida, ou o PC
  // inteiro menos o MeuDisc (sem eco das vozes da sala).
  async function startAppAudio(src) {
    const aa = desktop && desktop.appAudio;
    if (!aa || !aa.supported || !src || typeof MediaStreamTrackGenerator === 'undefined' || typeof AudioData === 'undefined') return null;
    const gen = new MediaStreamTrackGenerator({ kind: 'audio' });
    const writer = gen.writable.getWriter();
    const st = { gen, writer, ts: Math.round(performance.now() * 1000), stopped: false, chunks: 0, dropped: 0 };
    aa.onError((message) => {
      if (S.appAudio !== st) return;
      console.warn('captura de som interrompida:', message);
      S.appAudio = null;
      stopAppAudio(st);
      S.shareInfo.sound = 'interrompido';
      setLocalTrack('screenAudio', null).then(() => { sendStates(); updateUI(); });
      toast('O som da transmissão parou. Compartilhe novamente para tentar de novo.', true);
    });
    aa.onData((buf) => {
      if (st.stopped || !buf) return;
      const samples = new Int16Array(buf instanceof ArrayBuffer ? buf : buf.buffer);
      const frames = Math.floor(samples.length / 2);
      if (!frames) return;
      const ts = st.ts;
      st.ts += Math.round((frames / 48000) * 1e6);
      // Captura em tempo real: se o encoder atrasar, descarte o bloco antigo.
      // Uma fila sem limite produz segundos de latência e pode esgotar a memória.
      if (writer.desiredSize == null || writer.desiredSize <= 0) { st.dropped++; return; }
      let data;
      try {
        data = new AudioData({ format: 's16', sampleRate: 48000, numberOfChannels: 2, numberOfFrames: frames, timestamp: ts, data: samples });
      } catch (e) {
        if (!st.chunks) console.warn('som do programa', e);
        return;
      }
      st.chunks++;
      writer.write(data).catch(() => {}).finally(() => { try { data.close(); } catch { /* ok */ } });
    });
    let res;
    try { res = await aa.start({ sourceId: src.id }); }
    catch (e) {
      console.warn('som do programa indisponível:', e);
      stopAppAudio(st);
      return null;
    }
    if (!res || !res.ok) {
      console.warn('som do programa indisponível:', res && res.error);
      stopAppAudio(st);
      return null;
    }
    st.mode = res.mode;
    return st;
  }

  function stopAppAudio(st) {
    if (!st || st.stopped) return;
    st.stopped = true;
    desktop.appAudio.onData(null);
    desktop.appAudio.onError(null);
    desktop.appAudio.stop();
    try { st.writer.close().catch(() => {}); } catch { /* ok */ }
    try { st.gen.stop(); } catch { /* ok */ }
  }

  async function startShare(src) {
    if (S.browser) await closeBrowser();
    const o = settings.share;
    const wantAudio = o.audio && (platform === 'win32' || !desktop);
    let vt = null;
    let at = null;
    let native = null;
    let appAudio = null;
    try {
      if (wantAudio && desktop && platform === 'win32') appAudio = await startAppAudio(src);
      // Se o som por programa não funcionar (Windows antigo), usa o som do sistema todo.
      const systemAudio = wantAudio && !appAudio;
      if (src && src.kind === 'screen') native = await startNativeCapture(src, o.fps);
      if (native) {
        vt = native.gen;
        if (systemAudio) {
          try {
            const s = await captureScreen(src, true);
            s.getVideoTracks().forEach((t) => t.stop());
            at = s.getAudioTracks()[0] || null;
          } catch (e) {
            console.warn('som do computador', e);
          }
        }
      } else {
        const stream = await captureScreen(src, systemAudio);
        vt = stream.getVideoTracks()[0];
        at = stream.getAudioTracks()[0] || null;
        if (!vt) throw new Error('sem vídeo');
        try { await vt.applyConstraints({ frameRate: { ideal: o.fps, max: o.fps } }); } catch { /* mantém o que veio */ }
      }
    } catch (e) {
      if (native) stopNativeCapture(native);
      stopAppAudio(appAudio);
      if (vt) vt.stop();
      if (at) at.stop();
      throw e;
    }
    if (appAudio) at = appAudio.gen;
    if (at && at.readyState === 'ended') { at.stop(); at = null; }
    if (!S.inRoom) {
      if (native) stopNativeCapture(native);
      stopAppAudio(appAudio);
      [vt, at].forEach((t) => t && t.stop());
      return;
    }
    vt.contentHint = o.mode === 'motion' ? 'motion' : 'detail';
    if (at) at.contentHint = 'music';
    vt.addEventListener('ended', () => { if (S.local.screen === vt) stopShare(); });
    if (at && !appAudio) at.addEventListener('ended', () => {
      if (S.local.screenAudio !== at) return;
      S.shareInfo.sound = 'interrompido';
      setLocalTrack('screenAudio', null).then(() => { sendStates(); updateUI(); });
      toast('O som da transmissão parou. Compartilhe novamente para tentar de novo.', true);
    });

    const old = [S.local.screen, S.local.screenAudio];
    const oldNative = S.native;
    const oldAppAudio = S.appAudio;
    const surface = native ? 'monitor' : vt.getSettings().displaySurface;
    S.native = native;
    S.appAudio = appAudio;
    S.pointer = null;
    S.shareInfo = {
      name: src ? (src.kind === 'screen' ? screenLabel(src) : src.name) : (vt.label || 'Tela'),
      kind: src ? src.kind : (surface === 'monitor' ? 'screen' : 'window'),
      native: !!native,
      width: native ? native.info.width : 0,
      height: native ? native.info.height : 0,
      refresh: native ? native.info.refresh : 0,
      sound: appAudio ? (appAudio.mode === 'include' ? 'só desta janela' : 'do PC, sem as vozes da sala')
        : at ? 'do PC inteiro' : 'desligado',
    };
    if (oldAppAudio && oldAppAudio !== appAudio) stopAppAudio(oldAppAudio);
    S.tx = { limitedFor: 0, limitReason: '' };
    el.localScreen.srcObject = new MediaStream([vt]);
    await setLocalTrack('screen', vt);
    await setLocalTrack('screenAudio', at);
    if (oldNative && oldNative !== native) stopNativeCapture(oldNative);
    old.forEach((t) => t && t !== vt && t !== at && t.stop());
    sendStates();
    updateUI();
    if (wantAudio && !at) toast('A tela está sendo compartilhada, mas o som não foi capturado. Tente outra janela ou tela.', true);
  }

  async function stopShare() {
    if (S.browser) return closeBrowser();
    const { screen, screenAudio } = S.local;
    const native = S.native;
    const appAudio = S.appAudio;
    S.native = null;
    S.appAudio = null;
    stopAppAudio(appAudio);
    S.pointer = null;
    S.shareInfo = null;
    await setLocalTrack('screen', null);
    await setLocalTrack('screenAudio', null);
    if (native) stopNativeCapture(native);
    if (screen) screen.stop();
    if (screenAudio) screenAudio.stop();
    el.localScreen.srcObject = null;
    for (const l of S.links.values()) l.prev.tx = null;
    sendStates();
    updateUI();
  }

  // ---------------------------------------------------------------- navegador compartilhado
  // Roda no PC de quem abriu e vai para a sala como uma transmissão. Quem assiste
  // manda mouse, teclado e endereço de volta; quem abriu decide se todos podem mexer.
  async function openBrowser() {
    const b = desktop && desktop.browser;
    if (!b || !b.supported || !gpuFramesOk()) {
      toast('O navegador compartilhado precisa do app MeuDisc (não funciona na versão de navegador).', true);
      return;
    }
    if (S.browser || S.openingBrowser) return;
    S.openingBrowser = true;
    updateUI();
    let sink = null;
    let audio = null;
    try {
      if (S.local.screen) await stopShare();
      if (S.watching) stopWatching();
      sink = createFrameSink((cb) => b.onFrame(cb), { repeatIdle: true });
      b.onState((st) => onBrowserState(st));
      const res = await b.open({ url: '' });
      if (!res || !res.ok) throw new Error((res && res.error) || 'não abriu');
      for (let i = 0; i < 80 && sink.frames === 0; i++) await sleep(50);
      if (!sink.frames) throw new Error('nenhuma imagem do navegador');
      const sound = await captureBrowserAudio(b);
      audio = sound ? sound.track : null;
      if (!S.inRoom) throw new Error('saiu da sala');
      if (audio) {
        audio.contentHint = 'music';
        // Se a captura silenciou o navegador aqui, toca o som capturado para quem abriu.
        if (!sound.localEcho) {
          el.browserAudio.srcObject = new MediaStream([audio]);
          applyStreamVolume();
          el.browserAudio.play().catch(() => {});
        }
      }
      sink.gen.contentHint = 'motion';
      S.browser = { sink, audio, stream: new MediaStream([sink.gen]), state: (await b.state()) || {}, allowAll: true };
      S.shareInfo = { kind: 'browser', name: 'Navegador', width: res.width, height: res.height };
      S.tx = { limitedFor: 0, limitReason: '' };
      await setLocalTrack('screen', sink.gen);
      await setLocalTrack('screenAudio', audio);
      sendStates();
      addSystemChat('Você abriu o navegador da sala.');
    } catch (e) {
      console.warn('navegador', e);
      if (sink) closeFrameSink(sink);
      if (audio) audio.stop();
      b.onState(null);
      b.close();
      if (S.inRoom) toast(`Não foi possível abrir o navegador (${e.message}).`, true);
    } finally {
      S.openingBrowser = false;
      updateUI();
    }
  }

  // Som das páginas abertas no navegador compartilhado, para mandar à sala.
  async function captureBrowserAudio(b) {
    try {
      await desktop.chooseSource({ browserAudio: true });
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      s.getVideoTracks().forEach((t) => t.stop());
      const track = s.getAudioTracks()[0];
      if (track) return { track, localEcho: false };
    } catch (e) {
      console.warn('som do navegador (captura de transmissão)', e);
    }
    try {
      const id = await b.audioSourceId();
      if (id) {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } }, video: false,
        });
        const track = s.getAudioTracks()[0];
        if (track) return { track, localEcho: false };
      }
    } catch (e) {
      console.warn('som do navegador (aba)', e);
    }
    return null;
  }

  async function closeBrowser() {
    const br = S.browser;
    if (!br) return;
    S.browser = null;
    S.shareInfo = null;
    S.pageFullscreen = false;
    await setLocalTrack('screen', null);
    await setLocalTrack('screenAudio', null);
    closeFrameSink(br.sink);
    if (br.audio) br.audio.stop();
    el.browserAudio.srcObject = null;
    el.browserVideo.srcObject = null;
    desktop.browser.onState(null);
    desktop.browser.close();
    sendStates();
    updateUI();
  }

  function browserPublic() {
    const st = (S.browser && S.browser.state) || {};
    return { ...st, allowAll: !!(S.browser && S.browser.allowAll) };
  }

  function onBrowserState(st) {
    if (!S.browser || !st) return;
    S.browser.state = st;
    const msg = { t: 'bstate', b: browserPublic() };
    for (const l of S.links.values()) if (l.watchingMe) sendTo(l, msg);
    updateBrowserBar();
  }

  function cleanBrowserState(b) {
    if (!b || typeof b !== 'object') return null;
    return {
      url: String(b.url || '').slice(0, 2000),
      title: String(b.title || '').slice(0, 200),
      loading: !!b.loading,
      canBack: !!b.canBack,
      canForward: !!b.canForward,
      cursor: String(b.cursor || 'default').slice(0, 32),
      allowAll: !!b.allowAll,
      htmlFullscreen: !!b.htmlFullscreen,
      adblock: !!b.adblock,
      blocked: Math.max(0, Number(b.blocked) || 0),
    };
  }

  // Volume das transmissões e do navegador (só para você).
  function applyStreamVolume() {
    const v = settings.screenMuted ? 0 : settings.screenVol;
    for (const l of S.links.values()) {
      // A trilha recebida pode continuar viva por um instante depois de trocar de tela.
      // Só a transmissão escolhida deve ser audível.
      l.ui.screenAudio.muted = S.watching !== l.id || !l.remote.screenAudio;
      l.ui.screenAudio.volume = v;
    }
    el.browserAudio.volume = v;
    el.screenVol.value = settings.screenVol;
    const muted = settings.screenMuted || settings.screenVol === 0;
    el.screenMute.dataset.muted = String(muted);
    el.screenMute.setAttribute('aria-label', muted ? 'Ativar o som da transmissão' : 'Silenciar a transmissão');
    el.screenMute.title = el.screenMute.getAttribute('aria-label');
    el.bVol.value = settings.screenMuted ? 0 : settings.screenVol;
    el.bMute.dataset.muted = String(muted);
    el.bMute.setAttribute('aria-label', muted ? 'Ativar o som do navegador' : 'Silenciar o navegador');
  }

  function toggleBrowserFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      S.autoFullscreen = false;
      el.browserView.requestFullscreen().then(() => el.bSurface.focus()).catch(() => {});
    }
  }

  // Quando o site entra em tela cheia (ex.: botão do YouTube) logo depois de você clicar,
  // o app também entra em tela cheia; quando o site sai, o app sai junto.
  function followPageFullscreen(on) {
    if (on === S.pageFullscreen) return;
    S.pageFullscreen = on;
    if (on && !document.fullscreenElement && performance.now() - (S.lastSurfaceClick || 0) < 4000) {
      S.autoFullscreen = true;
      el.browserView.requestFullscreen().then(() => el.bSurface.focus()).catch(() => {});
    } else if (!on && S.autoFullscreen && document.fullscreenElement === el.browserView) {
      document.exitFullscreen().catch(() => {});
    }
  }

  // Quem está mexendo pode mexer no navegador desta pessoa?
  function canControlMine(link) {
    return !!(S.browser && S.browser.allowAll && link.welcomed && link.watchingMe);
  }

  // Qual navegador está na tela agora: o seu ou o de quem você está assistindo.
  function browserContext() {
    const w = S.watching ? S.links.get(S.watching) : null;
    if (w && w.remote.screenKind === 'browser') {
      const st = w.remote.browser || {};
      return { link: w, st, owner: w.name, mine: false, canControl: !!st.allowAll };
    }
    if (S.browser && !w) return { link: null, st: S.browser.state || {}, owner: myName(), mine: true, canControl: true };
    return null;
  }

  const CSS_CURSORS = new Set(['default', 'pointer', 'text', 'wait', 'progress', 'crosshair', 'move', 'help', 'not-allowed',
    'grab', 'grabbing', 'col-resize', 'row-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'e-resize',
    'n-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'zoom-in', 'zoom-out',
    'cell', 'copy', 'alias', 'context-menu', 'vertical-text', 'all-scroll', 'none']);
  function cssCursor(type) {
    if (type === 'nodrop') return 'no-drop';
    if (/panning/.test(type)) return 'all-scroll';
    return CSS_CURSORS.has(type) ? type : 'default';
  }

  function updateBrowserBar() {
    const c = browserContext();
    if (!c) return;
    if (document.activeElement !== el.bUrl) el.bUrl.value = c.st.url || '';
    el.bBack.disabled = !c.canControl || !c.st.canBack;
    el.bForward.disabled = !c.canControl || !c.st.canForward;
    el.bReload.disabled = !c.canControl;
    el.bUrl.disabled = !c.canControl;
    el.bOwner.textContent = c.mine ? 'Seu navegador' : `Navegador de ${c.owner}`;
    el.bOwner.title = c.st.title || '';
    el.bAllow.hidden = !c.mine;
    if (c.mine) setSeg(el.bAllow, S.browser.allowAll ? 'all' : 'me');
    el.bClose.hidden = !c.mine;
    el.bLeave.hidden = c.mine;
    el.bSurface.dataset.locked = String(!c.canControl);
    el.bLocked.hidden = c.canControl;
    el.bLocked.textContent = `Só ${c.owner} pode mexer agora`;
    el.bSurface.style.cursor = c.canControl ? cssCursor(c.st.cursor) : '';
    // Anúncios: quem abriu liga e desliga; os outros só veem.
    el.bAdblock.dataset.on = String(!!c.st.adblock);
    el.bAdblock.disabled = !c.mine;
    el.bAdblockLabel.textContent = c.st.adblock
      ? `Bloqueando anúncios${c.st.blocked ? ` (${c.st.blocked})` : ''}`
      : 'Anúncios liberados';
    followPageFullscreen(!!c.st.htmlFullscreen);
  }

  // Manda um evento para o navegador que está na tela (o seu, ou o de quem você assiste).
  function sendBrowser(kind, payload) {
    const c = browserContext();
    if (!c || !c.canControl) return;
    if (c.mine) {
      if (kind === 'input') desktop.browser.input(payload);
      else if (kind === 'nav') desktop.browser.nav(payload.a, payload.url);
      else if (kind === 'text') desktop.browser.text(payload.text);
    } else {
      const t = kind === 'input' ? 'bin' : kind === 'nav' ? 'bnav' : 'btext';
      sendTo(c.link, kind === 'input' ? { t, e: payload } : { t, ...payload });
    }
  }

  function surfacePoint(e) {
    const v = el.browserVideo;
    const r = v.getBoundingClientRect();
    const vw = v.videoWidth || 1280;
    const vh = v.videoHeight || 720;
    const s = Math.min(r.width / vw, r.height / vh);
    const dw = vw * s;
    const dh = vh * s;
    return {
      x: (e.clientX - (r.left + (r.width - dw) / 2)) / dw,
      y: (e.clientY - (r.top + (r.height - dh) / 2)) / dh,
    };
  }

  function inputModifiers(e) {
    const m = [];
    if (e.shiftKey) m.push('shift');
    if (e.ctrlKey) m.push('control');
    if (e.altKey) m.push('alt');
    if (e.metaKey) m.push('meta');
    if (e.buttons & 1) m.push('leftButtonDown');
    if (e.buttons & 2) m.push('rightButtonDown');
    if (e.buttons & 4) m.push('middleButtonDown');
    return m;
  }

  const KEY_NAMES = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Enter: 'Enter',
    Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  };

  function setupBrowserSurface() {
    const surf = el.bSurface;
    let pendingMove = null;
    let moveScheduled = false;
    let last = { t: 0, x: 0, y: 0, count: 0 };
    const flushMove = () => {
      moveScheduled = false;
      if (pendingMove) sendBrowser('input', pendingMove);
      pendingMove = null;
    };
    // Toque (celular): tocar é clicar; arrastar o dedo rola a página.
    let touch = null;
    let scrollScheduled = false;
    const videoScale = () => {
      const v = el.browserVideo;
      const r = v.getBoundingClientRect();
      return Math.min(r.width / (v.videoWidth || 1280), r.height / (v.videoHeight || 720)) || 1;
    };
    const flushScroll = () => {
      scrollScheduled = false;
      if (!touch || !touch.scroll || (!touch.dx && !touch.dy)) return;
      const s = videoScale();
      const p = surfacePoint({ clientX: touch.x, clientY: touch.y });
      sendBrowser('input', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: touch.dx / s, deltaY: touch.dy / s, modifiers: [] });
      touch.dx = 0;
      touch.dy = 0;
    };
    const countClick = (x, y) => {
      const now = performance.now();
      const near = Math.abs(x - last.x) < (touch ? 24 : 6) && Math.abs(y - last.y) < (touch ? 24 : 6);
      last = { t: now, x, y, count: now - last.t < 450 && near ? Math.min(3, last.count + 1) : 1 };
      S.lastSurfaceClick = now;
    };
    const tap = (x, y) => {
      const p = surfacePoint({ clientX: x, clientY: y });
      countClick(x, y);
      sendBrowser('input', { type: 'mouseMove', x: p.x, y: p.y, modifiers: [] });
      sendBrowser('input', { type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: last.count, modifiers: ['leftButtonDown'] });
      sendBrowser('input', { type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: last.count, modifiers: [] });
      // Tocou num campo de texto da página: abre o teclado do celular.
      setTimeout(() => {
        const c = browserContext();
        if (c && c.canControl && c.st.cursor === 'text') openKeyboard();
      }, 350);
    };
    surf.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        if (!touch || e.pointerId !== touch.id) return;
        touch.dx += e.clientX - touch.x;
        touch.dy += e.clientY - touch.y;
        touch.x = e.clientX;
        touch.y = e.clientY;
        if (!touch.scroll && Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0) > 10) touch.scroll = true;
        if (touch.scroll && !scrollScheduled) { scrollScheduled = true; requestAnimationFrame(flushScroll); }
        return;
      }
      const p = surfacePoint(e);
      pendingMove = { type: 'mouseMove', x: p.x, y: p.y, modifiers: inputModifiers(e) };
      if (!moveScheduled) { moveScheduled = true; requestAnimationFrame(flushMove); }
    });
    surf.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        e.preventDefault();
        if (touch) return; // só um dedo
        touch = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, dx: 0, dy: 0, scroll: false };
        try { surf.setPointerCapture(e.pointerId); } catch { /* toque já terminou */ }
        return;
      }
      surf.focus();
      surf.setPointerCapture(e.pointerId);
      const p = surfacePoint(e);
      countClick(e.clientX, e.clientY);
      flushMove();
      sendBrowser('input', {
        type: 'mouseDown', x: p.x, y: p.y, button: ['left', 'middle', 'right'][e.button] || 'left',
        clickCount: last.count, modifiers: inputModifiers(e),
      });
      e.preventDefault();
    });
    surf.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        if (!touch || e.pointerId !== touch.id) return;
        if (touch.scroll) flushScroll();
        else tap(touch.x0, touch.y0);
        touch = null;
        return;
      }
      const p = surfacePoint(e);
      sendBrowser('input', {
        type: 'mouseUp', x: p.x, y: p.y, button: ['left', 'middle', 'right'][e.button] || 'left',
        clickCount: last.count, modifiers: inputModifiers(e),
      });
    });
    surf.addEventListener('pointercancel', (e) => { if (touch && e.pointerId === touch.id) touch = null; });

    // Teclado do celular: um campo escondido recebe o que é digitado e manda para a página.
    // Compara com o que já foi mandado, para funcionar com sugestões e correção automática.
    const ime = el.bIme;
    let sent = '';
    let composing = false;
    const key = (name) => {
      sendBrowser('input', { type: 'keyDown', keyCode: name, modifiers: [] });
      if (name === 'Enter') sendBrowser('input', { type: 'char', keyCode: '\r', modifiers: [] });
      sendBrowser('input', { type: 'keyUp', keyCode: name, modifiers: [] });
    };
    const resetIme = () => { ime.value = ''; sent = ''; };
    function openKeyboard() {
      resetIme();
      ime.focus({ preventScroll: true });
    }
    el.bKeyboard.addEventListener('click', () => {
      const c = browserContext();
      if (!c || !c.canControl) return;
      if (document.activeElement === ime) ime.blur();
      else openKeyboard();
    });
    ime.addEventListener('compositionstart', () => { composing = true; });
    ime.addEventListener('compositionend', () => { composing = false; });
    ime.addEventListener('input', () => {
      const v = ime.value;
      let i = 0;
      while (i < sent.length && i < v.length && sent[i] === v[i]) i++;
      for (let k = sent.length; k > i; k--) key('Backspace');
      if (v.length > i) sendBrowser('text', { text: v.slice(i) });
      sent = v;
      if (!composing && v.length > 60) resetIme();
    });
    ime.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); key('Enter'); resetIme(); }
      else if (e.key === 'Backspace' && !ime.value) { e.preventDefault(); key('Backspace'); }
    });
    surf.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = surfacePoint(e);
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
      sendBrowser('input', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: -e.deltaX * k, deltaY: -e.deltaY * k, modifiers: inputModifiers(e) });
    }, { passive: false });
    surf.addEventListener('contextmenu', (e) => e.preventDefault());
    surf.addEventListener('keydown', (e) => {
      // Esc sai da tela cheia do app (não vai para a página).
      if (e.key === 'Escape' && document.fullscreenElement) {
        e.preventDefault();
        document.exitFullscreen().catch(() => {});
        return;
      }
      const c = browserContext();
      if (!c || !c.canControl) return;
      e.preventDefault();
      // Colar: manda o texto da sua área de transferência.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        navigator.clipboard.readText().then((text) => { if (text) sendBrowser('text', { text: text.slice(0, 5000) }); }).catch(() => {});
        return;
      }
      const mods = inputModifiers(e);
      const name = KEY_NAMES[e.key] || (/^F\d{1,2}$/.test(e.key) ? e.key : e.key.length === 1 ? e.key.toUpperCase() : null);
      if (!name) return;
      sendBrowser('input', { type: 'keyDown', keyCode: name, modifiers: mods });
      const typing = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (typing && e.key.length === 1) sendBrowser('input', { type: 'char', keyCode: e.key, modifiers: mods });
      else if (typing && e.key === 'Enter') sendBrowser('input', { type: 'char', keyCode: '\r', modifiers: mods });
    });
    surf.addEventListener('keyup', (e) => {
      const c = browserContext();
      if (!c || !c.canControl) return;
      e.preventDefault();
      const name = KEY_NAMES[e.key] || (/^F\d{1,2}$/.test(e.key) ? e.key : e.key.length === 1 ? e.key.toUpperCase() : null);
      if (name) sendBrowser('input', { type: 'keyUp', keyCode: name, modifiers: inputModifiers(e) });
    });

    el.bBack.addEventListener('click', () => sendBrowser('nav', { a: 'back' }));
    el.bForward.addEventListener('click', () => sendBrowser('nav', { a: 'forward' }));
    el.bReload.addEventListener('click', () => sendBrowser('nav', { a: 'reload' }));
    el.bForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = el.bUrl.value.trim();
      if (!url) return;
      sendBrowser('nav', { a: 'go', url });
      el.bUrl.blur();
      surf.focus();
    });
    el.bAllow.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn || !S.browser) return;
      S.browser.allowAll = btn.dataset.v === 'all';
      onBrowserState(S.browser.state);
      sendStates();
    });
    el.bClose.addEventListener('click', closeBrowser);
    el.bAdblock.addEventListener('click', async () => {
      if (!S.browser) return;
      el.bAdblock.disabled = true;
      const st = await desktop.browser.setAdblock(!S.browser.state.adblock);
      if (st) onBrowserState(st);
      updateBrowserBar();
    });
    el.bMute.addEventListener('click', () => {
      if (settings.screenVol === 0) { settings.screenVol = 1; settings.screenMuted = false; } else settings.screenMuted = !settings.screenMuted;
      saveSettings();
      applyStreamVolume();
    });
    el.bVol.addEventListener('input', () => {
      settings.screenVol = Number(el.bVol.value);
      settings.screenMuted = false;
      saveSettings();
      applyStreamVolume();
    });
    el.bFullscreen.addEventListener('click', toggleBrowserFullscreen);
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) S.autoFullscreen = false; });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.fullscreenElement && !e.defaultPrevented) document.exitFullscreen().catch(() => {});
    });
  }

  // ---------------------------------------------------------------- estado de cada pessoa
  function stateFor(link) {
    return {
      t: 'state',
      name: myName(),
      mic: !!(S.local.mic && S.micOn),
      cam: !!S.local.cam,
      screen: !!S.local.screen,
      screenAudio: !!S.local.screenAudio,
      screenName: S.shareInfo ? S.shareInfo.name : '',
      screenKind: S.shareInfo ? S.shareInfo.kind : '',
      browser: S.browser ? browserPublic() : null,
      fps: S.local.screen ? (S.browser ? 60 : settings.share.fps) : 0,
      anchor: !!S.anchor,
      watching: S.watching === link.id,
      peers: welcomedLinks().map((l) => l.id),
    };
  }
  const sendStateTo = (link) => sendTo(link, stateFor(link));
  function sendStates() {
    for (const l of welcomedLinks()) sendStateTo(l);
  }

  function applyRemoteState(link, m) {
    const wasSharing = link.remote.screen;
    link.remote = {
      mic: !!m.mic, cam: !!m.cam, screen: !!m.screen, screenAudio: !!m.screenAudio,
      screenName: String(m.screenName || '').slice(0, 120), fps: Number(m.fps) || 0, anchor: !!m.anchor,
      screenKind: String(m.screenKind || '').slice(0, 16),
      browser: cleanBrowserState(m.browser),
    };
    if (m.name) link.name = cleanName(m.name);
    if (typeof m.watching === 'boolean') setWatchingMe(link, m.watching);
    if (Array.isArray(m.peers)) {
      for (const id of m.peers.slice(0, 16)) {
        if (typeof id === 'string' && id !== myId() && !S.links.has(id) && !S.heard.has(id) && !S.gone.has(id)) {
          S.heard.set(id, Date.now());
        }
      }
    }
    if (link.remote.screen && !wasSharing) {
      S.dismissed.delete(link.id);
      if (!S.watching) watch(link.id);
    } else if (!link.remote.screen && wasSharing && S.watching === link.id) {
      S.watching = null;
      el.remoteScreen.srcObject = null;
      autoWatch();
    }
    applyStreamVolume();
    updateUI();
  }

  // ---------------------------------------------------------------- interface
  function makeTile(link) {
    const tile = el.tileTpl.content.firstElementChild.cloneNode(true);
    const audios = tile.querySelectorAll('audio');
    const ui = {
      tile,
      video: tile.querySelector('video'),
      avatar: tile.querySelector('.avatar'),
      name: tile.querySelector('.tile-name'),
      conn: tile.querySelector('.tile-conn'),
      live: tile.querySelector('.tile-live'),
      liveBadge: tile.querySelector('.live-badge'),
      watchBtn: tile.querySelector('.watch-btn'),
      vol: tile.querySelector('.vol-tile input'),
      micAudio: audios[0],
      screenAudio: audios[1],
      volLoaded: false,
    };
    ui.watchBtn.addEventListener('click', () => watch(link.id));
    ui.vol.addEventListener('input', () => {
      const v = Number(ui.vol.value);
      ui.micAudio.volume = v;
      if (link.name) { settings.vols[link.name] = v; saveSettings(); }
    });
    ui.screenAudio.volume = settings.screenMuted ? 0 : settings.screenVol;
    ui.screenAudio.muted = true;
    for (const a of audios) if (a.setSinkId && settings.speakerId) a.setSinkId(settings.speakerId).catch(() => {});
    el.people.append(tile);
    return ui;
  }

  function setConn(state, text) {
    el.connStatus.dataset.state = state;
    el.connText.textContent = text;
  }

  function updateHeader() {
    const links = welcomedLinks();
    if (!links.length) return setConn('waiting', 'Só você na sala');
    const n = links.length + 1;
    const connecting = links.filter((l) => !l.connected);
    if (connecting.length) return setConn('connecting', `Conectando com ${listNames(connecting)}…`);
    const relayed = links.filter((l) => l.kind === 'relay');
    if (relayed.length) return setConn('relay', `${n} pessoas na sala, ${listNames(relayed)} via servidor de apoio`);
    return setConn('ok', `${n} pessoas na sala`);
  }

  function updateUI() {
    const me = myName();
    el.nameMe.textContent = `${me} (você)`;
    el.avatarMe.textContent = initials(me);
    el.avatarMe.style.setProperty('--avatar', colorFor(me));
    el.tileMe.dataset.mic = S.local.mic && S.micOn ? 'on' : 'off';
    el.tileMe.dataset.cam = S.local.cam ? 'on' : 'off';
    el.tileMe.querySelector('.tile-live').hidden = !S.local.screen;

    const links = welcomedLinks();
    for (const l of S.links.values()) {
      const ui = l.ui;
      ui.tile.hidden = !l.welcomed;
      if (!l.welcomed) continue;
      ui.name.textContent = l.name;
      ui.avatar.textContent = initials(l.name);
      ui.avatar.style.setProperty('--avatar', colorFor(l.name));
      ui.tile.dataset.mic = l.remote.mic ? 'on' : 'off';
      ui.tile.dataset.cam = l.remote.cam ? 'on' : 'off';
      ui.tile.dataset.watched = String(S.watching === l.id);
      ui.conn.textContent = l.connected ? '' : 'conectando…';
      ui.live.hidden = !l.remote.screen;
      ui.liveBadge.textContent = l.remote.screenKind === 'browser' ? 'Navegador' : 'Ao vivo';
      ui.watchBtn.hidden = S.watching === l.id;
      if (!ui.volLoaded) {
        const v = settings.vols[l.name];
        if (typeof v === 'number') { ui.vol.value = v; ui.micAudio.volume = v; }
        ui.volLoaded = true;
      }
    }
    el.inviteTile.hidden = links.length > 0;

    el.micBtn.dataset.on = String(!!(S.local.mic && S.micOn));
    el.micBtn.setAttribute('aria-pressed', el.micBtn.dataset.on);
    el.micBtn.title = S.local.mic && S.micOn ? 'Desligar microfone' : 'Ligar microfone';
    el.micBtn.setAttribute('aria-label', el.micBtn.title);
    el.camBtn.dataset.on = String(!!S.local.cam);
    el.camBtn.setAttribute('aria-pressed', el.camBtn.dataset.on);
    el.camBtn.title = S.local.cam ? 'Desligar câmera' : 'Ligar câmera';
    el.camBtn.setAttribute('aria-label', el.camBtn.title);
    const sharing = !!S.local.screen && !S.browser;
    el.shareBtn.dataset.on = String(sharing);
    el.shareBtn.disabled = S.startingShare;
    el.shareBtnLabel.textContent = sharing ? 'Parar transmissão' : 'Compartilhar tela';
    el.shareBtn.title = el.shareBtnLabel.textContent;
    el.shareBtn.setAttribute('aria-label', el.shareBtn.title);
    el.browserBtn.dataset.on = String(!!S.browser);
    el.browserBtn.disabled = !!S.openingBrowser;
    el.browserBtnLabel.textContent = S.openingBrowser ? 'Abrindo…' : S.browser ? 'Fechar navegador' : 'Abrir navegador';
    el.browserBtn.title = el.browserBtnLabel.textContent;
    el.browserBtn.setAttribute('aria-label', el.browserBtn.title);
    el.chatBtn.title = 'Abrir ou fechar chat';
    el.leaveBtn.title = 'Sair da sala';
    el.tileMe.querySelector('.live-badge').textContent = S.browser ? 'Navegador' : 'Ao vivo';

    const watched = S.watching ? S.links.get(S.watching) : null;
    const watchingBrowser = !!(watched && watched.remote.screenKind === 'browser');
    const view = watchingBrowser || (S.browser && !watched) ? 'browser'
      : watched ? 'screen' : sharing ? 'local' : 'people';
    el.stage.dataset.view = view;
    el.browserView.hidden = view !== 'browser';
    el.screenView.hidden = view !== 'screen';
    el.localShareView.hidden = view !== 'local';
    if (view !== 'browser' && document.fullscreenElement === el.browserView) document.exitFullscreen().catch(() => {});
    if (view === 'browser') {
      const src = watchingBrowser ? watched.streams.screen : S.browser.stream;
      if (src && el.browserVideo.srcObject !== src) el.browserVideo.srcObject = src;
      updateBrowserBar();
    } else if (el.browserVideo.srcObject) {
      el.browserVideo.srcObject = null;
    }
    if (view !== 'screen' && document.fullscreenElement === el.screenView) document.exitFullscreen().catch(() => {});
    if (view !== 'screen') el.remoteCursor.hidden = true;
    el.screenCaption.textContent = watched
      ? `${watched.name} está transmitindo${watched.remote.screenName ? `: ${watched.remote.screenName}` : ''}`
      : '';
    el.screenVolWrap.hidden = !(watched && watched.remote.screenAudio);
    el.screenAudioStatus.hidden = !(watched && !watched.remote.screenAudio);
    el.shareName.textContent = S.shareInfo ? S.shareInfo.name : '';

    updateHeader();
    document.title = S.inRoom ? `MeuDisc — Sala ${S.code}` : 'MeuDisc';
    relayout();
  }

  // Escolhe quantas colunas deixam os blocos o maior possível na área disponível.
  function relayout() {
    const p = el.people;
    if (el.stage.dataset.view !== 'people') return;
    const n = p.querySelectorAll(':scope > .tile:not([hidden])').length || 1;
    const gap = 12;
    const W = p.clientWidth - 32;
    const H = p.clientHeight - 32;
    if (W <= 0 || H <= 0) return;
    let best = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9);
      if (w > best) best = w;
    }
    p.style.setProperty('--tile-w', `${Math.max(140, Math.floor(best) - 1)}px`);
  }

  function showHome() {
    el.room.hidden = true;
    el.home.hidden = false;
    document.title = 'MeuDisc';
  }

  function enterRoom(code) {
    S.code = code;
    S.inRoom = true;
    el.roomCode.textContent = code;
    el.waitingCode.textContent = code;
    el.chatLog.textContent = '';
    S.unread = 0;
    updateBadge();
    el.home.hidden = true;
    el.room.hidden = false;
    if (android) android.setInRoom(true, code);
    S.timers.push(setInterval(beat, 2000));
    S.timers.push(setInterval(pollStats, 1000));
    S.timers.push(setInterval(tickMeters, 80));
    updateUI();
    if (!S.local.mic) startMic();
  }

  // No celular com o app em segundo plano, os timers da página quase param; o app chama
  // window.__meudiscTick a cada 2 s para a sala não achar que você caiu.
  function beat() {
    if (!S.inRoom || Date.now() - (S.lastBeat || 0) < 1500) return;
    S.lastBeat = Date.now();
    heartbeat();
  }
  window.__meudiscTick = beat;

  function heartbeat() {
    const now = Date.now();
    for (const l of [...S.links.values()]) {
      if (l.welcomed) sendStateTo(l);
      if (now - l.lastSeen > 20000 || (!l.welcomed && now - l.created > 20000)) removeLink(l, !l.welcomed);
    }
    // Conecta com quem os outros conhecem e nós não (ex.: duas pessoas entrando ao mesmo tempo).
    // Só quem tem o menor id puxa a conexão, para os dois não abrirem ao mesmo tempo.
    for (const [id, ts] of S.heard) {
      if (S.links.has(id) || id === myId()) { S.heard.delete(id); continue; }
      if (now - ts > 5000) {
        S.heard.delete(id);
        if (myId() < id) connectTo(id, '', true);
      }
    }
    for (const [id, ts] of S.gone) if (now - ts > 30000) S.gone.delete(id);
    S.beat++;
    if (S.beat % 5 === 0) checkAnchor();
  }

  function resetSession() {
    S.joining = false;
    if (S.inRoom && android) android.setInRoom(false, '');
    S.inRoom = false;
    clearTimeout(S.joinTimer);
    S.timers.forEach(clearInterval);
    S.timers = [];
    const links = [...S.links.values()];
    for (const l of links) sendTo(l, { t: 'bye' });
    const conns = links.map((l) => l.conn);
    for (const l of links) {
      l.conn = null;
      clearTimeout(l.restartTimer);
      closePeerConnection(l);
      unwatchLevel(l.id);
      l.ui.tile.remove();
    }
    S.links.clear();
    const { peer, anchor, lobby } = S;
    S.peer = null;
    S.anchor = null;
    S.lobby = null;
    setTimeout(() => {
      for (const c of conns) { try { if (c) c.close(); } catch { /* ok */ } }
      try { if (lobby) lobby.close(); } catch { /* ok */ }
      try { if (anchor) anchor.destroy(); } catch { /* ok */ }
      try { if (peer) peer.destroy(); } catch { /* ok */ }
    }, 400);
    for (const role of ROLES) {
      if (S.local[role]) S.local[role].stop();
      S.local[role] = null;
    }
    if (S.native) { stopNativeCapture(S.native); S.native = null; }
    if (S.appAudio) { stopAppAudio(S.appAudio); S.appAudio = null; }
    if (S.browser) {
      const br = S.browser;
      S.browser = null;
      closeFrameSink(br.sink);
      if (br.audio) br.audio.stop();
      desktop.browser.onState(null);
      desktop.browser.close();
      el.browserAudio.srcObject = null;
      el.browserVideo.srcObject = null;
    }
    S.pointer = null;
    S.micOn = false;
    S.shareInfo = null;
    S.watching = null;
    S.dismissed.clear();
    S.heard.clear();
    S.gone.clear();
    S.code = '';
    unwatchLevel('me');
    el.localCam.srcObject = null;
    el.localScreen.srcObject = null;
    el.remoteScreen.srcObject = null;
    el.chat.hidden = true;
    el.chatBtn.dataset.on = 'false';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function leaveRoom() {
    resetSession();
    showHome();
    updateUI();
  }

  // ---------------------------------------------------------------- estatísticas
  function rate(store, key, bytes, ts) {
    const prev = store[key];
    store[key] = { bytes, ts };
    if (!prev || ts <= prev.ts || bytes < prev.bytes) return null;
    return ((bytes - prev.bytes) * 8) / ((ts - prev.ts) / 1000);
  }

  function selectedPair(report) {
    let pair = null;
    report.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = report.get(r.selectedCandidatePairId);
    });
    if (!pair) report.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    return pair;
  }

  async function updateConnKind(link) {
    const pc = link.pc;
    if (!pc) return;
    try {
      const report = await pc.getStats();
      const pair = selectedPair(report);
      if (!pair || link.pc !== pc || !link.connected) return;
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      const types = [local && local.candidateType, remote && remote.candidateType];
      link.kind = types.includes('relay') ? 'relay' : types.every((t) => t === 'host') ? 'lan' : 'direct';
      link.ui.tile.title = link.kind === 'relay' ? `${link.name}: via servidor de apoio`
        : link.kind === 'lan' ? `${link.name}: mesma rede` : `${link.name}: conexão direta`;
      updateHeader();
    } catch { /* ignora */ }
  }

  async function pollStats() {
    // Enviando: uma cópia para cada pessoa assistindo.
    if (S.local.screen) {
      const viewers = welcomedLinks().filter((l) => l.watchingMe && l.pc && l.negotiated);
      let minFps = Infinity;
      let total = 0;
      let first = null;
      let reasonNow = 'none';
      for (const l of viewers) {
        try {
          const tr = l.pc.getTransceivers()[ROLES.indexOf('screen')];
          const report = await tr.sender.getStats();
          let out = null;
          report.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') out = r; });
          if (!out) continue;
          minFps = Math.min(minFps, Math.round(out.framesPerSecond || 0));
          total += rate(l.prev, 'tx', out.bytesSent, out.timestamp) || 0;
          if (out.qualityLimitationReason && out.qualityLimitationReason !== 'none') reasonNow = out.qualityLimitationReason;
          if (!first) first = { out, report };
        } catch { /* ignora */ }
      }
      el.txViewers.textContent = viewers.length
        ? `${viewers.length} ${viewers.length === 1 ? 'pessoa' : 'pessoas'}`
        : 'ninguém ainda';
      el.txFps.textContent = first ? `${minFps} fps de ${settings.share.fps}` : '—';
      el.txRate.textContent = first ? fmtRate(total) : '—';
      el.txRes.textContent = first && first.out.frameWidth ? `${first.out.frameWidth}×${first.out.frameHeight}` : '—';
      if (first) {
        const codec = first.out.codecId && first.report.get(first.out.codecId);
        const pe = first.out.powerEfficientEncoder;
        const hw = pe === true ? 'placa de vídeo' : pe === false ? 'processador' : '';
        el.txEnc.textContent = [codec ? codec.mimeType.split('/')[1] : '', hw ? `(${hw})` : ''].filter(Boolean).join(' ') || '—';
      } else {
        el.txEnc.textContent = '—';
      }
      // Só avisa se o limite persistir: nos primeiros segundos a banda ainda está subindo.
      S.tx.limitedFor = reasonNow === S.tx.limitReason ? S.tx.limitedFor + 1 : 0;
      S.tx.limitReason = reasonNow;
      const reason = S.tx.limitedFor >= 20 ? reasonNow : 'none';
      const info = S.shareInfo || {};
      el.txSound.textContent = info.sound || '—';
      el.txCapture.textContent = info.native
        ? `direta da placa de vídeo${info.refresh ? `, monitor de ${info.refresh} Hz` : ''}`
        : info.kind === 'window' ? 'janela (Windows)' : 'padrão do sistema';
      const lowScreen = first && info.kind === 'screen' && !info.native
        && settings.share.fps > 60 && minFps < settings.share.fps * 0.8;
      el.txHint.textContent = !viewers.length
        ? (welcomedLinks().length ? 'A transmissão começa para cada pessoa quando ela clicar em Assistir.' : 'A transmissão começa quando alguém entrar na sala.')
        : reason === 'bandwidth'
          ? (viewers.length > 1
            ? `Sua internet está no limite: cada pessoa assistindo recebe uma cópia (${viewers.length} agora). Tente uma resolução menor ou menos Mb/s.`
            : 'Sua internet está limitando a transmissão. Tente uma resolução menor ou menos Mb/s.')
          : reason === 'cpu' ? 'Seu computador está no limite. Tente 1080p ou o codec H.264.'
            : lowScreen ? `A tela inteira está saindo a ${minFps} fps. Para 120 fps em jogos, compartilhe a janela do jogo.`
              : '';
    }

    if (S.beat % 3 === 0) for (const l of welcomedLinks()) if (l.connected) updateConnKind(l);
  }

  // ---------------------------------------------------------------- chat
  function addChat(who, text, mine) {
    if (!text) return;
    const li = document.createElement('li');
    if (mine) li.className = 'me';
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = mine ? 'Você' : who;
    const m = document.createElement('span');
    m.className = 'msg';
    m.textContent = text;
    li.append(w, m);
    el.chatLog.append(li);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    if (!mine && el.chat.hidden) {
      S.unread++;
      updateBadge();
      tone('msg');
    }
  }
  function addSystemChat(text) {
    const li = document.createElement('li');
    li.className = 'sys';
    li.textContent = text;
    el.chatLog.append(li);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }
  function updateBadge() {
    el.chatBadge.hidden = S.unread === 0;
    el.chatBadge.textContent = S.unread > 9 ? '9+' : String(S.unread);
  }
  function toggleChat(force) {
    const open = typeof force === 'boolean' ? force : el.chat.hidden;
    el.chat.hidden = !open;
    el.chatBtn.dataset.on = String(open);
    if (open) {
      S.unread = 0;
      updateBadge();
      // No celular, abrir o teclado sozinho cobriria as mensagens.
      if (!matchMedia('(pointer: coarse)').matches) el.chatInput.focus();
    }
    requestAnimationFrame(relayout);
  }

  // ---------------------------------------------------------------- configurações
  async function fillDevices() {
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* ignora */ }
    const fill = (select, kind, current, fallback) => {
      select.textContent = '';
      select.append(new Option('Padrão do sistema', ''));
      devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .forEach((d, i) => select.append(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
      select.value = current;
      if (select.value !== current) select.value = '';
    };
    fill($('set-mic'), 'audioinput', settings.micId, 'Microfone');
    fill($('set-cam'), 'videoinput', settings.camId, 'Câmera');
    fill($('set-speaker'), 'audiooutput', settings.speakerId, 'Saída');
    $('set-speaker-wrap').hidden = !('setSinkId' in HTMLMediaElement.prototype);
  }

  async function openSettings() {
    if (el.settingsDialog.open) return;
    $('set-name').value = settings.name || el.nameInput.value;
    $('set-turn-url').value = settings.turnUrl;
    $('set-turn-user').value = settings.turnUser;
    $('set-turn-pass').value = settings.turnPass;
    el.settingsDialog.showModal();
    await fillDevices();
  }

  async function saveSettingsForm() {
    const prevMic = settings.micId;
    const prevCam = settings.camId;
    const name = $('set-name').value.trim().slice(0, 24);
    if (name) { settings.name = name; el.nameInput.value = name; }
    settings.micId = $('set-mic').value;
    settings.camId = $('set-cam').value;
    settings.speakerId = $('set-speaker').value;
    settings.turnUrl = $('set-turn-url').value.trim();
    settings.turnUser = $('set-turn-user').value.trim();
    settings.turnPass = $('set-turn-pass').value;
    saveSettings();
    applySpeaker();
    if (S.inRoom && S.local.mic && prevMic !== settings.micId) {
      await startMic(S.micOn);
    }
    if (S.inRoom && S.local.cam && prevCam !== settings.camId) await startCam();
    sendStates();
    updateUI();
  }

  function applySpeaker() {
    for (const l of S.links.values()) {
      for (const a of [l.ui.micAudio, l.ui.screenAudio]) {
        if (a.setSinkId) a.setSinkId(settings.speakerId || '').catch(() => {});
      }
    }
    if (el.browserAudio.setSinkId) el.browserAudio.setSinkId(settings.speakerId || '').catch(() => {});
    applyStreamVolume();
  }

  // ---------------------------------------------------------------- eventos
  el.nameInput.value = settings.name;
  el.nameInput.addEventListener('input', () => showHomeError(''));
  el.codeInput.addEventListener('input', () => {
    const v = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
    if (v !== el.codeInput.value) el.codeInput.value = v;
    showHomeError('');
  });
  el.codeInput.addEventListener('paste', (e) => {
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    el.codeInput.value = normalizeCode(text);
  });
  el.createBtn.addEventListener('click', createRoom);
  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoom(normalizeCode(el.codeInput.value));
  });
  $('home-settings-btn').addEventListener('click', openSettings);
  $('room-settings-btn').addEventListener('click', openSettings);
  $('copy-invite-btn').addEventListener('click', copyInvite);
  $('waiting-copy-btn').addEventListener('click', copyInvite);

  el.micBtn.addEventListener('click', toggleMic);
  el.camBtn.addEventListener('click', () => (S.local.cam ? stopCam() : startCam()));
  el.shareBtn.addEventListener('click', openShareDialog);
  $('stop-share-btn').addEventListener('click', stopShare);
  $('unwatch-btn').addEventListener('click', stopWatching);
  el.chatBtn.addEventListener('click', () => toggleChat());
  $('chat-close-btn').addEventListener('click', () => toggleChat(false));
  el.leaveBtn.addEventListener('click', leaveRoom);

  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim().slice(0, 1000);
    if (!text) return;
    const links = welcomedLinks();
    if (!links.length) { toast('Ninguém na sala ainda para ler sua mensagem.'); return; }
    for (const l of links) sendTo(l, { t: 'chat', text });
    addChat(myName(), text, true);
    el.chatInput.value = '';
  });

  // Quem assiste: tela cheia (botão ou duplo clique) e fechar a transmissão.
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.screenView.requestFullscreen().catch(() => {});
  };
  $('fullscreen-btn').addEventListener('click', toggleFullscreen);
  el.remoteScreen.addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const full = document.fullscreenElement === el.screenView;
    $('fullscreen-label').textContent = full ? 'Sair da tela cheia' : 'Tela cheia';
    wakeScreenTools();
  });
  // Em tela cheia, os botões somem com o mouse parado e voltam ao mexer.
  let idleTimer = 0;
  function wakeScreenTools() {
    el.screenView.dataset.idle = 'false';
    clearTimeout(idleTimer);
    if (document.fullscreenElement === el.screenView) {
      idleTimer = setTimeout(() => { el.screenView.dataset.idle = 'true'; }, 2500);
    }
  }
  el.screenView.addEventListener('mousemove', wakeScreenTools);
  el.screenView.addEventListener('pointerdown', wakeScreenTools);
  $('b-leave').addEventListener('click', stopWatching);

  el.screenVol.addEventListener('input', () => {
    settings.screenVol = Number(el.screenVol.value);
    settings.screenMuted = false;
    applyStreamVolume();
    saveSettings();
  });
  el.screenMute.addEventListener('click', () => {
    if (settings.screenVol === 0) { settings.screenVol = 1; settings.screenMuted = false; }
    else settings.screenMuted = !settings.screenMuted;
    applyStreamVolume();
    saveSettings();
  });

  // Navegador compartilhado.
  el.browserBtn.addEventListener('click', () => (S.browser ? closeBrowser() : openBrowser()));
  setupBrowserSurface();

  // Diálogo de compartilhamento.
  el.sourceTabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    sourceKind = b.dataset.kind;
    renderSources();
  });
  el.refreshSources.addEventListener('click', refreshSources);
  el.shareDialog.addEventListener('cancel', (e) => { if (S.startingShare) e.preventDefault(); });
  const bindSeg = (container, apply) => container.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    apply(b.dataset.v);
    syncShareForm();
  });
  const resetRate = () => { settings.share.rate = DEFAULT_RATE[settings.share.res][settings.share.fps]; };
  bindSeg(el.optRes, (v) => { settings.share.res = v; resetRate(); });
  bindSeg(el.optFps, (v) => { settings.share.fps = Number(v); resetRate(); });
  bindSeg(el.optMode, (v) => { settings.share.mode = v; });
  el.optRate.addEventListener('input', () => {
    settings.share.rate = Number(el.optRate.value);
    el.optRateOut.textContent = `${settings.share.rate} Mb/s por pessoa assistindo`;
  });
  el.optCodec.addEventListener('change', () => { settings.share.codec = el.optCodec.value; });
  el.optAudio.addEventListener('change', () => { settings.share.audio = el.optAudio.checked; });
  el.shareGo.addEventListener('click', goShare);

  el.settingsDialog.addEventListener('close', () => {
    if (el.settingsDialog.returnValue === 'save') saveSettingsForm();
  });
  el.macScreenDialog.addEventListener('close', () => {
    if (el.macScreenDialog.returnValue === 'open' && desktop) desktop.openScreenSettings();
  });

  new ResizeObserver(() => relayout()).observe(el.people);
  window.addEventListener('beforeunload', () => { for (const l of S.links.values()) sendTo(l, { t: 'bye' }); });

  if (typeof Peer === 'undefined') {
    showHomeError('Arquivos do app incompletos (peerjs). Rode "npm install" de novo.');
    el.createBtn.disabled = true;
    el.joinBtn.disabled = true;
  }

  // Só mostra o que funciona aqui: no celular não dá para transmitir a tela nem abrir o
  // navegador da sala (ele roda no PC de quem abre), mas dá para assistir e mexer nos dos outros.
  el.shareBtn.hidden = !!android || (!desktop && !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia));
  el.browserBtn.hidden = !(desktop && desktop.browser && desktop.browser.supported && gpuFramesOk());
  if (android) {
    document.documentElement.dataset.platform = 'android';
    $('waiting-copy-btn').lastChild.textContent = ' Enviar convite';
    $('copy-invite-btn').title = 'Enviar convite';
    $('copy-invite-btn').setAttribute('aria-label', 'Enviar convite');
  }

  // Botão voltar do Android: fecha o que estiver aberto. Se não tiver nada, o app vai para
  // segundo plano e você continua na sala.
  window.__meudiscBack = () => {
    const dialog = document.querySelector('dialog[open]');
    if (dialog) {
      if (dialog === el.shareDialog && S.startingShare) return true;
      dialog.close('cancel');
      return true;
    }
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return true; }
    if (document.activeElement === el.bIme) { el.bIme.blur(); return true; }
    if (!el.chat.hidden) { toggleChat(false); return true; }
    return false;
  };

  applySpeaker();
  updateUI();
})();
