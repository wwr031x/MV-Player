import { useEffect } from 'react';
import { Routes, Route, Navigate, useParams } from "react-router-dom";
import PlayerPage from "@/pages/PlayerPage";
import NotFoundPage from "@/pages/NotFoundPage/NotFoundPage";

/**
 * 邀请链接 /join/<roomId> 的着陆页：
 * 把房间号写入 sessionStorage 后重定向到首页。
 * 这样即使 OAuth 302 跳转丢了 query/hash，路径形式仍能存活；
 * 重定向到首页避免同一组件在两个 Route 挂载两次。
 */
function JoinRoomLanding() {
  const { roomId } = useParams<{ roomId: string }>();
  useEffect(() => {
    if (roomId && /^room_[a-zA-Z0-9]+$/.test(roomId)) {
      try {
        sessionStorage.setItem('__lt_pending_room__', roomId);
      } catch { /* ignore */ }
    }
  }, [roomId]);
  return <Navigate to="/" replace />;
}

export default function App() {
  // 首帧渲染完成后，通知内联 boot-loading 隐藏
  // 放在这里而不是 index.tsx 顶层，是为了保证 React 真正挂载成功后再隐藏 loading
  // 如果 React 渲染中途报错崩溃，boot-loading 会继续显示，用户不会看到纯黑屏
  useEffect(() => {
    // React 已挂载成功（组件 render 完，但还没到屏幕像素）
    if (typeof (window as any).__bootReactMounted === 'function') {
      (window as any).__bootReactMounted();
    }
    // 用 requestAnimationFrame 确保 DOM 已实际渲染到屏幕
    const raf = requestAnimationFrame(() => {
      if (typeof (window as any).__bootSuccess === 'function') {
        (window as any).__bootSuccess();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <Routes>
      <Route index element={<PlayerPage />} />
      <Route path="join/:roomId" element={<JoinRoomLanding />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
