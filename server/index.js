require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

const BASE = process.env.BASE_PATH || '/conference';
const PORT = process.env.PORT || 3020;
const JWT_SECRET = process.env.JWT_SECRET || 'conference_secret_2026';

const io = new Server(server, {
  path: BASE + '/socket.io/',
  cors: { origin: '*' }
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Too many requests' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, message: { error: 'Too many login attempts' } });
app.use(BASE + '/api/', apiLimiter);
app.use(BASE + '/api/login', authLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(BASE, express.static(path.join(__dirname, '../public')));

// ===== AUTH =====
function authenticateToken(req, res, next) {
  const auth = req.headers['authorization'];
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== AUTH ROUTES =====
app.post(BASE + '/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

app.post(BASE + '/api/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)').run(id, email, hash, name);
  const token = jwt.sign({ id, email, name, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, email, name, role: 'user' } });
});

app.get(BASE + '/api/me', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// ===== CONFERENCE ROUTES =====
app.post(BASE + '/api/conference', authenticateToken, (req, res) => {
  const { name, max_participants, password, scheduled_at } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name is required' });
  const id = uuid();
  const roomCode = crypto.randomBytes(4).toString('hex');
  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;
  const isScheduled = !!scheduled_at;
  const status = isScheduled ? 'scheduled' : 'active';
  const schedValue = (scheduled_at && scheduled_at !== 'later') ? scheduled_at : null;
  db.prepare('INSERT INTO conference_rooms (id, host_id, name, room_code, max_participants, password_hash, scheduled_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, name, roomCode, max_participants || 8, passwordHash, schedValue, status);
  res.json({ id, room_code: roomCode, name, has_password: !!password, scheduled_at, status });
});

app.get(BASE + '/api/conference/:roomCode', (req, res) => {
  const room = db.prepare('SELECT * FROM conference_rooms WHERE room_code = ? AND status = ?').get(req.params.roomCode, 'active');
  if (!room) return res.status(404).json({ error: 'Room not found or ended' });
  res.json({ room: { ...room, has_password: !!room.password_hash, password_hash: undefined } });
});

app.post(BASE + '/api/conference/:roomCode/verify-password', (req, res) => {
  const { password } = req.body;
  const room = db.prepare('SELECT password_hash FROM conference_rooms WHERE room_code = ? AND status = ?').get(req.params.roomCode, 'active');
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.password_hash) return res.json({ valid: true });
  if (!password || !bcrypt.compareSync(password, room.password_hash)) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ valid: true });
});

app.get(BASE + '/api/conferences', authenticateToken, (req, res) => {
  const rooms = db.prepare('SELECT * FROM conference_rooms WHERE host_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  const result = rooms.map(r => {
    const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM conference_messages WHERE room_id = ?').get(r.id);
    return { ...r, has_password: !!r.password_hash, password_hash: undefined, message_count: msgCount?.cnt || 0 };
  });
  res.json({ rooms: result });
});

