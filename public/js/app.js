const API = (document.querySelector('meta[name="base-path"]')?.content || '/conference').replace(/\/$/, '');
let token = localStorage.getItem('conf_token');
let user = null;
let socket = null;

let confStream = null;
let confScreenStream = null;
let confPeers = {};
let confRoomCode = null;
let confUserName = '';
let confIsHost = false;
let confParticipants = {};
let confQuality = 'full-hd';
const confQualityMap = { 'half-hd': { w: 640, h: 360 }, 'full-hd': { w: 1920, h: 1080 }, '4k': { w: 3840, h: 2160 } };
let selectedCameraId = '';
let selectedMicId = '';
let selectedSpeakerId = '';

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'info');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

async function apiFetch(endpoint, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API + endpoint, { ...opts, headers });
  if (res.status === 401) { doLogout(); throw new Error('Session expired'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ===== ROUTING =====
function detectRoute() {
  const path = window.location.pathname;
  const base = API.replace(/\/$/, '');
  const after = path.replace(base, '');
  const roomMatch = after.match(/\/room\/([a-f0-9]+)/);
  if (roomMatch) return { type: 'join', roomCode: roomMatch[1] };
  return { type: 'app' };
}

async function init() {
  const route = detectRoute();

  if (route.type === 'join') {
    showGuestJoinPage(route.roomCode);
    return;
  }

  if (token) {
    try {
      user = await apiFetch('/api/me');
      showDashboard();
    } catch {
      token = null;
      localStorage.removeItem('conf_token');
      showAuth();
    }
  } else {
    showAuth();
  }
}

function showAuth() {
  document.getElementById('auth-page').classList.remove('hidden');
  document.getElementById('dashboard-page').classList.add('hidden');
  document.getElementById('guest-join-page').classList.add('hidden');
}

function showRegister() {
  document.getElementById('auth-login-form').classList.add('hidden');
  document.getElementById('auth-register-form').classList.remove('hidden');
}

function showLogin() {
  document.getElementById('auth-register-form').classList.add('hidden');
  document.getElementById('auth-login-form').classList.remove('hidden');
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { showToast('Email and password required', 'error'); return; }
  try {
    const data = await apiFetch('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    token = data.token;
    user = data.user;
    localStorage.setItem('conf_token', token);
    showDashboard();
  } catch (err) { showToast(err.message, 'error'); }
}

async function doRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!name || !email || !password) { showToast('All fields required', 'error'); return; }
  try {
    const data = await apiFetch('/api/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
    token = data.token;
    user = data.user;
    localStorage.setItem('conf_token', token);
    showDashboard();
  } catch (err) { showToast(err.message, 'error'); }
}

function doLogout() {
  token = null;
  user = null;
  localStorage.removeItem('conf_token');
  if (socket) { socket.disconnect(); socket = null; }
  showAuth();
}

// ===== DASHBOARD =====
function showDashboard() {
  document.getElementById('auth-page').classList.add('hidden');
  document.getElementById('guest-join-page').classList.add('hidden');
  document.getElementById('dashboard-page').classList.remove('hidden');
  document.getElementById('user-name').textContent = user.name;
  connectSocket();
  loadConferences();
}

function connectSocket() {
  if (socket && socket.connected) return;
  socket = io({ path: API + '/socket.io/' });
  socket.on('connect', () => console.log('[Socket] Connected:', socket.id));
}

async function loadConferences() {
  try {
    const { rooms } = await apiFetch('/api/conferences');
    const active = rooms.filter(r => r.status === 'active' || r.status === 'scheduled');
    const ended = rooms.filter(r => r.status === 'ended');

    const activeEl = document.getElementById('active-conferences');
    if (active.length === 0) {
      activeEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:16px;text-align:center;grid-column:1/-1;">No active conferences. Create one to get started!</div>';
    } else {
      activeEl.innerHTML = active.map(r => {
        const statusBadge = r.status === 'active'
          ? '<span style="background:#22c55e;color:#fff;padding:2px 8px;border-radius:4px;font-size:0.7rem;font-weight:600;">LIVE</span>'
          : '<span style="background:#f59e0b22;color:#f59e0b;padding:2px 8px;border-radius:4px;font-size:0.7rem;">Scheduled</span>';
        const date = r.scheduled_at ? new Date(r.scheduled_at).toLocaleString() : 'Now';
        return `<div class="conf-card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
            <span style="font-weight:600;">${escapeHtml(r.name)}</span>
            ${statusBadge}
            ${r.has_password ? '<i class="fas fa-lock" style="color:var(--text-muted);font-size:0.75rem;"></i>' : ''}
          </div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:12px;">${date} | Code: <strong>${r.room_code}</strong> | Max: ${r.max_participants}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${r.status === 'scheduled' ? `<button class="btn btn-sm btn-primary" onclick="startScheduled('${r.room_code}')"><i class="fas fa-play"></i> Start</button>` : ''}
            ${r.status === 'active' ? `<button class="btn btn-sm btn-primary" onclick="joinOwn('${r.room_code}','${escapeHtml(r.name)}')"><i class="fas fa-video"></i> Join</button>` : ''}
            <button class="btn btn-sm" onclick="copyText('${window.location.origin}${API}/room/${r.room_code}')"><i class="fas fa-link"></i> Copy Link</button>
            <button class="btn btn-sm" onclick="deleteConference('${r.room_code}')" style="color:var(--accent-red);"><i class="fas fa-trash"></i></button>
          </div>
        </div>`;
      }).join('');
    }

    const endedEl = document.getElementById('ended-conferences');
    if (ended.length === 0) {
      endedEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:16px;text-align:center;grid-column:1/-1;">No conference history yet</div>';
    } else {
      endedEl.innerHTML = ended.map(r => {
        const created = new Date(r.created_at).toLocaleString();
        return `<div class="conf-card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="font-weight:600;">${escapeHtml(r.name)}</span>
            <span style="background:var(--bg-input);color:var(--text-muted);padding:2px 8px;border-radius:4px;font-size:0.7rem;">Ended</span>
          </div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:12px;">${created} | ${r.message_count || 0} messages</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn btn-sm" onclick="viewMessages('${r.room_code}','${escapeHtml(r.name)}')"><i class="fas fa-comment"></i> Chat</button>
            <button class="btn btn-sm" onclick="viewAI('${r.room_code}','${escapeHtml(r.name)}')" style="color:#7c3aed;"><i class="fas fa-robot"></i> AI</button>
            <button class="btn btn-sm" onclick="downloadLog('${r.room_code}','${escapeHtml(r.name)}')"><i class="fas fa-download"></i></button>
            <button class="btn btn-sm" onclick="deleteConference('${r.room_code}')" style="color:var(--accent-red);"><i class="fas fa-trash"></i></button>
          </div>
        </div>`;
      }).join('');
    }
  } catch (err) { console.error('Load conferences error:', err); }
}

// ===== CREATE / JOIN =====
function showCreateModal() {
  document.getElementById('create-modal').classList.add('active');
  document.getElementById('conf-room-name').value = '';
  document.getElementById('conf-password').value = '';
  document.getElementById('conf-room-name').focus();
}
function hideCreateModal() { document.getElementById('create-modal').classList.remove('active'); }

function showJoinModal() {
  document.getElementById('join-modal').classList.add('active');
  document.getElementById('join-room-code').value = '';
  document.getElementById('join-room-code').focus();
}
function hideJoinModal() { document.getElementById('join-modal').classList.remove('active'); }

async function createConference(schedule) {
  const name = document.getElementById('conf-room-name').value.trim();
  if (!name) { showToast('Room name is required', 'error'); return; }
  const maxP = parseInt(document.getElementById('conf-max-participants').value);
  confQuality = document.getElementById('conf-quality').value;
  const password = document.getElementById('conf-password').value;
  try {
    const data = await apiFetch('/api/conference', {
      method: 'POST',
      body: JSON.stringify({ name, max_participants: maxP, password: password || undefined, scheduled_at: schedule ? 'later' : undefined })
    });
    hideCreateModal();
    if (data.status === 'scheduled') {
      showToast('Conference saved! Click Start when ready.', 'success');
      loadConferences();
      return;
    }
    confRoomCode = data.room_code;
    confUserName = user.name;
    confIsHost = true;
    await enterConference(data.room_code, data.name);
  } catch (err) { showToast(err.message, 'error'); }
}

async function startScheduled(roomCode) {
  try {
    await apiFetch('/api/conference/' + roomCode + '/start', { method: 'POST' });
    showToast('Conference started!', 'success');
    confRoomCode = roomCode;
    confUserName = user.name;
    confIsHost = true;
    const res = await apiFetch('/api/conference/' + roomCode);
    await enterConference(roomCode, res.room.name);
  } catch (err) { showToast(err.message, 'error'); }
}

async function joinOwn(roomCode, roomName) {
  confRoomCode = roomCode;
  confUserName = user.name;
  confIsHost = true;
  await enterConference(roomCode, roomName);
}

async function joinByCode() {
  const code = document.getElementById('join-room-code').value.trim();
  if (!code) { showToast('Enter a room code', 'error'); return; }
  try {
    const res = await apiFetch('/api/conference/' + code);
    hideJoinModal();
    confRoomCode = code;
    confUserName = user.name;
    confIsHost = false;
    await enterConference(code, res.room.name);
  } catch (err) { showToast(err.message, 'error'); }
}

async function deleteConference(roomCode) {
  if (!confirm('Delete this conference and all its messages?')) return;
  try {
    await apiFetch('/api/conference/' + roomCode, { method: 'DELETE' });
    showToast('Conference deleted', 'success');
    loadConferences();
  } catch (err) { showToast(err.message, 'error'); }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success')).catch(() => showToast('Failed to copy', 'error'));
}

// ===== GUEST JOIN =====
let guestRoomCode = null;

async function showGuestJoinPage(roomCode) {
  guestRoomCode = roomCode;
  document.getElementById('auth-page').classList.add('hidden');
  document.getElementById('dashboard-page').classList.add('hidden');
  document.getElementById('guest-join-page').classList.remove('hidden');
  try {
    const res = await fetch(API + '/api/conference/' + roomCode);
    if (!res.ok) {
      document.getElementById('guest-room-name').textContent = 'Conference not found or has ended';
      return;
    }
    const { room } = await res.json();
    document.getElementById('guest-room-name').textContent = room.name;
    if (room.has_password) document.getElementById('guest-pw-group').classList.remove('hidden');
    document.getElementById('guest-join-name').focus();
  } catch {
    document.getElementById('guest-room-name').textContent = 'Error loading conference';
  }
}

async function joinAsGuest() {
  const name = document.getElementById('guest-join-name').value.trim();
  if (!name) { showToast('Please enter your name', 'error'); return; }
  const pwInput = document.getElementById('guest-join-password');
  const password = pwInput ? pwInput.value : '';

  try {
    if (password || !document.getElementById('guest-pw-group').classList.contains('hidden')) {
      const pwRes = await fetch(API + '/api/conference/' + guestRoomCode + '/verify-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      if (!pwRes.ok) { showToast('Incorrect room password', 'error'); return; }
    }

    confRoomCode = guestRoomCode;
    confUserName = name;
    confIsHost = false;

    connectSocket();

    const res = await fetch(API + '/api/conference/' + guestRoomCode);
    const { room } = await res.json();
    document.getElementById('guest-join-page').classList.add('hidden');
    await enterConference(guestRoomCode, room.name);
  } catch {
    showToast('Failed to join conference', 'error');
  }
}

// ===== ENTER CONFERENCE =====
async function enterConference(roomCode, roomName) {
  document.getElementById('auth-page').classList.add('hidden');
  document.getElementById('dashboard-page').classList.add('hidden');
  document.getElementById('guest-join-page').classList.add('hidden');
  document.getElementById('conference-page').classList.remove('hidden');
  document.getElementById('conf-title').textContent = roomName;

  if (!socket || !socket.connected) {
    connectSocket();
    await new Promise(resolve => {
      if (socket.connected) resolve();
      else socket.once('connect', resolve);
    });
  }

  const qSel = document.getElementById('conf-quality-live');
  if (qSel) qSel.value = confQuality;
  const dName = document.getElementById('conf-display-name');
  if (dName) dName.value = confUserName;

  const q = confQualityMap[confQuality] || confQualityMap['full-hd'];
  try {
    const videoConstraints = { width: { ideal: q.w }, height: { ideal: q.h } };
    if (selectedCameraId) videoConstraints.deviceId = { exact: selectedCameraId };
    const audioConstraints = { echoCancellation: true, noiseSuppression: true };
    if (selectedMicId) audioConstraints.deviceId = { exact: selectedMicId };
    confStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
    const vt = confStream.getVideoTracks()[0];
    const at = confStream.getAudioTracks()[0];
    if (vt) selectedCameraId = vt.getSettings().deviceId || '';
    if (at) selectedMicId = at.getSettings().deviceId || '';
    document.getElementById('conf-btn-mic').style.color = '#10b981';
    document.getElementById('conf-btn-cam').style.color = '#10b981';
  } catch {
    try {
      const audioConstraints = { echoCancellation: true, noiseSuppression: true };
      if (selectedMicId) audioConstraints.deviceId = { exact: selectedMicId };
      confStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      const at = confStream.getAudioTracks()[0];
      if (at) selectedMicId = at.getSettings().deviceId || '';
      document.getElementById('conf-btn-cam').style.color = 'var(--text-muted)';
    } catch {
      showToast('Cannot access camera or microphone', 'error');
      confStream = null;
    }
  }
  enumerateDevices();

  addVideoTile('local', confUserName + ' (You)', confStream);
  confParticipants['local'] = { name: confUserName, isOnStage: true };

  const confPage = document.getElementById('conference-page');
  if (confIsHost) {
    confPage.classList.remove('guest-mode');
    toggleConfSidebar('lobby');
  } else {
    confPage.classList.add('guest-mode');
  }

  socket.emit('conf:join', { roomCode, userName: confUserName, peerId: socket.id, isHost: confIsHost });

  socket.on('conf:room-users', (users) => {
    users.forEach(u => {
      confParticipants[u.id] = { name: u.name, isOnStage: true };
      createPeerConnection(u.id, u.name, true);
    });
    updateConfParticipantsList();
    updateConfChatRecipients();
  });

  socket.on('conf:lobby-waiting', ({ message }) => {
    document.getElementById('conf-lobby-screen').classList.remove('hidden');
    document.getElementById('conf-lobby-msg').textContent = message;
  });

  socket.on('conf:admitted', () => {
    document.getElementById('conf-lobby-screen').classList.add('hidden');
    showToast('You have been admitted!', 'success');
  });

  socket.on('conf:denied', ({ message }) => {
    showToast(message, 'error');
    leaveConference();
  });

  socket.on('conf:removed', ({ message }) => {
    showToast(message, 'error');
    leaveConference();
  });

  socket.on('conf:lobby-request', ({ id, name }) => {
    showLobbyNotification(id, name);
  });

  socket.on('conf:user-joined', (u) => {
    confParticipants[u.id] = { name: u.name, isOnStage: true };
    createPeerConnection(u.id, u.name, false);
    updateConfParticipantsList();
    updateConfChatRecipients();
    showToast(u.name + ' joined', 'success');
  });

  socket.on('conf:signal', ({ from, signal }) => {
    if (confPeers[from]) confPeers[from].peer.signal(signal);
  });

  socket.on('conf:user-left', ({ id }) => {
    const name = confParticipants[id]?.name || 'Someone';
    if (confPeers[id]) { confPeers[id].peer.destroy(); delete confPeers[id]; }
    delete confParticipants[id];
    const tile = document.getElementById('conf-tile-' + id);
    if (tile) tile.remove();
    updateConfParticipantsList();
    updateConfChatRecipients();
    showToast(name + ' left', 'info');
  });

  socket.on('conf:participant-count', (count) => {
    document.getElementById('conf-participant-count').textContent = count + ' participant' + (count !== 1 ? 's' : '');
    const pc = document.getElementById('conf-p-count');
    if (pc) pc.textContent = count;
  });

  socket.on('conf:chat', ({ userName, message, time, to }) => {
    if (!to || to === 'all' || to === socket.id) {
      appendConfChat(userName, message, time, to && to !== 'all');
    }
  });

  socket.on('conf:name-updated', ({ id, name }) => {
    if (confParticipants[id]) confParticipants[id].name = name;
    if (confPeers[id]) confPeers[id].name = name;
    const tile = document.getElementById('conf-tile-' + id);
    if (tile) {
      const label = tile.querySelector('.conf-tile-label');
      if (label) label.textContent = name;
    }
    updateConfParticipantsList();
    updateConfChatRecipients();
  });

  socket.on('conf:lower-third', ({ id, name, title }) => {
    const tile = document.getElementById('conf-tile-' + id);
    if (!tile) return;
    let lt = tile.querySelector('.conf-lt');
    if (!name && !title) { if (lt) lt.remove(); return; }
    if (!lt) {
      lt = document.createElement('div');
      lt.className = 'conf-lt';
      lt.style.cssText = 'position:absolute;bottom:40px;left:12px;background:linear-gradient(135deg,rgba(0,212,255,0.9),rgba(124,58,237,0.9));padding:6px 14px;border-radius:8px;z-index:5;';
      tile.appendChild(lt);
    }
    lt.innerHTML = `<div style="font-weight:700;font-size:0.9rem;color:#fff;">${escapeHtml(name || '')}</div>${title ? `<div style="font-size:0.75rem;color:rgba(255,255,255,0.8);">${escapeHtml(title)}</div>` : ''}`;
  });

  socket.on('conf:error', ({ message }) => {
    showToast(message, 'error');
  });
}

// ===== PEER CONNECTIONS =====
function createPeerConnection(remoteId, remoteName, initiator) {
  if (typeof SimplePeer === 'undefined') {
    showToast('Video peer library not available', 'error');
    return;
  }
  const peer = new SimplePeer({
    initiator,
    stream: confStream || undefined,
    trickle: true,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }
  });
  peer.on('signal', (signal) => socket.emit('conf:signal', { to: remoteId, signal }));
  peer.on('stream', (remoteStream) => addVideoTile(remoteId, remoteName, remoteStream));
  peer.on('close', () => { delete confPeers[remoteId]; const t = document.getElementById('conf-tile-' + remoteId); if (t) t.remove(); });
  peer.on('error', (err) => console.error('Peer error:', err));
  confPeers[remoteId] = { peer, name: remoteName };
}

function addVideoTile(id, name, stream) {
  const grid = document.getElementById('conf-video-grid');
  let tile = document.getElementById('conf-tile-' + id);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = 'conf-tile-' + id;
    tile.style.cssText = 'position:relative;background:#111;border-radius:12px;overflow:hidden;aspect-ratio:16/9;min-height:200px;';
    tile.innerHTML = `
      <video autoplay playsinline ${id === 'local' ? 'muted' : ''} style="width:100%;height:100%;object-fit:contain;background:#000;"></video>
      <div class="conf-tile-label" style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.6);padding:4px 10px;border-radius:6px;font-size:0.8rem;color:#fff;">${escapeHtml(name)}</div>
    `;
    grid.appendChild(tile);
  }
  const video = tile.querySelector('video');
  if (stream) video.srcObject = stream;
  if (id !== 'local' && selectedSpeakerId && video.setSinkId) {
    video.setSinkId(selectedSpeakerId).catch(() => {});
  }
}

// ===== CONTROLS =====
function toggleConfMic() {
  if (!confStream) return;
  const track = confStream.getAudioTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    document.getElementById('conf-btn-mic').style.color = track.enabled ? '#10b981' : 'var(--accent-red)';
    document.getElementById('conf-btn-mic').querySelector('i').className = track.enabled ? 'fas fa-microphone' : 'fas fa-microphone-slash';
  }
}

