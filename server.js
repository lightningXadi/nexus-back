const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

/* ── IN-MEMORY STATE ─────────────────────────────────────────────────────────
   accounts: email → { id, name, email, password, color, tag, avatar, bio, status, spaceIds[] }
   activeSocks: socketId → live user object (online users only)
   spaces: spaceId → space (memberIds = persistent account IDs)
   inviteCodes: code → spaceId
────────────────────────────────────────────────────────────────────────────── */
const accounts    = new Map();
const activeSocks = new Map();
const spaces      = new Map();
const messages    = new Map();
const typingUsers = new Map();
const inviteCodes = new Map();

const safeAccount = (a) => ({
  id: a.id, name: a.name, email: a.email,
  color: a.color, tag: a.tag, avatar: a.avatar || null,
  bio: a.bio || "", status: a.status || "online",
});

const getOnlineUsers = () => Array.from(activeSocks.values());

function broadcastMembers(spaceId) {
  const sp = spaces.get(spaceId);
  if (!sp) return;
  const members = sp.memberIds.map(accId => {
    const live = Array.from(activeSocks.values()).find(u => u.id === accId);
    const acc  = Array.from(accounts.values()).find(a => a.id === accId);
    return live || (acc ? { ...safeAccount(acc), status: "offline" } : null);
  }).filter(Boolean);
  io.to(spaceId).emit("space_members_update", { spaceId, members });
}

function clientSpace(sp) {
  return {
    id: sp.id, name: sp.name, icon: sp.icon, color: sp.color,
    ownerId: sp.ownerId, inviteCode: sp.inviteCode,
    members: sp.memberIds.map(accId => {
      const live = Array.from(activeSocks.values()).find(u => u.id === accId);
      const acc  = Array.from(accounts.values()).find(a => a.id === accId);
      return live || (acc ? { ...safeAccount(acc), status: "offline" } : null);
    }).filter(Boolean),
    categories: sp.categories,
  };
}

/* ── REST AUTH ───────────────────────────────────────────────────────────────*/
app.get("/", (req, res) => res.json({ status: "ok", online: activeSocks.size }));

app.post("/auth/register", (req, res) => {
  const { email, password, name, color, tag } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: "Email, password and name are required." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Invalid email address." });
  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (accounts.has(email.toLowerCase()))
    return res.status(409).json({ error: "An account with this email already exists." });

  const account = {
    id: uuidv4(),
    name: name.trim(),
    email: email.toLowerCase(),
    password,
    color: color || "#6366f1",
    tag: tag || String(Math.floor(1000 + Math.random() * 9000)),
    avatar: null, bio: "", status: "online",
    spaceIds: [],
  };
  accounts.set(account.email, account);
  console.log(`[register] ${account.name} <${account.email}>`);
  res.json({ ok: true, account: safeAccount(account) });
});

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required." });
  const account = accounts.get(email.toLowerCase());
  if (!account)
    return res.status(401).json({ error: "No account found with that email." });
  if (account.password !== password)
    return res.status(401).json({ error: "Incorrect password." });
  // Return their spaces too
  const mySpaces = account.spaceIds.map(id => spaces.get(id)).filter(Boolean).map(clientSpace);
  console.log(`[login] ${account.name}`);
  res.json({ ok: true, account: safeAccount(account), spaces: mySpaces });
});

// Resolve invite → space preview (no auth needed)
app.get("/invite/:code", (req, res) => {
  const spaceId = inviteCodes.get(req.params.code);
  if (!spaceId) return res.status(404).json({ error: "Invalid or expired invite link." });
  const sp = spaces.get(spaceId);
  if (!sp) return res.status(404).json({ error: "Space no longer exists." });
  res.json({ spaceId: sp.id, name: sp.name, icon: sp.icon, color: sp.color, memberCount: sp.memberIds.length });
});