app.post(BASE + '/api/conference/:roomCode/end', authenticateToken, (req, res) => {
  const room = db.prepare('SELECT * FROM conference_rooms WHERE room_code = ? AND host_id = ?').get(req.params.roomCode, req.user.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  db.prepare('UPDATE conference_rooms SET status = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?').run('ended', room.id);
  res.json({ success: true });
});

app.post(BASE + '/api/conference/:roomCode/start', authenticateToken, (req, res) => {
  const room = db.prepare('SELECT * FROM conference_rooms WHERE room_code = ? AND host_id = ?').get(req.params.roomCode, req.user.id);
  if (!room) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE conference_rooms SET status = ? WHERE id = ?').run('active', room.id);
  res.json({ success: true, room_code: room.room_code });
});

app.delete(BASE + '/api/conference/:roomCode', authenticateToken, (req, res) => {
  const room = db.prepare('SELECT id, host_id FROM conference_rooms WHERE room_code = ?').get(req.params.roomCode);
  if (!room || room.host_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM conference_messages WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM conference_rooms WHERE id = ?').run(room.id);
  res.json({ success: true });
});

app.get(BASE + '/api/conference/:roomCode/messages', authenticateToken, (req, res) => {
  const room = db.prepare('SELECT id, host_id FROM conference_rooms WHERE room_code = ?').get(req.params.roomCode);
  if (!room || room.host_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const msgs = db.prepare('SELECT user_name, message, created_at FROM conference_messages WHERE room_id = ? ORDER BY created_at').all(room.id);
  res.json({ messages: msgs });
});

app.post(BASE + '/api/conference/:roomCode/save-analysis', authenticateToken, (req, res) => {
  const { summary, actions } = req.body;
  const room = db.prepare('SELECT id, host_id FROM conference_rooms WHERE room_code = ?').get(req.params.roomCode);
  if (!room || room.host_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (summary) db.prepare('UPDATE conference_rooms SET ai_summary = ? WHERE id = ?').run(summary, room.id);
  if (actions) db.prepare('UPDATE conference_rooms SET ai_actions = ? WHERE id = ?').run(actions, room.id);
  res.json({ success: true });
});

// ===== AI ENDPOINTS =====
app.post(BASE + '/api/conference/ai/summarize', authenticateToken, async (req, res) => {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI not configured' });
  const { roomCode, roomName, participants, chatMessages } = req.body;

  const room = db.prepare('SELECT id FROM conference_rooms WHERE room_code = ?').get(roomCode);
  let dbMessages = '';
  if (room) {
    const msgs = db.prepare('SELECT user_name, message, created_at FROM conference_messages WHERE room_id = ? ORDER BY created_at').all(room.id);
    dbMessages = msgs.map(m => `[${m.user_name}]: ${m.message}`).join('\n');
  }
  const allMessages = (dbMessages + '\n' + (chatMessages || '')).trim();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: 'You are a meeting assistant. Provide a concise, well-structured summary of the meeting discussion. Include key topics, decisions made, and important points raised by participants. Format with bullet points.',
        messages: [{ role: 'user', content: `Meeting: ${roomName}\nParticipants: ${participants}\n\nConversation:\n${allMessages}\n\nPlease provide a summary of this meeting.` }]
      })
    });
    const data = await response.json();
    const summary = data.content?.[0]?.text || 'Unable to generate summary.';
    if (room) db.prepare('UPDATE conference_rooms SET ai_summary = ? WHERE id = ?').run(summary, room.id);
    res.json({ summary });
  } catch (err) {
    console.error('AI summarize error:', err);
    res.json({ summary: 'Failed to generate summary.' });
  }
});

app.post(BASE + '/api/conference/ai/actions', authenticateToken, async (req, res) => {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI not configured' });
  const { roomCode, roomName, chatMessages } = req.body;

  const room = db.prepare('SELECT id FROM conference_rooms WHERE room_code = ?').get(roomCode);
  let dbMessages = '';
  if (room) {
    const msgs = db.prepare('SELECT user_name, message, created_at FROM conference_messages WHERE room_id = ? ORDER BY created_at').all(room.id);
    dbMessages = msgs.map(m => `[${m.user_name}]: ${m.message}`).join('\n');
  }
  const allMessages = (dbMessages + '\n' + (chatMessages || '')).trim();

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: 'You are a meeting assistant. Extract all action items, tasks, and follow-ups from the meeting conversation. For each action item, identify who is responsible (if mentioned) and any deadlines. Format as a numbered list.',
        messages: [{ role: 'user', content: `Meeting: ${roomName}\n\nConversation:\n${allMessages}\n\nPlease extract all action items from this meeting.` }]
      })
    });
    const data = await response.json();
    const actions = data.content?.[0]?.text || 'No action items found.';
    if (room) db.prepare('UPDATE conference_rooms SET ai_actions = ? WHERE id = ?').run(actions, room.id);
    res.json({ actions });
  } catch (err) {
    console.error('AI actions error:', err);
    res.json({ actions: 'Failed to extract action items.' });
  }
});