function toggleConfCam() {
  if (!confStream) return;
  const track = confStream.getVideoTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    document.getElementById('conf-btn-cam').style.color = track.enabled ? '#10b981' : 'var(--accent-red)';
    document.getElementById('conf-btn-cam').querySelector('i').className = track.enabled ? 'fas fa-video' : 'fas fa-video-slash';
  }
}

async function toggleConfScreen() {
  if (confScreenStream) {
    confScreenStream.getTracks().forEach(t => t.stop());
    confScreenStream = null;
    document.getElementById('conf-btn-screen').style.color = '';
    if (confStream) {
      Object.values(confPeers).forEach(({ peer }) => {
        const vt = confStream.getVideoTracks()[0];
        if (vt) { const s = peer._pc?.getSenders().find(s => s.track?.kind === 'video'); if (s) s.replaceTrack(vt); }
      });
      const lv = document.querySelector('#conf-tile-local video');
      if (lv) lv.srcObject = confStream;
    }
    return;
  }
  try {
    const csq = confQualityMap[confQuality] || confQualityMap['full-hd'];
    confScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: csq.w }, height: { ideal: csq.h }, cursor: 'always' },
      selfBrowserSurface: 'include',
      surfaceSwitching: 'include'
    });
    document.getElementById('conf-btn-screen').style.color = '#10b981';
    const st = confScreenStream.getVideoTracks()[0];
    Object.values(confPeers).forEach(({ peer }) => {
      const s = peer._pc?.getSenders().find(s => s.track?.kind === 'video');
      if (s) s.replaceTrack(st);
    });
    const lv = document.querySelector('#conf-tile-local video');
    if (lv) lv.srcObject = confScreenStream;
    st.onended = () => toggleConfScreen();
  } catch { showToast('Screen sharing cancelled', 'info'); }
}

