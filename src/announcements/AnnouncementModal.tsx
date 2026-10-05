/**
 * 更新公告弹窗组件
 * - 展示最新公告内容
 * - 支持查看历史公告列表
 * - 关闭时标记已读
 */

import { useState, useEffect, useMemo } from 'react';
import { X, ChevronRight, Bell, History, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ANNOUNCEMENTS, type Announcement } from './announcements';
import { getLatestAnnouncement, hasUnreadAnnouncement, markAnnouncementRead } from '@/lib/announcement';

// 保持 re-export 兼容旧引用
export { getLatestAnnouncement, hasUnreadAnnouncement } from '@/lib/announcement';

export interface AnnouncementModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function AnnouncementModal({ open, onOpenChange }: AnnouncementModalProps) {
  const [view, setView] = useState<'latest' | 'history'>('latest');
  const [selectedId, setSelectedId] = useState<string | number | null>(null);

  const latest = useMemo(() => getLatestAnnouncement(), []);

  // 历史公告：只展示重大更新 + 上一期（前一条）公告
  // 最新公告（index 0）不在历史列表中重复展示
  const historyList = useMemo(() => {
    if (ANNOUNCEMENTS.length <= 1) return [];
    const rest = ANNOUNCEMENTS.slice(1); // 去掉最新的
    const result: Announcement[] = [];
    // 上一期公告（紧挨着最新的那一条）始终保留
    if (rest.length > 0) result.push(rest[0]);
    // 再挑出标记为重大更新的（跳过已包含的上一期）
    for (let i = 1; i < rest.length; i++) {
      if ((rest[i] as any).isMajor && !result.find(r => String(r.id) === String(rest[i].id))) {
        result.push(rest[i]);
      }
    }
    return result;
  }, []);
  const selectedAnnouncement = useMemo(() => {
    if (view === 'latest') return latest;
    if (selectedId !== null) {
      return ANNOUNCEMENTS.find(a => String(a.id) === String(selectedId)) || null;
    }
    return null;
  }, [view, selectedId, latest]);

  // 打开时默认看最新
  useEffect(() => {
    if (open) {
      setView('latest');
      setSelectedId(null);
    }
  }, [open]);

  const handleClose = () => {
    // 关闭时标记最新公告已读
    if (latest) {
      markAnnouncementRead(latest.id);
    }
    onOpenChange(false);
  };

  if (!latest) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); else onOpenChange(true); }}>
      <DialogContent showCloseButton={false} className="bg-card/95 backdrop-blur-xl border border-border text-foreground w-[92vw] max-w-[520px] p-0 overflow-hidden rounded-lg max-h-[80vh] flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell className="w-5 h-5 text-primary" />
            <DialogTitle className="text-base font-semibold">
              {view === 'latest' ? '更新公告' : '历史公告'}
            </DialogTitle>
          </div>
          <button
            onClick={handleClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          {view === 'latest' ? (
            <AnnouncementContent announcement={latest} />
          ) : (
            <div className="flex h-full">
              {/* 左侧历史列表 */}
              <div className="w-40 border-r border-border/60 flex-shrink-0">
                <ScrollArea className="h-full">
    <div className="p-2 space-y-1">
                       {historyList.map((a) => {
                      const isActive = String(selectedId) === String(a.id);
                      return (
                        <button
                          key={a.id}
                          onClick={() => setSelectedId(a.id)}
                          className={`w-full text-left px-2.5 py-2 rounded-md text-xs transition-colors ${
                            isActive
                              ? 'bg-primary/10 text-primary'
                              : 'text-foreground/70 hover:bg-accent/50 hover:text-foreground'
                          }`}
                        >
                          <div className="font-medium truncate">{a.title}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">{a.date}</div>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>
              {/* 右侧详情 */}
              <div className="flex-1 min-w-0">
                {selectedAnnouncement ? (
                  <AnnouncementContent announcement={selectedAnnouncement} compact />
                ) : (
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    选择一条公告查看
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底部操作区 */}
        <div className="px-5 py-3 border-t border-border/60 flex items-center justify-between">
          <button
            onClick={() => setView(view === 'latest' ? 'history' : 'latest')}
            className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1"
          >
            <History className="w-3.5 h-3.5" />
            {view === 'latest' ? '查看历史公告' : '返回最新公告'}
          </button>
          <Button size="sm" onClick={handleClose} className="gap-1.5">
            <CheckCircle2 className="w-4 h-4" />
            我知道了
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 公告内容渲染 */
function AnnouncementContent({
  announcement,
  compact = false,
}: {
  announcement: Announcement;
  compact?: boolean;
}) {
  return (
    <ScrollArea className={compact ? 'h-full' : 'max-h-[50vh]'}>
      <div className={`${compact ? 'p-4' : 'px-5 pb-5 pt-1'}`}>
        {/* 元信息 */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
          <span>{announcement.date}</span>
          {announcement.version && (
            <>
              <span className="w-1 h-1 rounded-full bg-border" />
              <span className="font-mono">{announcement.version}</span>
            </>
          )}
        </div>

        {/* 非 compact 模式才显示大标题（Dialog 标题已显示） */}
        {compact && (
          <h3 className="text-base font-semibold text-foreground mb-3">
            {announcement.title}
          </h3>
        )}

        {/* 要点列表 */}
        {announcement.highlights && announcement.highlights.length > 0 && (
          <div className="space-y-2 mb-4">
            {announcement.highlights.map((item, i) => (
              <div key={i} className="flex items-start gap-2 text-sm text-foreground/85">
                <ChevronRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                <span className="leading-relaxed">{item}</span>
              </div>
            ))}
          </div>
        )}

        {/* 正文 */}
        {announcement.content && (
          <>
            <Separator className="my-3" />
            <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
              {announcement.content}
            </p>
          </>
        )}
      </div>
    </ScrollArea>
  );
}