// Public conference join page
app.get(BASE + '/room/:roomCode', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// SPA fallback
app.get(BASE + '/*', (req, res) => {
  if (!req.path.includes('/api/')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});
app.get(BASE, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ===== SOCKET.IO - Conference WebRTC =====
const confRooms = {};

io.on('connection', (socket) => {
  socket.on('conf:join', ({ roomCode, userName, peerId, isHost }) => {
    if (!confRooms[roomCode]) confRooms[roomCode] = { participants: {}, lobby: {}, hostSocketId: null };
    const room = confRooms[roomCode];

    const dbRoom = db.prepare('SELECT max_participants, status, host_id FROM conference_rooms WHERE room_code = ?').get(roomCode);
    if (!dbRoom || dbRoom.status !== 'active') {
      socket.emit('conf:error', { message: 'Room not found or has ended' });
      return;
    }

    socket.join('conf:' + roomCode);
    socket.confRoom = roomCode;

    if (isHost) {
      room.hostSocketId = socket.id;
      room.participants[socket.id] = { name: userName, peerId };

      const existing = Object.entries(room.participants)
        .filter(([id]) => id !== socket.id)
        .map(([id, p]) => ({ id, name: p.name, peerId: p.peerId }));
      socket.emit('conf:room-users', existing);
      io.to('conf:' + roomCode).emit('conf:participant-count', Object.keys(room.participants).length);

      Object.entries(room.lobby).forEach(([lobbyId, lobbyUser]) => {
        socket.emit('conf:lobby-request', { id: lobbyId, name: lobbyUser.name });
      });
    } else {
      if (Object.keys(room.participants).length >= dbRoom.max_participants) {
        socket.emit('conf:error', { message: 'Room is full' });
        return;
      }
      room.lobby[socket.id] = { name: userName, peerId };
      socket.emit('conf:lobby-waiting', { message: 'Waiting for the host to let you in...' });

      if (room.hostSocketId) {
        io.to(room.hostSocketId).emit('conf:lobby-request', { id: socket.id, name: userName });
      }
    }
  });

  socket.on('conf:admit', ({ roomCode, guestId, editedName }) => {
    const room = confRooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    const guest = room.lobby[guestId];
    if (!guest) return;

    if (editedName && editedName !== guest.name) {
      guest.name = editedName;
      io.to(guestId).emit('conf:name-updated', { id: guestId, name: editedName });
    }

    delete room.lobby[guestId];
    room.participants[guestId] = guest;

    io.to(guestId).emit('conf:admitted');

    Object.keys(room.participants).forEach(pid => {
      if (pid !== guestId) {
        io.to(pid).emit('conf:user-joined', { id: guestId, name: guest.name, peerId: guest.peerId });
      }
    });

    const existing = Object.entries(room.participants)
      .filter(([id]) => id !== guestId)
      .map(([id, p]) => ({ id, name: p.name, peerId: p.peerId }));
    io.to(guestId).emit('conf:room-users', existing);

    io.to('conf:' + roomCode).emit('conf:participant-count', Object.keys(room.participants).length);
  });

  socket.on('conf:deny', ({ roomCode, guestId }) => {
    const room = confRooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    delete room.lobby[guestId];
    io.to(guestId).emit('conf:denied', { message: 'The host has denied your request to join.' });
  });

  socket.on('conf:remove', ({ roomCode, targetId }) => {
    const room = confRooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    delete room.participants[targetId];
    io.to(targetId).emit('conf:removed', { message: 'You have been removed from the conference by the host.' });
    socket.to('conf:' + roomCode).emit('conf:user-left', { id: targetId });
    io.to('conf:' + roomCode).emit('conf:participant-count', Object.keys(room.participants).length);
  });

  socket.on('conf:signal', ({ to, signal }) => {
    io.to(to).emit('conf:signal', { from: socket.id, signal });
  });

  socket.on('conf:chat', ({ roomCode, userName, message, to }) => {
    db.prepare('INSERT INTO conference_messages (room_id, user_name, message) VALUES ((SELECT id FROM conference_rooms WHERE room_code = ?), ?, ?)')
      .run(roomCode, userName, message);
    if (to && to !== 'all') {
      io.to(to).emit('conf:chat', { userName, message, time: new Date().toISOString(), to });
    } else {
      io.to('conf:' + roomCode).emit('conf:chat', { userName, message, time: new Date().toISOString(), to: 'all' });
    }
  });

  socket.on('conf:update-name', ({ roomCode, name }) => {
    if (confRooms[roomCode]?.participants[socket.id]) {
      confRooms[roomCode].participants[socket.id].name = name;
    }
    socket.to('conf:' + roomCode).emit('conf:name-updated', { id: socket.id, name });
  });

  socket.on('conf:lower-third', ({ roomCode, id, name, title }) => {
    io.to('conf:' + roomCode).emit('conf:lower-third', { id: socket.id, name, title });
  });

  socket.on('conf:stage-toggle', ({ roomCode, targetId, onStage }) => {
    io.to(targetId).emit('conf:stage-status', { onStage });
  });

  function cleanupSocket(sock) {
    const rc = sock.confRoom;
    if (!rc || !confRooms[rc]) return;
    const room = confRooms[rc];
    delete room.participants[sock.id];
    delete room.lobby[sock.id];
    sock.to('conf:' + rc).emit('conf:user-left', { id: sock.id });
    const count = Object.keys(room.participants).length;
    io.to('conf:' + rc).emit('conf:participant-count', count);
    if (room.hostSocketId === sock.id) {
      Object.keys(room.lobby).forEach(lid => {
        io.to(lid).emit('conf:error', { message: 'The host has left the conference.' });
      });
    }
    if (count === 0 && Object.keys(room.lobby).length === 0) delete confRooms[rc];
  }

  socket.on('conf:leave', () => cleanupSocket(socket));
  socket.on('disconnect', () => cleanupSocket(socket));
});

server.listen(PORT, () => {
  console.log(`Kasamira Conference running on port ${PORT} at ${BASE}`);
});