async function changeConfQuality() {
  const val = document.getElementById('conf-quality-live').value;
  confQuality = val;
  const q = confQualityMap[val];
  if (!confStream) return;
  try {
    const videoConstraints = { width: { ideal: q.w }, height: { ideal: q.h } };
    if (selectedCameraId) videoConstraints.deviceId = { exact: selectedCameraId };
    const audioConstraints = { echoCancellation: true, noiseSuppression: true };
    if (selectedMicId) audioConstraints.deviceId = { exact: selectedMicId };
    const newStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints });
    confStream.getTracks().forEach(t => t.stop());
    confStream = newStream;
    const lv = document.querySelector('#conf-tile-local video');
    if (lv) lv.srcObject = confStream;
    const vt = confStream.getVideoTracks()[0];
    const at = confStream.getAudioTracks()[0];
    Object.values(confPeers).forEach(({ peer }) => {
      const senders = peer._pc?.getSenders() || [];
      senders.forEach(s => {
        if (s.track?.kind === 'video' && vt) s.replaceTrack(vt);
        if (s.track?.kind === 'audio' && at) s.replaceTrack(at);
      });
    });
    showToast('Quality changed to ' + val.replace('-', ' ').toUpperCase(), 'success');
  } catch { showToast('Failed to change quality', 'error'); }
}

