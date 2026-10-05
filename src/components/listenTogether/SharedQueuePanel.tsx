//
// SharedQueuePanel - 一起听共享队列面板
//  - 展示当前共享队列
//  - 全员可添加、删除（房主可重排序）
//
import { memo, useCallback } from 'react';
import { Plus, Trash2, Music, ListMusic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Image } from '@/components/ui/image';
import { useListenTogether } from '@/contexts/ListenTogetherContext';
import { usePlayer } from '@/contexts/PlayerContext';
import { cn } from '@/lib/utils';
import type { ITrack } from '@/types';

interface SharedQueuePanelProps {
  onImportClick: () => void;
}

function SharedQueuePanel({ onImportClick }: SharedQueuePanelProps) {
  const { inRoom, sharedQueue, isHost, removeFromSharedQueue, room, getTrackAddedByInfo } = useListenTogether();
  const { currentTrack, playTrackById } = usePlayer();

  const handlePlay = useCallback(
    (track: ITrack) => {
      playTrackById(track.id);
    },
    [playTrackById]
  );

  const handleRemove = useCallback(
    (trackId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      removeFromSharedQueue([trackId]);
    },
    [removeFromSharedQueue]
  );

  if (!inRoom) return null;

  const currentIndex = room?.currentQueueIndex ?? -1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListMusic className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">共享队列</span>
          <span className="text-xs text-muted-foreground">
            {sharedQueue.length} 首
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={onImportClick}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          导入
        </Button>
      </div>

      {/* 队列列表 */}
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/40 bg-card/30 p-1">
        {sharedQueue.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Music className="h-6 w-6 opacity-40" />
            <span>共享队列为空</span>
            <span className="text-[10px] opacity-60">点击「导入」添加歌曲</span>
          </div>
        ) : (
          sharedQueue.map((track, idx) => {
            const isCurrent = currentTrack?.id === track.id;
            const addedBy = getTrackAddedByInfo(track.addedBy);
            return (
              <div
                key={track.id}
                onClick={() => handlePlay(track)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 transition-colors hover:bg-muted/50',
                  isCurrent && 'bg-primary/10'
                )}
              >
                <span
                  className={cn(
                    'w-5 shrink-0 text-right text-xs tabular-nums',
                    isCurrent ? 'text-primary font-medium' : 'text-muted-foreground'
                  )}
                >
                  {idx + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'truncate text-sm',
                      isCurrent ? 'font-medium text-primary' : 'text-foreground'
                    )}
                  >
                    {track.name}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {track.artist}
                  </div>
                  {/* 添加者信息 */}
                  <div className="flex items-center gap-1 mt-0.5">
                    <div className="h-3.5 w-3.5 shrink-0 rounded-full overflow-hidden border border-border/40 bg-accent/50">
                      {addedBy.avatarUrl ? (
                        <Image
                          src={addedBy.avatarUrl}
                          alt={addedBy.nickname}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[8px] text-muted-foreground">
                          {addedBy.nickname.charAt(0)}
                        </div>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground/80 truncate">
                      由 {addedBy.nickname} 添加
                    </span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => handleRemove(track.id, e)}
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  aria-label="移除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default memo(SharedQueuePanel);
