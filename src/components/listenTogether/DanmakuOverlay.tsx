//
// DanmakuOverlay - 一起听弹幕覆盖层
//  - 挂在播放画面上方，绝对定位
//  - 弹幕从右往左飘，多条轨道避免重叠
//  - 接收来自 ListenTogetherContext 的 danmakuMessages
//
import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useListenTogether } from '@/contexts/ListenTogetherContext';
import { DanmakuEngine, type IFlyingDanmaku } from '@/lib/listenTogether.danmaku';
import { avatarImageCache } from '@/lib/avatarImageCache';

interface DanmakuOverlayProps {
  /** 是否启用弹幕 */
  enabled: boolean;
  /** 容器 ref（用于尺寸测量） */
  containerRef: React.RefObject<HTMLDivElement>;
}

 // 估算弹幕总宽度（头像 + 昵称 + 内容）
 function estimateTextWidth(text: string, fontSize: number): number {
   // 中文 ~ fontSize, 英文/数字 ~ fontSize*0.6
   let w = 0;
   for (let i = 0; i < text.length; i++) {
     const c = text.charCodeAt(i);
     if (c > 127) w += fontSize;
     else w += fontSize * 0.55;
   }
   return w + 20; // 左右 padding
 }

 // 估算整条弹幕的总宽度（头像圆 + 昵称 + 内容 + 间距）
 function estimateDanmakuWidth(nickname: string, content: string, fontSize: number): number {
   const avatarSize = fontSize + 4; // 头像直径
   const nickWidth = estimateTextWidth(nickname, fontSize * 0.85);
   const contentWidth = estimateTextWidth(content, fontSize);
   return avatarSize + nickWidth + contentWidth + 16; // avatar + gap*2 + padding 左右
 }

 // 降级头像：根据昵称生成彩色圆 + 首字
 function drawFallbackAvatar(
   ctx: CanvasRenderingContext2D,
   nickname: string,
   cx: number,
   cy: number,
   radius: number,
   fontSize: number,
 ) {
   let hue = 0;
   const nick = nickname || '?';
   for (let i = 0; i < nick.length; i++) {
     hue += nick.charCodeAt(i) * 13;
   }
   hue = hue % 360;
   ctx.fillStyle = `hsla(${hue}, 60%, 55%, 0.9)`;
   ctx.beginPath();
   ctx.arc(cx, cy, radius, 0, Math.PI * 2);
   ctx.fill();

   const firstChar = nick.charAt(0);
   ctx.fillStyle = '#ffffff';
   ctx.font = `bold ${fontSize}px system-ui, -apple-system, "PingFang SC", "Microsoft Yahei", sans-serif`;
   ctx.textAlign = 'center';
   ctx.textBaseline = 'middle';
   ctx.fillText(firstChar, cx, cy);
 }

 const LINE_HEIGHT = 28; // 弹幕行高（增大以容纳头像）

 function DanmakuOverlay({ enabled, containerRef }: DanmakuOverlayProps) {
   const { danmakuMessages, getMemberDisplayInfo } = useListenTogether();
  const engineRef = useRef<DanmakuEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [flying, setFlying] = useState<IFlyingDanmaku[]>([]);
  const lastMsgIdRef = useRef<string>('');

  // 初始化引擎
  useEffect(() => {
    if (!enabled) return;

    const engine = new DanmakuEngine((list) => {
      // 每帧更新 flying 列表，触发重绘
      // 为了性能，直接画 canvas，不走 React state
      renderCanvas(list);
    });
    engineRef.current = engine;

    const updateSize = () => {
      if (!containerRef.current || !canvasRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      canvasRef.current.width = rect.width * window.devicePixelRatio;
      canvasRef.current.height = rect.height * window.devicePixelRatio;
      canvasRef.current.style.width = rect.width + 'px';
      canvasRef.current.style.height = rect.height + 'px';
      engine.setSize(rect.width, rect.height);
    };

    // 延迟一帧测量尺寸
    const timer = requestAnimationFrame(updateSize);

    // 监听容器尺寸变化
    const ro = new ResizeObserver(updateSize);
    if (containerRef.current) ro.observe(containerRef.current);

    engine.start();

    return () => {
      cancelAnimationFrame(timer);
      ro.disconnect();
      engine.stop();
      engineRef.current = null;
    };
  }, [enabled, containerRef]);

   // Canvas 渲染
   const renderCanvas = useCallback((list: IFlyingDanmaku[]) => {
     const canvas = canvasRef.current;
     if (!canvas) return;
     const ctx = canvas.getContext('2d');
     if (!ctx) return;
     const dpr = window.devicePixelRatio;
     const w = canvas.width;
     const h = canvas.height;
     ctx.clearRect(0, 0, w, h);

     const contentFontSize = 14 * dpr;
     const nickFontSize = 12 * dpr;
     const avatarSize = (14 + 4) * dpr; // 头像直径
     const gap = 4 * dpr; // 头像与昵称间距

     ctx.textBaseline = 'middle';
     ctx.lineWidth = 3 * dpr;
     ctx.lineJoin = 'round';

      for (const d of list) {
        const x = d.x * dpr;
        const y = (d.track * LINE_HEIGHT + LINE_HEIGHT / 2 + 6) * dpr; // 居中
        const info = getMemberDisplayInfo(d.fromUid);
        const displayNick = info.nickname;

        let cursorX = x;

        // 1. 头像圆形（优先真实头像，失败降级为彩色圆+首字）
        const avatarX = cursorX + avatarSize / 2;
        const avatarY = y;
        const avatarRadius = avatarSize / 2;
        const avatarUrl = info.avatarUrl;
        const cachedImg = avatarUrl ? avatarImageCache.get(avatarUrl) : null;

        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
        ctx.clip();

        if (cachedImg) {
          // 真实头像：圆形裁剪后绘制
          try {
            ctx.drawImage(
              cachedImg,
              avatarX - avatarRadius,
              avatarY - avatarRadius,
              avatarSize,
              avatarSize,
            );
          } catch {
            // 绘制异常时降级
            drawFallbackAvatar(ctx, displayNick, avatarX, avatarY, avatarRadius, nickFontSize);
          }
        } else {
          // 未加载 / 无 URL / 加载失败 → 降级彩色圆+首字
          drawFallbackAvatar(ctx, displayNick, avatarX, avatarY, avatarRadius, nickFontSize);
        }
        ctx.restore();

       cursorX += avatarSize + gap;

       // 2. 昵称（金色/亮色，带描边）
       ctx.font = `600 ${nickFontSize}px system-ui, -apple-system, "PingFang SC", "Microsoft Yahei", sans-serif`;
       ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
       ctx.strokeText(displayNick || '匿名', cursorX, y);
       ctx.fillStyle = '#ffd700';
       ctx.fillText(displayNick || '匿名', cursorX, y);

       cursorX += ctx.measureText(displayNick || '匿名').width + gap * 2;

       // 3. 内容（白色，带描边）
       ctx.font = `500 ${contentFontSize}px system-ui, -apple-system, "PingFang SC", "Microsoft Yahei", sans-serif`;
       ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
       ctx.strokeText(d.content, cursorX, y);
       ctx.fillStyle = '#ffffff';
       ctx.fillText(d.content, cursorX, y);
     }
   }, [getMemberDisplayInfo]);

  // 新弹幕到达时发射
  useEffect(() => {
    if (!enabled || !engineRef.current) return;
    if (danmakuMessages.length === 0) return;

    // 找到最新的、还没处理过的消息
    const lastIdx = danmakuMessages.findIndex((m) => m.id === lastMsgIdRef.current);
    const newOnes = lastIdx >= 0 ? danmakuMessages.slice(lastIdx + 1) : danmakuMessages;

     for (const msg of newOnes) {
       const info = getMemberDisplayInfo(msg.fromUid);
       const w = estimateDanmakuWidth(info.nickname, msg.content, 14);
       engineRef.current.emit({ ...msg, fromNickname: info.nickname }, w);
     }
    if (newOnes.length > 0) {
      lastMsgIdRef.current = newOnes[newOnes.length - 1].id;
    }
   }, [danmakuMessages, enabled, getMemberDisplayInfo]);

  if (!enabled) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-20"
      aria-hidden="true"
    />
  );
}

export default memo(DanmakuOverlay);