async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const camSel = document.getElementById('conf-camera-select');
    const micSel = document.getElementById('conf-mic-select');
    const spkSel = document.getElementById('conf-speaker-select');
    if (camSel) {
      const cams = devices.filter(d => d.kind === 'videoinput');
      camSel.innerHTML = cams.length === 0
        ? '<option value="">No camera found</option>'
        : cams.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === selectedCameraId ? 'selected' : ''}>${d.label || 'Camera ' + (i + 1)}</option>`).join('');
    }
    if (micSel) {
      const mics = devices.filter(d => d.kind === 'audioinput');
      micSel.innerHTML = mics.length === 0
        ? '<option value="">No microphone found</option>'
        : mics.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === selectedMicId ? 'selected' : ''}>${d.label || 'Microphone ' + (i + 1)}</option>`).join('');
    }
    if (spkSel) {
      const spks = devices.filter(d => d.kind === 'audiooutput');
      if (spks.length === 0) {
        spkSel.innerHTML = '<option value="">Default</option>';
      } else {
        spkSel.innerHTML = spks.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === selectedSpeakerId ? 'selected' : ''}>${d.label || 'Speaker ' + (i + 1)}</option>`).join('');
      }
    }
  } catch (err) { console.error('enumerateDevices error:', err); }
}

async function changeConfCamera() {
  const sel = document.getElementById('conf-camera-select');
  if (!sel) return;
  selectedCameraId = sel.value;
  if (!confStream) return;
  const q = confQualityMap[confQuality] || confQualityMap['full-hd'];
  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: selectedCameraId }, width: { ideal: q.w }, height: { ideal: q.h } },
      audio: false
    });
    const oldVideo = confStream.getVideoTracks();
    oldVideo.forEach(t => { confStream.removeTrack(t); t.stop(); });
    const newVideoTrack = videoStream.getVideoTracks()[0];
    confStream.addTrack(newVideoTrack);
    selectedCameraId = newVideoTrack.getSettings().deviceId || selectedCameraId;
    const lv = document.querySelector('#conf-tile-local video');
    if (lv) lv.srcObject = confStream;
    Object.values(confPeers).forEach(({ peer }) => {
      const senders = peer._pc?.getSenders() || [];
      senders.forEach(s => {
        if (s.track?.kind === 'video') s.replaceTrack(newVideoTrack);
      });
    });
    document.getElementById('conf-btn-cam').style.color = '#10b981';
    showToast('Camera changed', 'success');
  } catch (err) {
    console.error('changeConfCamera error:', err);
    showToast('Failed to switch camera: ' + (err.message || err), 'error');
  }
}

async function changeConfMic() {
  const sel = document.getElementById('conf-mic-select');
  if (!sel) return;
  selectedMicId = sel.value;
  if (!confStream) return;
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: selectedMicId }, echoCancellation: true, noiseSuppression: true }
    });
    const oldAudio = confStream.getAudioTracks();
    oldAudio.forEach(t => { confStream.removeTrack(t); t.stop(); });
    const newAudioTrack = audioStream.getAudioTracks()[0];
    confStream.addTrack(newAudioTrack);
    selectedMicId = newAudioTrack.getSettings().deviceId || selectedMicId;
    Object.values(confPeers).forEach(({ peer }) => {
      const senders = peer._pc?.getSenders() || [];
      senders.forEach(s => {
        if (s.track?.kind === 'audio') s.replaceTrack(newAudioTrack);
      });
    });
    document.getElementById('conf-btn-mic').style.color = '#10b981';
    showToast('Microphone changed', 'success');
  } catch (err) {
    console.error('changeConfMic error:', err);
    showToast('Failed to switch microphone', 'error');
  }
}

function changeConfSpeaker() {
  const sel = document.getElementById('conf-speaker-select');
  if (!sel) return;
  selectedSpeakerId = sel.value;
  document.querySelectorAll('#conf-video-grid video').forEach(video => {
    if (video.setSinkId && selectedSpeakerId) {
      video.setSinkId(selectedSpeakerId).catch(err => console.error('setSinkId error:', err));
    }
  });
  showToast('Speaker changed', 'success');
}

function updateConfName() {
  const name = document.getElementById('conf-display-name').value.trim();
  if (!name) return;
  confUserName = name;
  confParticipants['local'].name = name;
  const label = document.querySelector('#conf-tile-local .conf-tile-label');
  if (label) label.textContent = name + ' (You)';
  socket.emit('conf:update-name', { roomCode: confRoomCode, name });
  updateConfParticipantsList();
  showToast('Name updated', 'success');
}

// ===== SIDEBAR =====
function toggleConfSidebar(tabName) {
  const sidebar = document.getElementById('conf-sidebar');
  if (!sidebar) return;
  const isOpen = !sidebar.classList.contains('hidden');
  if (isOpen) {
    const activeTab = sidebar.querySelector('.conf-sidebar-tab.active');
    if (activeTab && activeTab.dataset.tab === tabName) {
      sidebar.classList.add('hidden');
      return;
    }
  }
  sidebar.classList.remove('hidden');
  switchConfSidebarTab(tabName);
}

function switchConfSidebarTab(tabName) {
  const sidebar = document.getElementById('conf-sidebar');
  if (!sidebar) return;
  sidebar.querySelectorAll('.conf-sidebar-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
    t.style.color = t.dataset.tab === tabName ? 'var(--text-primary)' : 'var(--text-muted)';
  });
  sidebar.querySelectorAll('.conf-sidebar-content').forEach(c => {
    if (c.dataset.content === tabName) c.classList.remove('hidden');
    else c.classList.add('hidden');
  });
}

// ===== PARTICIPANTS =====
function updateConfParticipantsList() {
  const list = document.getElementById('conf-participants-list');
  if (!list) return;
  list.innerHTML = Object.entries(confParticipants).map(([id, p]) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--bg-input);">
      <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#10b981,#00d4ff);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;color:#fff;">${p.name.charAt(0).toUpperCase()}</div>
      <div style="flex:1;">
        <div style="font-size:0.85rem;font-weight:600;">${escapeHtml(p.name)}${id === 'local' ? ' (You)' : ''}</div>
      </div>
      ${confIsHost && id !== 'local' ? `<button class="btn btn-sm" onclick="removeParticipant('${id}')" title="Remove"><i class="fas fa-times" style="color:var(--accent-red);"></i></button>` : ''}
    </div>
  `).join('');
}

