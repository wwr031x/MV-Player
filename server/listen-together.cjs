/**
 * 一起听 WebSocket 后端服务
 *
 * 功能：
 * - 连接身份验证（UID）
 * - 在线状态管理
 * - 邀请信令（发送/接受/拒绝/超时）
 * - 房间管理（创建/加入/退出/成员列表/房主转让）
 * - 房间内消息广播（播放/暂停/切歌/seek 等）
 * - 心跳保活与超时清理
 * - 时钟同步（用于播放进度延迟补偿）
 *
 * 消息协议：{ type, payload, id, from, roomId?, timestamp, serverTime }
 */

const { WebSocketServer, WebSocket } = require('ws');
const http = require('node:http');
const { URL } = require('node:url');

// ===== 配置 =====
const PORT = Number(process.env.LISTEN_TOGETHER_PORT || 8089);
const HEARTBEAT_INTERVAL = 10_000; // 心跳间隔 10s
const CLIENT_TIMEOUT = 30_000;     // 30s 没心跳视为离线
const INVITE_TIMEOUT = 30_000;     // 邀请 30s 超时
const ROOM_CLEANUP_INTERVAL = 60_000; // 房间清理周期 60s
const MAX_ROOM_MEMBERS = 10;       // 房间最大人数
const MAX_INVITES_PER_USER = 20;   // 单用户最大待处理邀请数

// ===== 全局状态 =====

/** @type {Map<string, any>} uid → client */
const clients = new Map();
/** @type {Map<string, any>} roomId → room */
const rooms = new Map();
/** @type {Map<string, any>} inviteId → invite */
const invites = new Map();

let messageIdCounter = 0;
const genMsgId = () => `msg_${Date.now()}_${++messageIdCounter}`;
const genRoomId = () => 'room_' + Math.random().toString(36).slice(2, 8);
const genInviteId = () => 'inv_' + Math.random().toString(36).slice(2, 10);

// ===== 日志 =====

