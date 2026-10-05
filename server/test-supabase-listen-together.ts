/**
 * Supabase Realtime 一起听端到端测试
 * 模拟两个用户：A 邀请 B，B 接受，两人进房间，A 发播放/暂停/切歌消息
 * 用法: npx tsx server/test-supabase-listen-together.ts
 */
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { logger } from '@lark-apaas/client-toolkit-lite';

// 从环境变量读取 Supabase 配置
// 使用前请设置环境变量：export SUPABASE_URL=... SUPABASE_ANON_KEY=...
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';

function makeUser(prefix: string) {
  return { uid: 'uid_' + prefix + '_' + randomUUID().slice(0, 6), nickname: prefix };
}

const userA = makeUser('A');
const userB = makeUser('B');

logger.info('=== Supabase 一起听 E2E 测试 ===');
logger.info('User A:', { arg0: userA.uid, arg1: userA.nickname });
logger.info('User B:', { arg0: userB.uid, arg1: userB.nickname });
logger.info('');

const supabaseA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { log_level: 'error' } },
});
const supabaseB = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { log_level: 'error' } },
});

const results: string[] = [];
function pass(msg: string) {
  results.push('✅ ' + msg);
  logger.info('✅', String(msg));
}
function fail(msg: string) {
  results.push('❌ ' + msg);
  logger.info('❌', String(msg));
}