function removeParticipant(targetId) {
  if (!confirm('Remove this participant?')) return;
  socket.emit('conf:remove', { roomCode: confRoomCode, targetId });
}

// ===== LOBBY =====
function playLobbySound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 600;
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
    setTimeout(() => { const o2 = ctx.createOscillator(); o2.connect(gain); o2.frequency.value = 800; o2.start(); o2.stop(ctx.currentTime + 0.15); }, 200);
  } catch {}
}

function showLobbyNotification(guestId, guestName) {
  playLobbySound();

  const container = document.getElementById('conf-lobby-notifications');
  const notif = document.createElement('div');
  notif.id = 'lobby-notif-' + guestId;
  notif.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border-color);border-left:4px solid #f59e0b;border-radius:10px;padding:14px 16px;box-shadow:0 4px 20px rgba(0,0,0,0.3);animation:slideIn 0.3s ease;';
  notif.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
      <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#ef4444);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;">${guestName.charAt(0).toUpperCase()}</div>
      <div><div style="font-weight:600;font-size:0.9rem;">${escapeHtml(guestName)}</div><div style="font-size:0.75rem;color:var(--text-muted);">Waiting in lobby</div></div>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-sm" onclick="admitGuest('${guestId}')" style="flex:1;background:#10b981;color:#fff;"><i class="fas fa-check"></i> Admit</button>
      <button class="btn btn-sm" onclick="denyGuest('${guestId}')" style="flex:1;background:var(--accent-red);color:#fff;"><i class="fas fa-times"></i> Deny</button>
    </div>
  `;
  container.appendChild(notif);
  setTimeout(() => { if (notif.parentNode) notif.remove(); }, 10000);

  const lobbyList = document.getElementById('conf-sidebar-lobby-list');
  if (lobbyList) {
    const placeholder = lobbyList.parentNode.querySelector('div[style*="text-align:center"]');
    if (placeholder) placeholder.style.display = 'none';
    const entry = document.createElement('div');
    entry.id = 'lobby-entry-' + guestId;
    entry.style.cssText = 'background:var(--bg-card);border-radius:10px;border:1px solid var(--border-color);padding:10px;';
    entry.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#ef4444);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:0.85rem;flex-shrink:0;">${guestName.charAt(0).toUpperCase()}</div>
        <div style="flex:1;min-width:0;">
          <input type="text" id="lobby-name-${guestId}" value="${escapeHtml(guestName)}" style="background:var(--bg-input);border:1px solid var(--border-color);border-radius:6px;padding:4px 8px;color:var(--text-primary);font-size:0.85rem;width:100%;font-weight:600;" title="Edit guest name">
          <div style="font-size:0.7rem;color:#f59e0b;margin-top:2px;">Waiting in lobby</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-sm" onclick="admitGuest('${guestId}')" style="flex:1;background:#10b981;color:#fff;font-size:0.8rem;">Admit</button>
        <button class="btn btn-sm" onclick="denyGuest('${guestId}')" style="flex:1;background:var(--accent-red);color:#fff;font-size:0.8rem;">Deny</button>
      </div>
    `;
    lobbyList.appendChild(entry);
  }
}

