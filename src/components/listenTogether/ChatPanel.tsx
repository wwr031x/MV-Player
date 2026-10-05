//
// ChatPanel - 一起听聊天输入 + 历史记录面板
//  - 底部输入框（发送弹幕）
//  - 可展开的历史记录列表
//
import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { Send, MessageSquare, X, ChevronUp, ChevronDown, Music2 } from 'lucide-react';
 import { Button } from '@/components/ui/button';
 import { Input } from '@/components/ui/input';
 import { ScrollArea } from '@/components/ui/scroll-area';
 import { Image } from '@/components/ui/image';
 import { useListenTogether } from '@/contexts/ListenTogetherContext';
import { cn } from '@/lib/utils';

/** 根据 seed 生成 dicebear 默认头像 URL */
function getDefaultAvatarUrl(seed: string): string {
  return `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(seed || 'anon')}`;
}

function ChatPanel() {
   const { inRoom, sendDanmaku, chatHistory, user, getMemberDisplayInfo } = useListenTogether();
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 展开时自动滚动到底
  useEffect(() => {
    if (expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [expanded, chatHistory.length]);

  const handleSend = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim() || !inRoom) return;
      sendDanmaku(input.trim());
      setInput('');
    },
    [input, sendDanmaku, inRoom]
  );

  if (!inRoom) return null;

  return (
    <div className="flex flex-col gap-2">
      {/* 聊天输入 */}
      <form onSubmit={handleSend} className="flex items-center gap-2">
        <Input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="发个弹幕聊聊..."
          maxLength={60}
          className="h-9 text-sm"
        />
        <Button type="submit" size="sm" disabled={!input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </form>

      {/* 历史记录切换按钮 */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded((v) => !v)}
        className="h-7 justify-start gap-2 text-xs text-muted-foreground"
      >
        <MessageSquare className="h-3.5 w-3.5" />
        <span>历史聊天记录 ({chatHistory.length})</span>
        {expanded ? (
          <ChevronDown className="ml-auto h-3.5 w-3.5" />
        ) : (
          <ChevronUp className="ml-auto h-3.5 w-3.5" />
        )}
      </Button>

      {/* 历史记录面板 */}
      {expanded && (
        <div className="relative h-48 overflow-hidden rounded-md border border-border/50 bg-card/50">
          <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
            <span className="text-xs font-medium text-foreground">聊天记录</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setExpanded(false)}
              className="h-6 w-6"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ScrollArea className="h-[calc(100%-36px)]">
            <div ref={scrollRef} className="space-y-2.5 p-3">
              {chatHistory.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  暂无聊天记录
                </div>
              ) : (
                 chatHistory.map((msg) => {
                   const isSelf = msg.fromUid === user.uid;
                   const info = getMemberDisplayInfo(msg.fromUid);
                   const avatarUrl = info.avatarUrl || getDefaultAvatarUrl(info.avatarSeed || msg.fromUid);
                   return (
                    <div
                      key={msg.id}
                      className={cn(
                        'flex gap-2',
                        isSelf ? 'flex-row-reverse' : 'flex-row'
                      )}
                    >
                       <div className="h-7 w-7 shrink-0 rounded-full overflow-hidden border border-border/50 bg-accent/40 flex items-center justify-center">
                         {info.avatarUrl ? (
                           <Image src={avatarUrl} alt={info.nickname} className="w-full h-full object-cover" />
                         ) : (
                           <Music2 className="h-3.5 w-3.5 text-muted-foreground/70" />
                         )}
                       </div>
                      <div
                        className={cn(
                          'flex flex-col gap-0.5 max-w-[calc(100%-36px)]',
                          isSelf ? 'items-end' : 'items-start'
                        )}
                      >
                         <div className="text-[10px] text-muted-foreground px-1">
                           {info.nickname}
                         </div>
                        <div
                          className={cn(
                            'rounded-lg px-2.5 py-1.5 text-sm break-words',
                            isSelf
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-foreground'
                          )}
                        >
                          {msg.content}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

export default memo(ChatPanel);