// ---- 测试 1: 邀请频道订阅 ----
async function test1_inviteChannel(): Promise<void> {
  const inviteChanA = supabaseA.channel('invite:' + userA.uid, { config: { broadcast: { self: false } } });
  const inviteChanB = supabaseB.channel('invite:' + userB.uid, { config: { broadcast: { self: false } } });

  // B 先监听邀请消息
  const inviteReceivedPromise = new Promise<boolean>((resolve) => {
    inviteChanB.on('broadcast', { event: 'invite' }, (payload) => {
      const inv = payload.payload;
      const ok = inv.id === inviteId && inv.fromUid === userA.uid && inv.toUid === userB.uid;
      resolve(ok);
    });
  });

  let subA = false,
    subB = false;
  const p1 = new Promise<void>((r) => {
    inviteChanA.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        subA = true;
        r();
      }
    });
  });
  const p2 = new Promise<void>((r) => {
    inviteChanB.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        subB = true;
        r();
      }
    });
  });

  await Promise.race([Promise.all([p1, p2]), new Promise((_, rej) => setTimeout(() => rej(new Error('订阅超时')), 10000))]);
  if (subA && subB) pass('邀请频道订阅成功');
  else fail('邀请频道订阅失败');

  // ---- 测试 2: A 给 B 发邀请 ----
  const inviteId = 'inv_' + randomUUID().slice(0, 8);
  const roomId = 'room_' + randomUUID().slice(0, 8);

  // A 发邀请到 B 的邀请频道
  await supabaseA.channel('invite:' + userB.uid).send({
    type: 'broadcast',
    event: 'invite',
    payload: {
      id: inviteId,
      fromUid: userA.uid,
      fromNickname: userA.nickname,
      toUid: userB.uid,
      roomId,
      timestamp: Date.now(),
    },
  });

  const inviteOk = await Promise.race([inviteReceivedPromise, new Promise((_, r) => setTimeout(() => r(false), 5000))]);
  if (inviteOk) pass('邀请消息送达（Broadcast 点对点）');
  else fail('邀请消息未送达');

  // 清理邀请频道
  await supabaseA.removeChannel(inviteChanA);
  await supabaseB.removeChannel(inviteChanB);

  // ---- 测试 3: 房间频道 + Presence ----
  const roomChanA = supabaseA.channel('room:' + roomId, {
    config: {
      broadcast: { self: false },
      presence: { key: userA.uid },
    },
  });
  const roomChanB = supabaseB.channel('room:' + roomId, {
    config: {
      broadcast: { self: false },
      presence: { key: userB.uid },
    },
  });

  // ---- 测试 4: Presence 成员同步（监听放在 subscribe 前） ----
  const presenceSyncPromise = new Promise<number>((resolve) => {
    roomChanA.on('presence', { event: 'sync' }, () => {
      const state = roomChanA.presenceState();
      const count = Object.keys(state).length;
      if (count >= 2) resolve(count);
    });
  });

  // ---- 测试 5: 播放/暂停/切歌/进度消息广播 ----
  const msgTypesReceived: string[] = [];
  const msgPromise = new Promise<string[]>((resolve) => {
    roomChanB.on('broadcast', { event: 'sync-play' }, (p) => {
      msgTypesReceived.push('sync-play');
      checkAll();
    });
    roomChanB.on('broadcast', { event: 'sync-track' }, (p) => {
      msgTypesReceived.push('sync-track');
      checkAll();
    });
    roomChanB.on('broadcast', { event: 'sync-seek' }, (p) => {
      msgTypesReceived.push('sync-seek');
      checkAll();
    });
    function checkAll() {
      if (['sync-play', 'sync-track', 'sync-seek'].every((t) => msgTypesReceived.includes(t))) {
        resolve(msgTypesReceived);
      }
    }
  });

  // ---- 测试 6: 成员离开通知 ----
  const memberLeftPromise = new Promise<boolean>((resolve) => {
    roomChanA.on('broadcast', { event: 'member-left' }, (p) => {
      resolve(p.payload.uid === userB.uid);
    });
  });

  let roomSubA = false,
    roomSubB = false;
  const rp1 = new Promise<void>((r) => roomChanA.subscribe((s) => s === 'SUBSCRIBED' && ((roomSubA = true), r())));
  const rp2 = new Promise<void>((r) => roomChanB.subscribe((s) => s === 'SUBSCRIBED' && ((roomSubB = true), r())));

  await Promise.race([Promise.all([rp1, rp2]), new Promise((_, r) => setTimeout(() => r(false), 10000))]);
  if (roomSubA && roomSubB) pass('房间频道订阅成功（Broadcast + Presence）');
  else fail('房间频道订阅失败');

  // ---- 测试 4: Presence 成员同步 ----

  // B 发 presence track（A 在 subscribe 时自动 track 了）
  await roomChanB.track({ uid: userB.uid, nickname: userB.nickname, joinedAt: Date.now() });
  await roomChanA.track({ uid: userA.uid, nickname: userA.nickname, joinedAt: Date.now() });

  const presenceCount = await Promise.race([presenceSyncPromise, new Promise((_, r) => setTimeout(() => r(0), 5000))]);
  if ((presenceCount as number) >= 2) pass('Presence 成员在线同步：' + presenceCount + ' 人');
  else fail('Presence 同步失败，只有 ' + presenceCount + ' 人');

  // ---- 测试 5: 播放/暂停/切歌/进度消息广播 ----

  // A 依次发三种消息
  await roomChanA.send({ type: 'broadcast', event: 'sync-play', payload: { isPlaying: true, currentTime: 10.5 } });
  await new Promise((r) => setTimeout(r, 200));
  await roomChanA.send({
    type: 'broadcast',
    event: 'sync-track',
    payload: { track: { id: 't1', name: '测试歌', artist: '测试艺术家' }, currentTime: 0 },
  });
  await new Promise((r) => setTimeout(r, 200));
  await roomChanA.send({ type: 'broadcast', event: 'sync-seek', payload: { currentTime: 42.0 } });

  const allMsgs = await Promise.race([msgPromise, new Promise((_, r) => setTimeout(() => r([]), 5000))]);
  const expected = ['sync-play', 'sync-track', 'sync-seek'];
  const allOk = expected.every((t) => (allMsgs as string[]).includes(t));
  if (allOk) pass('房间内消息广播：播放/切歌/进度全部送达');
  else fail('消息缺失：收到 ' + JSON.stringify(allMsgs));

  // ---- 测试 6: 成员离开通知 ----
  await roomChanB.send({ type: 'broadcast', event: 'member-left', payload: { uid: userB.uid, nickname: userB.nickname } });
  const memberLeftOk = await Promise.race([memberLeftPromise, new Promise((_, r) => setTimeout(() => r(false), 5000))]);
  if (memberLeftOk) pass('成员离开通知送达');
  else fail('成员离开通知未送达');

  // 清理
  await supabaseA.removeChannel(roomChanA);
  await supabaseB.removeChannel(roomChanB);
}

async function main() {
  const t0 = Date.now();
  try {
    await test1_inviteChannel();
  } catch (e: any) {
    fail('测试异常: ' + String(e?.message || e));
  }

  logger.info('');
  logger.info('=== 测试结果 ===');
  results.forEach((r) => logger.info(r));
  const total = results.length;
  const passed = results.filter((r) => r.startsWith('✅')).length;
  logger.info('');
  logger.info(`通过 ${passed}/${total}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  process.exit(passed === total ? 0 : 1);
}

main();