function admitGuest(guestId) {
  const nameInput = document.getElementById('lobby-name-' + guestId);
  const editedName = nameInput ? nameInput.value.trim() : '';
  socket.emit('conf:admit', { roomCode: confRoomCode, guestId, editedName: editedName || undefined });
  const notif = document.getElementById('lobby-notif-' + guestId);
  if (notif) notif.remove();
  const entry = document.getElementById('lobby-entry-' + guestId);
  if (entry) entry.remove();
  updateLobbyPlaceholder();
}

function denyGuest(guestId) {
  socket.emit('conf:deny', { roomCode: confRoomCode, guestId });
  const notif = document.getElementById('lobby-notif-' + guestId);
  if (notif) notif.remove();
  const entry = document.getElementById('lobby-entry-' + guestId);
  if (entry) entry.remove();
  updateLobbyPlaceholder();
}

function updateLobbyPlaceholder() {
  const lobbyList = document.getElementById('conf-sidebar-lobby-list');
  if (!lobbyList) return;
  const placeholder = lobbyList.parentNode.querySelector('div[style*="text-align:center"]');
  if (placeholder) placeholder.style.display = lobbyList.children.length === 0 ? '' : 'none';
}

// ===== CHAT =====
function updateConfChatRecipients() {
  const sel = document.getElementById('conf-chat-mode');
  if (!sel) return;
  sel.innerHTML = '<option value="all">Everyone</option>';
  Object.entries(confParticipants).forEach(([id, p]) => {
    if (id !== 'local') sel.innerHTML += `<option value="${id}">${escapeHtml(p.name)}</option>`;
  });
}