/* ── SOCKET ──────────────────────────────────────────────────────────────────*/
io.on("connection", (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on("auth", (accountData) => {
    const acc = accounts.get(accountData.email?.toLowerCase());
    if (!acc) { socket.emit("auth_error", "Account not found."); return; }

    const liveUser = {
      id: acc.id, socketId: socket.id,
      name: acc.name, email: acc.email,
      color: acc.color, tag: acc.tag,
      avatar: acc.avatar, bio: acc.bio,
      status: acc.status || "online",
    };
    activeSocks.set(socket.id, liveUser);

    const mySpaces = acc.spaceIds.map(id => spaces.get(id)).filter(Boolean).map(clientSpace);
    socket.emit("init", { user: liveUser, spaces: mySpaces });
    io.emit("users_update", getOnlineUsers());
    console.log(`[auth] ${acc.name} online`);
  });

  socket.on("create_space", (data) => {
    const me = activeSocks.get(socket.id);
    if (!me) return;
    const acc = accounts.get(me.email);
    if (!acc) return;
    const inviteCode = uuidv4().slice(0, 8);
    const sp = {
      id: uuidv4(),
      name: data.name, icon: data.icon || "✦", color: data.color || "#6366f1",
      ownerId: acc.id, memberIds: [acc.id], inviteCode,
      categories: [
        {
          id: uuidv4(), name: "General",
          channels: [
            { id: uuidv4(), name: "general", type: "text", desc: "General discussion", unread: 0 },
            { id: uuidv4(), name: "random",  type: "text", desc: "Off-topic chat", unread: 0 },
          ],
        },
        { id: uuidv4(), name: "Voice", channels: [{ id: uuidv4(), name: "Lounge", type: "voice", activeUsers: [] }] },
      ],
    };
    spaces.set(sp.id, sp);
    inviteCodes.set(inviteCode, sp.id);
    acc.spaceIds.push(sp.id);
    socket.join(sp.id);
    socket.emit("space_created", clientSpace(sp));
    console.log(`[space] "${sp.name}" invite=${inviteCode}`);
  });

  socket.on("join_space", (spaceId) => {
    const me = activeSocks.get(socket.id);
    const sp = spaces.get(spaceId);
    if (!me || !sp) return;
    const acc = accounts.get(me.email);
    if (!acc) return;
    if (!sp.memberIds.includes(acc.id)) { sp.memberIds.push(acc.id); acc.spaceIds.push(sp.id); }
    socket.join(spaceId);
    const channelMessages = {};
    sp.categories.flatMap(c => c.channels).forEach(ch => { channelMessages[ch.id] = messages.get(ch.id) || []; });
    socket.emit("space_joined", { space: clientSpace(sp), channelMessages });
    socket.to(spaceId).emit("member_joined", { spaceId, user: me });
    broadcastMembers(spaceId);
    console.log(`[join] ${me.name} → "${sp.name}"`);
  });

  socket.on("join_by_invite", (code) => {
    const spaceId = inviteCodes.get(code);
    if (!spaceId) { socket.emit("invite_error", "Invalid or expired invite code."); return; }
    socket.emit("invite_resolved", { spaceId });
  });

  socket.on("leave_space", (spaceId) => {
    socket.leave(spaceId);
    broadcastMembers(spaceId);
  });

  socket.on("send_message", ({ channelId, spaceId, content }) => {
    const me = activeSocks.get(socket.id);
    if (!me || !content?.trim()) return;
    const msg = {
      id: uuidv4(), authorId: me.id,
      author: { id: me.id, name: me.name, color: me.color, avatar: me.avatar },
      content: content.trim(), ts: new Date(), reactions: [],
    };
    if (!messages.has(channelId)) messages.set(channelId, []);
    messages.get(channelId).push(msg);
    io.to(spaceId).emit("new_message", { channelId, msg });
  });

  socket.on("react", ({ channelId, spaceId, msgId, emoji }) => {
    const me = activeSocks.get(socket.id);
    if (!me) return;
    const list = messages.get(channelId) || [];
    const msg = list.find(m => m.id === msgId);
    if (!msg) return;
    const rx = msg.reactions || [];
    const ri = rx.findIndex(r => r.emoji === emoji);
    if (ri === -1) { rx.push({ emoji, users: [me.id] }); }
    else {
      const r = rx[ri];
      if (r.users.includes(me.id)) { r.users = r.users.filter(u => u !== me.id); if (r.users.length === 0) rx.splice(ri, 1); }
      else r.users.push(me.id);
    }
    msg.reactions = rx;
    io.to(spaceId).emit("reaction_update", { channelId, msgId, reactions: rx });
  });

  socket.on("typing_start", ({ channelId, spaceId }) => {
    const me = activeSocks.get(socket.id);
    if (!me) return;
    if (!typingUsers.has(channelId)) typingUsers.set(channelId, new Set());
    typingUsers.get(channelId).add(me.name);
    socket.to(spaceId).emit("typing_update", { channelId, typing: Array.from(typingUsers.get(channelId)) });
  });

  socket.on("typing_stop", ({ channelId, spaceId }) => {
    const me = activeSocks.get(socket.id);
    if (!me) return;
    typingUsers.get(channelId)?.delete(me.name);
    socket.to(spaceId).emit("typing_update", { channelId, typing: Array.from(typingUsers.get(channelId) || []) });
  });

  socket.on("add_channel", ({ spaceId, catId, channel }) => {
    const sp = spaces.get(spaceId);
    if (!sp) return;
    const cat = sp.categories.find(c => c.id === catId);
    if (!cat) return;
    const ch = { id: uuidv4(), ...channel, unread: 0 };
    cat.channels.push(ch);
    io.to(spaceId).emit("channel_added", { spaceId, catId, channel: ch });
  });

  socket.on("update_status", (status) => {
    const me = activeSocks.get(socket.id);
    if (!me) return;
    me.status = status;
    const acc = accounts.get(me.email);
    if (acc) acc.status = status;
    io.emit("users_update", getOnlineUsers());
  });

  socket.on("update_avatar", ({ avatar, name, bio }) => {
    const me = activeSocks.get(socket.id);
    if (!me) return;
    if (avatar !== undefined) me.avatar = avatar;
    if (name) me.name = name;
    if (bio !== undefined) me.bio = bio;
    const acc = accounts.get(me.email);
    if (acc) { if (avatar !== undefined) acc.avatar = avatar; if (name) acc.name = name; if (bio !== undefined) acc.bio = bio; }
    // Update existing message authors
    messages.forEach(msgs => msgs.forEach(m => {
      if (m.authorId === me.id) { if (avatar !== undefined) m.author.avatar = avatar; if (name) m.author.name = name; }
    }));
    io.emit("users_update", getOnlineUsers());
  });

  socket.on("get_invite", (spaceId) => {
    const sp = spaces.get(spaceId);
    if (!sp) return;
    socket.emit("invite_info", { code: sp.inviteCode, spaceId });
  });

  socket.on("disconnect", () => {
    const me = activeSocks.get(socket.id);
    if (me) {
      console.log(`[-] ${me.name} offline`);
      typingUsers.forEach(set => set.delete(me.name));
      activeSocks.delete(socket.id);
      io.emit("users_update", getOnlineUsers());
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`\n🚀 Nexus server → http://localhost:${PORT}\n`));
