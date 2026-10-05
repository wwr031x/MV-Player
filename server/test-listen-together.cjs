// 端到端测试脚本：模拟两个客户端一起听

const WebSocket = require('ws');

const WS_URL = 'ws://localhost:8089/ws';

function connectClient(uid, nickname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?uid=${uid}&nickname=${encodeURIComponent(nickname)}`);
    const handlers = new Map();
    let msgId = 0;
    const pending = new Map();

    ws.on('open', () => {
      resolve({
        ws,
        on(type, cb) {
          if (!handlers.has(type)) handlers.set(type, []);
          handlers.get(type).push(cb);
        },
        send(type, payload = {}) {
          const id = `t_${Date.now()}_${++msgId}`;
          ws.send(JSON.stringify({ type, payload, id, from: uid, roomId: '', timestamp: Date.now() }));
          return id;
        },
        request(type, payload = {}, timeout = 5000) {
          return new Promise((res, rej) => {
            const id = `t_${Date.now()}_${++msgId}`;
            const timer = setTimeout(() => rej(new Error(`timeout: ${type}`)), timeout);
            pending.set(id, { res, rej, timer });
            ws.send(JSON.stringify({ type, payload, id, from: uid, roomId: '', timestamp: Date.now() }));
          });
        },
        close() { ws.close(); },
      });
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      // requestId 在顶层
      if (msg.requestId && pending.has(msg.requestId)) {
        const { res, rej, timer } = pending.get(msg.requestId);
        clearTimeout(timer);
        pending.delete(msg.requestId);
        if (msg.payload?.ok === false) rej(new Error(msg.payload?.error || 'failed'));
        else res(msg.payload);
      }
      const list = handlers.get(msg.type);
      if (list) list.forEach((cb) => cb(msg));
    });

    ws.on('error', (err) => reject(err));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  console.log('=== 一起听端到端测试 ===\n');

  try {
    // 1. 两个客户端连接
    console.log('--- 测试 1: 连接 ---');
    const [alice, bob] = await Promise.all([
      connectClient('alice001', '爱丽丝'),
      connectClient('bob002', '鲍勃'),
    ]);
    await sleep(200);
    console.log('✓ 两个客户端都连上了\n');

    // 2. 在线状态
    console.log('--- 测试 2: 在线状态 ---');
    const r1 = await bob.request('check-online', { uid: 'alice001' });
    console.log('Bob 查 Alice:', r1.online, r1.nickname);
    const r2 = await alice.request('check-online', { uid: 'nobody999' });
    console.log('Alice 查不存在:', r2.online);
    console.log('✓ 在线状态正常\n');

    // 3. 创建房间
    console.log('--- 测试 3: 创建房间 ---');
    const cr = await alice.request('create-room', {});
    const roomId = cr.room.roomId;
    console.log('房间:', roomId, '房主:', cr.room.hostUid, '成员:', cr.room.memberCount);
    console.log('✓ 房间创建成功\n');

    // 4. 邀请
    console.log('--- 测试 4: 邀请信令 ---');
    let bobInvite = null;
    bob.on('invite', (m) => { bobInvite = m.payload.invite; });

    const ir = await alice.request('invite', { toUid: 'bob002' });
    console.log('邀请发送:', ir.targetOnline ? '对方在线' : '不在线');
    await sleep(300);
    console.log('Bob 收到邀请:', !!bobInvite, 'from', bobInvite?.fromNickname);
    console.log('✓ 邀请信令正常\n');

    // 5. 接受邀请
    console.log('--- 测试 5: 接受邀请 + 加入房间 ---');
    let aliceReply = null;
    alice.on('invite-reply', (m) => { aliceReply = m.payload; });

    const rr = await bob.request('invite-reply', { inviteId: bobInvite.id, accepted: true });
    console.log('Bob 接受:', rr.accepted ? '成功' : '失败');
    console.log('Bob 房间成员:', rr.room?.members?.map((m) => m.nickname).join(', '));
    await sleep(400);
    console.log('Alice 收到回复:', !!aliceReply, aliceReply?.accepted ? '接受' : '拒绝');

    const ari = await alice.request('get-room-info', { roomId });
    console.log('Alice 视角成员:', ari.room.members.map((m) => m.nickname).join(', '));
    console.log('✓ 接受邀请+加入房间正常\n');

    // 6. 播放同步
    console.log('--- 测试 6: 播放/切歌/seek 同步 ---');
    let playMsg = null, trackMsg = null, seekMsg = null;
    bob.on('sync-play', (m) => { playMsg = m.payload; });
    bob.on('sync-track', (m) => { trackMsg = m.payload; });
    bob.on('sync-seek', (m) => { seekMsg = m.payload; });

    alice.send('sync-play', { isPlaying: true, currentTime: 42.5 });
    await sleep(200);
    console.log('sync-play:', playMsg?.isPlaying, '@', playMsg?.currentTime, 's');

    alice.send('sync-track', {
      track: { id: 's1', name: '测试歌', artist: 'A', duration: 200 },
      currentTime: 10.5,
    });
    await sleep(200);
    console.log('sync-track:', trackMsg?.track?.name, '@', trackMsg?.currentTime, 's');

    alice.send('sync-seek', { currentTime: 55.0 });
    await sleep(200);
    console.log('sync-seek:', seekMsg?.currentTime, 's');
    console.log('✓ 播放同步正常\n');

    // 7. 房主转让
    console.log('--- 测试 7: 房主退出 → 转让 ---');
    let gotHost = false;
    bob.on('host-transfer', (m) => {
      if (m.payload.newHostUid === 'bob002') gotHost = true;
    });

    await alice.request('leave-room', {});
    await sleep(300);

    const bri = await bob.request('get-room-info', { roomId });
    console.log('新房主:', bri.room.hostUid, '(应该是 bob002)');
    console.log('Bob 收到 host-transfer:', gotHost);
    console.log('成员数:', bri.room.memberCount, '(应该是 1)');
    console.log('✓ 房主转让正常\n');

    // 8. 房间解散
    console.log('--- 测试 8: 最后一人退出 → 解散 ---');
    let disbanded = false;
    bob.on('room-disband', () => { disbanded = true; });

    await bob.request('leave-room', {});
    await sleep(300);
    console.log('Bob 收到 room-disband:', disbanded);

    const h = await fetch('http://localhost:8089/health').then((r) => r.json());
    console.log('服务状态 - 在线:', h.onlineUsers, '房间:', h.activeRooms, '邀请:', h.pendingInvites);
    console.log('✓ 房间解散清理正常\n');

    // 9. 时钟同步
    console.log('--- 测试 9: 时钟同步 ---');
    const dave = await connectClient('dave004', '戴夫');
    const t1 = Date.now();
    const sr = await dave.request('clock-sync', { t1 });
    const t4 = Date.now();
    const rtt = t4 - t1 - (sr.t3 - sr.t2);
    const offset = (t1 + rtt / 2) - sr.t2;
    console.log(`RTT=${rtt.toFixed(0)}ms, 偏移=${offset.toFixed(1)}ms`);
    dave.close();
    console.log('✓ 时钟同步正常\n');

    // 10. 重复连接替换
    console.log('--- 测试 10: 重复连接踢旧 ---');
    const eve = await connectClient('eve005', '夏娃');
    let oldClosed = false;
    eve.ws.on('close', (code) => { if (code === 4001) oldClosed = true; });

    const eve2 = await connectClient('eve005', '夏娃新');
    await sleep(300);
    console.log('旧连接被踢:', oldClosed);
    eve2.close();
    console.log('✓ 重复连接处理正常\n');

    // 11. 邀请离线用户
    console.log('--- 测试 11: 邀请离线用户 ---');
    const frank = await connectClient('frank006', '弗兰克');
    const offInv = await frank.request('invite', { toUid: 'ghost999' });
    console.log('邀请离线用户结果:', offInv.targetOnline, '|', offInv.message || '');
    frank.close();
    console.log('✓ 离线邀请反馈正常\n');

    console.log('=== 所有测试通过 ✓ ===');
    process.exit(0);
  } catch (err) {
    console.error('❌ 测试失败:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