function sendConfChat() {
  const input = document.getElementById('conf-chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  const to = document.getElementById('conf-chat-mode')?.value || 'all';
  socket.emit('conf:chat', { roomCode: confRoomCode, userName: confUserName, message: msg, to });
  if (to !== 'all') appendConfChat(confUserName, msg, null, true);
  input.value = '';
}

function appendConfChat(userName, message, time, isPrivate) {
  const container = document.getElementById('conf-chat-messages');
  const div = document.createElement('div');
  div.style.cssText = 'padding:6px 10px;background:var(--bg-input);border-radius:8px;' + (isPrivate ? 'border-left:3px solid #7c3aed;' : '');
  div.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;"><span style="font-size:0.75rem;color:var(--accent);font-weight:600;">${escapeHtml(userName)}</span>${isPrivate ? '<span style="font-size:0.65rem;color:#7c3aed;background:rgba(124,58,237,0.15);padding:1px 6px;border-radius:4px;">Private</span>' : ''}</div>
    <div style="font-size:0.85rem;margin-top:2px;">${escapeHtml(message)}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ===== LOWER THIRD =====
function toggleConfLowerThird() {
  const bar = document.getElementById('conf-lower-third-bar');
  bar.classList.toggle('hidden');
  document.getElementById('conf-btn-lower-third').style.color = bar.classList.contains('hidden') ? '' : '#10b981';
}

function applyConfLowerThird() {
  const name = document.getElementById('conf-lt-name').value.trim();
  const title = document.getElementById('conf-lt-title').value.trim();
  socket.emit('conf:lower-third', { roomCode: confRoomCode, id: 'local', name, title });
  const tile = document.getElementById('conf-tile-local');
  if (tile) {
    let lt = tile.querySelector('.conf-lt');
    if (!lt) {
      lt = document.createElement('div');
      lt.className = 'conf-lt';
      lt.style.cssText = 'position:absolute;bottom:40px;left:12px;background:linear-gradient(135deg,rgba(0,212,255,0.9),rgba(124,58,237,0.9));padding:6px 14px;border-radius:8px;z-index:5;';
      tile.appendChild(lt);
    }
    lt.innerHTML = `<div style="font-weight:700;font-size:0.9rem;color:#fff;">${escapeHtml(name)}</div>${title ? `<div style="font-size:0.75rem;color:rgba(255,255,255,0.8);">${escapeHtml(title)}</div>` : ''}`;
  }
  showToast('Lower third applied', 'success');
}

function clearConfLowerThird() {
  document.getElementById('conf-lt-name').value = '';
  document.getElementById('conf-lt-title').value = '';
  socket.emit('conf:lower-third', { roomCode: confRoomCode, id: 'local', name: '', title: '' });
  const lt = document.querySelector('#conf-tile-local .conf-lt');
  if (lt) lt.remove();
}

// ===== AI =====
async function confAiSummarize() {
  const modal = document.getElementById('conf-ai-modal');
  const content = document.getElementById('conf-ai-content');
  const title = document.getElementById('conf-ai-title');
  title.textContent = 'AI Meeting Summary';
  content.innerHTML = '<div style="color:var(--text-muted);"><i class="fas fa-circle-notch fa-spin"></i> Analyzing conversation...</div>';
  modal.classList.remove('hidden');

  const msgs = Array.from(document.querySelectorAll('#conf-chat-messages > div')).map(d => d.textContent).join('\n');
  const roomName = document.getElementById('conf-title').textContent;
  const participants = Object.values(confParticipants).map(p => p.name).join(', ');

  try {
    const res = await fetch(API + '/api/conference/ai/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ roomCode: confRoomCode, roomName, participants, chatMessages: msgs })
    });
    const data = await res.json();
    content.textContent = data.summary || 'No summary available.';
  } catch {
    content.textContent = 'Failed to generate summary.';
  }
}

async function confAiActionItems() {
  const modal = document.getElementById('conf-ai-modal');
  const content = document.getElementById('conf-ai-content');
  const title = document.getElementById('conf-ai-title');
  title.textContent = 'AI Action Items';
  content.innerHTML = '<div style="color:var(--text-muted);"><i class="fas fa-circle-notch fa-spin"></i> Extracting action items...</div>';
  modal.classList.remove('hidden');

  const msgs = Array.from(document.querySelectorAll('#conf-chat-messages > div')).map(d => d.textContent).join('\n');
  const roomName = document.getElementById('conf-title').textContent;

  try {
    const res = await fetch(API + '/api/conference/ai/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ roomCode: confRoomCode, roomName, chatMessages: msgs })
    });
    const data = await res.json();
    content.textContent = data.actions || 'No action items found.';
  } catch {
    content.textContent = 'Failed to extract action items.';
  }
}