function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}] [listen-together]`;
  const line = extra ? `${prefix} ${msg} ${JSON.stringify(extra)}` : `${prefix} ${msg}`;
  console.log(line);
}

// ===== 发送消息 =====

function send(ws, type, payload = {}, opts = {}) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const msg = {
    type,
    payload,
    id: opts.id || genMsgId(),
    from: opts.from || 'server',
    roomId: opts.roomId || '',
    requestId: opts.requestId || undefined,
    timestamp: Date.now(),
    serverTime: Date.now(),
  };
  ws.send(JSON.stringify(msg));
  return true;
}

function sendToUid(uid, type, payload = {}, opts = {}) {
  const client = clients.get(uid);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    return send(client.ws, type, payload, opts);
  }
  return false;
}

function broadcastToRoom(roomId, type, payload, opts = {}) {
  const room = rooms.get(roomId);
  if (!room) return 0;
  let count = 0;
  for (const [uid] of room.members) {
    if (opts.exceptUid && uid === opts.exceptUid) continue;
    if (sendToUid(uid, type, payload, { from: opts.from, roomId })) {
      count++;
    }
  }
  return count;
}

// ===== 房间工具 =====

function getRoomMemberList(room) {
  return Array.from(room.members.values()).map((m) => ({
    uid: m.uid,
    nickname: m.nickname,
    avatarSeed: m.avatarSeed,
    isHost: m.isHost,
    joinedAt: m.joinedAt,
  }));
}

function getRoomInfo(room) {
  return {
    roomId: room.roomId,
    hostUid: room.hostUid,
    memberCount: room.members.size,
    members: getRoomMemberList(room),
    currentTrackId: room.currentTrackId,
    currentTrack: room.currentTrack,
    isPlaying: room.isPlaying,
    hostTime: room.hostTime,
    hostTimeAt: room.hostTimeAt,
    createdAt: room.createdAt,
  };
}

function transferHost(room, newHostUid) {
  const oldHost = room.members.get(room.hostUid);
  const newHost = room.members.get(newHostUid);
  if (oldHost) oldHost.isHost = false;
  if (newHost) newHost.isHost = true;
  room.hostUid = newHostUid;
  log('info', `Host transferred in room ${room.roomId}: ${room.hostUid} → ${newHostUid}`);
  broadcastToRoom(room.roomId, 'host-transfer', {
    newHostUid,
    members: getRoomMemberList(room),
  }, { from: 'server' });
}

function disbandRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  log('info', `Room disbanded: ${roomId}`);
  broadcastToRoom(roomId, 'room-disband', { roomId }, { from: 'server' });

  for (const [uid] of room.members) {
    const client = clients.get(uid);
    if (client) client.roomId = null;
  }
  rooms.delete(roomId);
}

function removeMemberFromRoom(room, uid, reason = 'leave') {
  const member = room.members.get(uid);
  if (!member) return;

  room.members.delete(uid);
  const client = clients.get(uid);
  if (client) client.roomId = null;

  log('info', `Member ${uid} left room ${room.roomId} (${reason})`);

  broadcastToRoom(room.roomId, 'member-left', {
    uid,
    reason,
    members: getRoomMemberList(room),
  }, { from: 'server' });

  if (uid === room.hostUid) {
    if (room.members.size > 0) {
      const firstUid = Array.from(room.members.keys())[0];
      transferHost(room, firstUid);
    } else {
      disbandRoom(room.roomId);
    }
  }
}

// ===== 邀请工具 =====

function cleanupExpiredInvites() {
  const now = Date.now();
  let count = 0;
  for (const [id, inv] of invites) {
    if (inv.status === 'pending' && now > inv.expiresAt) {
      inv.status = 'expired';
      sendToUid(inv.fromUid, 'invite-expired', {
        inviteId: id,
        toUid: inv.toUid,
      }, { from: 'server' });
      invites.delete(id);
      count++;
    } else if (inv.status !== 'pending' && now - inv.createdAt > 60_000) {
      invites.delete(id);
      count++;
    }
  }
  if (count > 0) log('info', `Cleaned up ${count} expired invites`);
}

// ===== 消息处理 =====

function handleMessage(client, rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch {
    log('warn', `Invalid JSON from ${client.uid}`);
    return;
  }

  const { type, payload = {}, id, roomId } = msg;
  if (!type) return;

  client.lastSeen = Date.now();

  const respond = (data, ok = true) => {
    send(client.ws, `${type}-reply`, {
      ok,
      ...data,
    }, { id: genMsgId(), from: 'server', requestId: id });
  };

  try {
    switch (type) {
      case 'ping':
        handlePing(client, payload, respond);
        break;
      case 'clock-sync':
        handleClockSync(client, payload, respond);
        break;
      case 'update-profile':
        handleUpdateProfile(client, payload, respond);
        break;
      case 'check-online':
        handleCheckOnline(client, payload, respond);
        break;
      case 'create-room':
        handleCreateRoom(client, payload, respond);
        break;
      case 'join-room':
        handleJoinRoom(client, payload, respond);
        break;
      case 'leave-room':
        handleLeaveRoom(client, payload, respond);
        break;
      case 'get-room-info':
        handleGetRoomInfo(client, payload, respond);
        break;
      case 'invite':
        handleInvite(client, payload, respond);
        break;
      case 'invite-reply':
        handleInviteReply(client, payload, respond);
        break;
      case 'sync-play':
        handleSyncPlay(client, payload);
        break;
      case 'sync-track':
        handleSyncTrack(client, payload);
        break;
      case 'sync-seek':
        handleSyncSeek(client, payload);
        break;
      case 'report-progress':
        handleReportProgress(client, payload);
        break;
      default:
        log('warn', `Unknown message type: ${type} from ${client.uid}`);
        respond({ error: 'Unknown message type' }, false);
    }
  } catch (err) {
    log('error', `Error handling ${type} from ${client.uid}: ${err.message}`);
    respond({ error: 'Internal server error' }, false);
  }
}

// ---- 心跳与时钟 ----

function handlePing(client, payload, respond) {
  respond({
    serverTime: Date.now(),
    clientTime: payload.clientTime,
  });
}

function handleClockSync(client, payload, respond) {
  const t1 = payload.t1 || 0;
  const t2 = Date.now();
  respond({
    t1,
    t2,
    t3: Date.now(),
  });
}

// ---- 个人信息 ----

function handleUpdateProfile(client, payload, respond) {
  const { nickname, avatarSeed } = payload;
  if (nickname !== undefined) {
    client.nickname = String(nickname).slice(0, 32);
  }
  if (avatarSeed !== undefined) {
    client.avatarSeed = String(avatarSeed).slice(0, 64);
  }

  if (client.roomId) {
    const room = rooms.get(client.roomId);
    if (room) {
      const member = room.members.get(client.uid);
      if (member) {
        member.nickname = client.nickname;
        member.avatarSeed = client.avatarSeed;
      }
      broadcastToRoom(client.roomId, 'member-update', {
        uid: client.uid,
        nickname: client.nickname,
        avatarSeed: client.avatarSeed,
        members: getRoomMemberList(room),
      }, { from: 'server' });
    }
  }

  respond({ nickname: client.nickname, avatarSeed: client.avatarSeed });
}

// ---- 在线状态 ----

function handleCheckOnline(client, payload, respond) {
  const { uid } = payload;
  if (!uid) {
    respond({ error: 'uid is required' }, false);
    return;
  }
  const target = clients.get(uid);
  const online = !!target && target.ws.readyState === WebSocket.OPEN;
  respond({
    uid,
    online,
    nickname: online ? target.nickname : undefined,
    avatarSeed: online ? target.avatarSeed : undefined,
  });
}

// ---- 房间 ----

function handleCreateRoom(client, payload, respond) {
  if (client.roomId) {
    const oldRoom = rooms.get(client.roomId);
    if (oldRoom) {
      removeMemberFromRoom(oldRoom, client.uid, 'create-new-room');
    }
  }

  const roomId = genRoomId();
  const now = Date.now();

  const room = {
    roomId,
    hostUid: client.uid,
    members: new Map(),
    currentTrackId: null,
    currentTrack: null,
    isPlaying: false,
    hostTime: 0,
    hostTimeAt: now,
    createdAt: now,
  };

  const member = {
    uid: client.uid,
    nickname: client.nickname,
    avatarSeed: client.avatarSeed,
    isHost: true,
    joinedAt: now,
  };

  room.members.set(client.uid, member);
  rooms.set(roomId, room);
  client.roomId = roomId;

  log('info', `Room created: ${roomId} by ${client.uid}`);
  respond({ room: getRoomInfo(room) });
}

function handleJoinRoom(client, payload, respond) {
  const { roomId } = payload;
  if (!roomId) {
    respond({ error: 'roomId is required' }, false);
    return;
  }

  const room = rooms.get(roomId);
  if (!room) {
    respond({ error: '房间不存在' }, false);
    return;
  }

  if (room.members.has(client.uid)) {
    respond({ room: getRoomInfo(room) });
    return;
  }

  if (room.members.size >= MAX_ROOM_MEMBERS) {
    respond({ error: '房间人数已满' }, false);
    return;
  }

  if (client.roomId && client.roomId !== roomId) {
    const oldRoom = rooms.get(client.roomId);
    if (oldRoom) {
      removeMemberFromRoom(oldRoom, client.uid, 'switch-room');
    }
  }

  const now = Date.now();
  const member = {
    uid: client.uid,
    nickname: client.nickname,
    avatarSeed: client.avatarSeed,
    isHost: false,
    joinedAt: now,
  };

  room.members.set(client.uid, member);
  client.roomId = roomId;

  log('info', `${client.uid} joined room ${roomId}`);

  broadcastToRoom(roomId, 'member-joined', {
    uid: client.uid,
    nickname: client.nickname,
    avatarSeed: client.avatarSeed,
    members: getRoomMemberList(room),
  }, { exceptUid: client.uid, from: 'server' });

  respond({
    room: getRoomInfo(room),
    currentTrack: room.currentTrack,
    currentTrackId: room.currentTrackId,
    isPlaying: room.isPlaying,
    hostTime: room.hostTime,
    hostTimeAt: room.hostTimeAt,
    serverTime: now,
  });
}

function handleLeaveRoom(client, payload, respond) {
  if (!client.roomId) {
    respond({ error: '不在房间内' }, false);
    return;
  }

  const room = rooms.get(client.roomId);
  if (!room) {
    client.roomId = null;
    respond({ ok: true });
    return;
  }

  removeMemberFromRoom(room, client.uid, 'leave');
  respond({ ok: true });
}

function handleGetRoomInfo(client, payload, respond) {
  const roomId = payload.roomId || client.roomId;
  if (!roomId) {
    respond({ error: 'roomId is required' }, false);
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    respond({ error: '房间不存在' }, false);
    return;
  }
  respond({ room: getRoomInfo(room) });
}

// ---- 邀请 ----

function handleInvite(client, payload, respond) {
  const { toUid } = payload;
  if (!toUid) {
    respond({ error: 'toUid is required' }, false);
    return;
  }
  if (toUid === client.uid) {
    respond({ error: '不能邀请自己' }, false);
    return;
  }

  const target = clients.get(toUid);
  const targetOnline = !!target && target.ws.readyState === WebSocket.OPEN;

  let roomId = client.roomId;
  if (!roomId) {
    const newRoomId = genRoomId();
    const now = Date.now();
    const room = {
      roomId: newRoomId,
      hostUid: client.uid,
      members: new Map(),
      currentTrackId: null,
      currentTrack: null,
      isPlaying: false,
      hostTime: 0,
      hostTimeAt: now,
      createdAt: now,
    };
    const member = {
      uid: client.uid,
      nickname: client.nickname,
      avatarSeed: client.avatarSeed,
      isHost: true,
      joinedAt: now,
    };
    room.members.set(client.uid, member);
    rooms.set(newRoomId, room);
    client.roomId = newRoomId;
    roomId = newRoomId;
    log('info', `Room created via invite: ${newRoomId} by ${client.uid}`);
  }

  let pendingCount = 0;
  for (const inv of invites.values()) {
    if (inv.fromUid === client.uid && inv.status === 'pending') pendingCount++;
  }
  if (pendingCount >= MAX_INVITES_PER_USER) {
    respond({ error: '邀请数量已达上限' }, false);
    return;
  }

  const now = Date.now();
  const inviteId = genInviteId();
  const invite = {
    id: inviteId,
    fromUid: client.uid,
    fromNickname: client.nickname,
    fromAvatarSeed: client.avatarSeed,
    toUid,
    roomId,
    status: targetOnline ? 'pending' : 'offline',
    createdAt: now,
    expiresAt: now + INVITE_TIMEOUT,
  };

  invites.set(inviteId, invite);

  if (targetOnline) {
    sendToUid(toUid, 'invite', {
      invite: {
        id: inviteId,
        fromUid: client.uid,
        fromNickname: client.nickname,
        fromAvatarSeed: client.avatarSeed,
        toUid,
        roomId,
        createdAt: now,
        expiresAt: invite.expiresAt,
      },
    }, { from: client.uid, roomId });
    log('info', `Invite sent: ${client.uid} → ${toUid} (room ${roomId})`);
    respond({ inviteId, roomId, targetOnline: true });
  } else {
    log('info', `Invite to offline user: ${client.uid} → ${toUid}`);
    respond({
      inviteId,
      roomId,
      targetOnline: false,
      message: '对方不在线',
    });
    invite.status = 'offline';
    setTimeout(() => invites.delete(inviteId), 5000);
  }
}

function handleInviteReply(client, payload, respond) {
  const { inviteId, accepted } = payload;
  if (!inviteId) {
    respond({ error: 'inviteId is required' }, false);
    return;
  }

  const invite = invites.get(inviteId);
  if (!invite) {
    respond({ error: '邀请不存在或已过期' }, false);
    return;
  }
  if (invite.toUid !== client.uid) {
    respond({ error: '无权操作此邀请' }, false);
    return;
  }
  if (invite.status !== 'pending') {
    respond({ error: '邀请已处理' }, false);
    return;
  }

  const now = Date.now();
  if (now > invite.expiresAt) {
    invite.status = 'expired';
    invites.delete(inviteId);
    respond({ error: '邀请已过期' }, false);
    return;
  }

  invite.status = accepted ? 'accepted' : 'rejected';

  sendToUid(invite.fromUid, 'invite-reply', {
    inviteId,
    accepted,
    fromUid: client.uid,
    fromNickname: client.nickname,
    fromAvatarSeed: client.avatarSeed,
    roomId: invite.roomId,
  }, { from: client.uid, roomId: invite.roomId });

  log('info', `Invite ${inviteId} ${accepted ? 'accepted' : 'rejected'} by ${client.uid}`);

  if (accepted) {
    const room = rooms.get(invite.roomId);
    if (!room) {
      respond({ error: '房间已不存在' }, false);
      sendToUid(invite.fromUid, 'invite-error', {
        inviteId,
        error: '房间已不存在',
      }, { from: 'server' });
      invites.delete(inviteId);
      return;
    }

    if (room.members.size >= MAX_ROOM_MEMBERS) {
      respond({ error: '房间人数已满' }, false);
      invites.delete(inviteId);
      return;
    }

    if (client.roomId && client.roomId !== invite.roomId) {
      const oldRoom = rooms.get(client.roomId);
      if (oldRoom) {
        removeMemberFromRoom(oldRoom, client.uid, 'switch-room');
      }
    }

    const member = {
      uid: client.uid,
      nickname: client.nickname,
      avatarSeed: client.avatarSeed,
      isHost: false,
      joinedAt: now,
    };
    room.members.set(client.uid, member);
    client.roomId = invite.roomId;

    broadcastToRoom(invite.roomId, 'member-joined', {
      uid: client.uid,
      nickname: client.nickname,
      avatarSeed: client.avatarSeed,
      members: getRoomMemberList(room),
    }, { exceptUid: client.uid, from: 'server' });

    respond({
      accepted: true,
      room: getRoomInfo(room),
      currentTrack: room.currentTrack,
      currentTrackId: room.currentTrackId,
      isPlaying: room.isPlaying,
      hostTime: room.hostTime,
      hostTimeAt: room.hostTimeAt,
      serverTime: now,
    });
  } else {
    respond({ accepted: false });
  }

  setTimeout(() => invites.delete(inviteId), 10_000);
}

// ---- 播放同步 ----

function handleSyncPlay(client, payload) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) return;

  const { isPlaying, currentTime } = payload;
  const now = Date.now();

  room.isPlaying = !!isPlaying;
  room.hostTime = Number(currentTime) || 0;
  room.hostTimeAt = now;

  broadcastToRoom(
    client.roomId,
    'sync-play',
    {
      isPlaying: !!isPlaying,
      currentTime: Number(currentTime) || 0,
      serverTime: now,
      fromUid: client.uid,
    },
    { exceptUid: client.uid, from: client.uid }
  );
}

function handleSyncTrack(client, payload) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) return;

  const { track, currentTime } = payload;
  const now = Date.now();

  room.currentTrack = track || null;
  room.currentTrackId = track?.id || null;
  room.hostTime = Number(currentTime) || 0;
  room.hostTimeAt = now;

  broadcastToRoom(
    client.roomId,
    'sync-track',
    {
      track: track || null,
      currentTime: Number(currentTime) || 0,
      serverTime: now,
      fromUid: client.uid,
    },
    { exceptUid: client.uid, from: client.uid }
  );
}

function handleSyncSeek(client, payload) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) return;

  const { currentTime } = payload;
  const now = Date.now();

  room.hostTime = Number(currentTime) || 0;
  room.hostTimeAt = now;

  broadcastToRoom(
    client.roomId,
    'sync-seek',
    {
      currentTime: Number(currentTime) || 0,
      serverTime: now,
      fromUid: client.uid,
    },
    { exceptUid: client.uid, from: client.uid }
  );
}

function handleReportProgress(client, payload) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) return;

  const member = room.members.get(client.uid);
  if (!member) return;

  member.currentTime = Number(payload.currentTime) || 0;
  member.lastReportAt = Date.now();

  if (client.uid === room.hostUid) {
    room.hostTime = member.currentTime;
    room.hostTimeAt = member.lastReportAt;
  }
}

// ===== 连接处理 =====

function handleConnection(ws, req) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const uid = url.searchParams.get('uid');
  const nickname = url.searchParams.get('nickname') || '';
  const avatarSeed = url.searchParams.get('avatarSeed') || '';

  if (!uid || !/^[a-zA-Z0-9_-]{3,64}$/.test(uid)) {
    log('warn', `Connection rejected: invalid uid "${uid}"`);
    ws.close(4000, 'Invalid UID');
    return;
  }

  const existing = clients.get(uid);
  if (existing) {
    log('info', `UID ${uid} reconnected, closing old connection`);
    try {
      existing.ws.close(4001, 'Replaced by new connection');
    } catch { /* ignore */ }
  }

  const client = {
    uid,
    nickname: (nickname || `听众_${uid.slice(-4)}`).slice(0, 32),
    avatarSeed: (avatarSeed || uid).slice(0, 64),
    ws,
    roomId: null,
    lastSeen: Date.now(),
    connectedAt: Date.now(),
    clockOffset: 0,
  };

  clients.set(uid, client);
  log('info', `Client connected: ${uid} (total: ${clients.size})`);

  send(ws, 'welcome', {
    uid,
    serverTime: Date.now(),
    heartbeatInterval: HEARTBEAT_INTERVAL,
    clientTimeout: CLIENT_TIMEOUT,
  }, { from: 'server' });

  ws.on('message', (data) => {
    handleMessage(client, data.toString());
  });

  ws.on('error', (err) => {
    log('error', `WebSocket error for ${uid}: ${err.message}`);
  });

  ws.on('close', (code, reason) => {
    log('info', `Client disconnected: ${uid} (code=${code}, reason=${reason.toString()})`);
    handleDisconnect(client);
  });
}

function handleDisconnect(client) {
  if (client.roomId) {
    const room = rooms.get(client.roomId);
    if (room) {
      removeMemberFromRoom(room, client.uid, 'disconnect');
    }
  }

  clients.delete(client.uid);
  log('info', `Client removed: ${client.uid} (total: ${clients.size})`);
}

// ===== 心跳与清理 =====

function startHeartbeatCheck() {
  setInterval(() => {
    const now = Date.now();
    const timeoutList = [];

    for (const [uid, client] of clients) {
      if (now - client.lastSeen > CLIENT_TIMEOUT) {
        timeoutList.push(uid);
      }
    }

    for (const uid of timeoutList) {
      const client = clients.get(uid);
      if (client) {
        log('info', `Client timeout: ${uid} (${CLIENT_TIMEOUT / 1000}s no heartbeat)`);
        try {
          client.ws.close(4002, 'Heartbeat timeout');
        } catch { /* ignore */ }
        handleDisconnect(client);
      }
    }
  }, HEARTBEAT_INTERVAL);
}

function startRoomCleanup() {
  setInterval(() => {
    cleanupExpiredInvites();

    const emptyRooms = [];
    for (const [roomId, room] of rooms) {
      if (room.members.size === 0) {
        emptyRooms.push(roomId);
      }
    }
    for (const roomId of emptyRooms) {
      rooms.delete(roomId);
      log('info', `Empty room cleaned: ${roomId}`);
    }
  }, ROOM_CLEANUP_INTERVAL);
}

// ===== HTTP 健康检查 =====

function handleHttpRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      onlineUsers: clients.size,
      activeRooms: rooms.size,
      pendingInvites: invites.size,
      timestamp: Date.now(),
    }));
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end('Listen Together WebSocket Server\nConnect via ws://<host>/ws?uid=<your-uid>\n');
    return;
  }

  res.writeHead(404, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': '*',
  });
  res.end('Not Found');
}

// ===== 启动 =====

const httpServer = http.createServer(handleHttpRequest);

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  maxPayload: 64 * 1024,
  clientTracking: false,
});

wss.on('connection', handleConnection);

wss.on('error', (err) => {
  log('error', `WebSocket server error: ${err.message}`);
});

httpServer.listen(PORT, () => {
  log('info', `Listen Together server listening on port ${PORT}`);
  log('info', `Health check: http://localhost:${PORT}/health`);
  log('info', `WebSocket: ws://localhost:${PORT}/ws?uid=<uid>`);
});

process.on('uncaughtException', (err) => {
  log('error', `Uncaught exception: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${String(reason)}`);
});