// ===== HISTORY =====
async function viewMessages(roomCode, roomName) {
  try {
    const { messages } = await apiFetch('/api/conference/' + roomCode + '/messages');
    const modal = document.getElementById('history-modal');
    document.getElementById('history-modal-title').innerHTML = '<i class="fas fa-comment" style="color:var(--accent);"></i> ' + escapeHtml(roomName) + ' - Chat';
    const content = document.getElementById('history-modal-content');
    content.innerHTML = messages.length > 0
      ? messages.map(m => `<div style="margin-bottom:8px;"><strong style="color:var(--accent);">${escapeHtml(m.user_name)}</strong> <span style="color:var(--text-muted);font-size:0.75rem;">${new Date(m.created_at).toLocaleTimeString()}</span><br><span style="font-size:0.85rem;">${escapeHtml(m.message)}</span></div>`).join('')
      : '<p style="color:var(--text-muted);text-align:center;">No messages</p>';
    modal.classList.add('active');
  } catch (err) { showToast(err.message, 'error'); }
}

async function viewAI(roomCode, roomName) {
  try {
    const { rooms } = await apiFetch('/api/conferences');
    const conf = rooms.find(r => r.room_code === roomCode);
    const modal = document.getElementById('history-modal');
    document.getElementById('history-modal-title').innerHTML = '<i class="fas fa-robot" style="color:#7c3aed;"></i> ' + escapeHtml(roomName) + ' - AI';
    const summary = conf?.ai_summary || '<em style="color:var(--text-muted);">No summary yet</em>';
    const actions = conf?.ai_actions || '<em style="color:var(--text-muted);">No action items yet</em>';
    document.getElementById('history-modal-content').innerHTML = `
      <div style="margin-bottom:16px;">
        <h4 style="color:var(--accent);margin-bottom:8px;">Summary</h4>
        <div style="font-size:0.85rem;line-height:1.7;white-space:pre-wrap;">${summary}</div>
      </div>
      <div>
        <h4 style="color:#10b981;margin-bottom:8px;">Action Items</h4>
        <div style="font-size:0.85rem;line-height:1.7;white-space:pre-wrap;">${actions}</div>
      </div>
    `;
    modal.classList.add('active');
  } catch (err) { showToast(err.message, 'error'); }
}

async function downloadLog(roomCode, roomName) {
  try {
    const [msgRes, confRes] = await Promise.all([
      apiFetch('/api/conference/' + roomCode + '/messages'),
      apiFetch('/api/conferences')
    ]);
    const conf = confRes.rooms.find(r => r.room_code === roomCode);
    let text = `Conference: ${roomName}\nCode: ${roomCode}\nCreated: ${conf?.created_at || ''}\nEnded: ${conf?.ended_at || ''}\n\n`;
    text += '=== CHAT LOG ===\n';
    text += msgRes.messages.length > 0
      ? msgRes.messages.map(m => `[${new Date(m.created_at).toLocaleString()}] ${m.user_name}: ${m.message}`).join('\n')
      : 'No messages';
    if (conf?.ai_summary) text += '\n\n=== AI SUMMARY ===\n' + conf.ai_summary;
    if (conf?.ai_actions) text += '\n\n=== AI ACTION ITEMS ===\n' + conf.ai_actions;
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `conference-${roomName.replace(/[^a-zA-Z0-9]/g, '-')}-${roomCode}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { showToast(err.message, 'error'); }
}

// ===== INVITE & LEAVE =====
function copyConfLink() {
  const link = window.location.origin + API + '/room/' + confRoomCode;
  navigator.clipboard.writeText(link).then(() => showToast('Invite link copied!', 'success'));
}

function leaveConference() {
  if (socket) {
    socket.emit('conf:leave');
    ['conf:room-users','conf:user-joined','conf:signal','conf:user-left','conf:participant-count','conf:chat','conf:error','conf:name-updated','conf:lower-third','conf:lobby-waiting','conf:admitted','conf:denied','conf:removed','conf:lobby-request'].forEach(e => socket.off(e));
  }
  Object.values(confPeers).forEach(({ peer }) => peer.destroy());
  confPeers = {};
  confParticipants = {};
  if (confStream) { confStream.getTracks().forEach(t => t.stop()); confStream = null; }
  if (confScreenStream) { confScreenStream.getTracks().forEach(t => t.stop()); confScreenStream = null; }
  document.getElementById('conf-video-grid').innerHTML = '';
  document.getElementById('conf-chat-messages').innerHTML = '';
  document.getElementById('conference-page').classList.add('hidden');
  document.getElementById('conference-page').classList.remove('guest-mode');
  document.getElementById('conf-ai-modal')?.classList.add('hidden');
  document.getElementById('conf-sidebar')?.classList.add('hidden');
  document.getElementById('conf-lobby-notifications').innerHTML = '';
  const lobbyList = document.getElementById('conf-sidebar-lobby-list');
  if (lobbyList) lobbyList.innerHTML = '';

  confRoomCode = null;
  confIsHost = false;

  if (token && user) {
    document.getElementById('dashboard-page').classList.remove('hidden');
    loadConferences();
  } else {
    window.location.href = API + '/';
  }
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', init);
