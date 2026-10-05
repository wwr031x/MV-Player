//
// MemberList - 一起听房间成员列表
//  - 展示成员 ID、昵称、头像、房主标识
//  - 实时更新
//
import { memo } from 'react';
import { Crown, User } from 'lucide-react';
import { useListenTogether } from '@/contexts/ListenTogetherContext';
import { cn } from '@/lib/utils';
import { Image } from '@/components/ui/image';

function MemberList() {
  const { members, user } = useListenTogether();

  // 房主：isHost 字段，或第一个成员
  const hostUid = members.find((m) => m.isHost)?.uid || members[0]?.uid || '';

  if (members.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-muted-foreground">
        暂无成员
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>在房成员</span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px]">
          {members.length} 人
        </span>
      </div>
      <div className="space-y-1.5">
        {members.map((m) => {
          const isMe = m.uid === user.uid;
          const isHostMember = m.uid === hostUid;
          const seed = m.avatarSeed || m.uid;
          const firstChar = (m.nickname || '?').charAt(0).toUpperCase();
          return (
            <div
              key={m.uid}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2 py-1.5',
                isMe && 'bg-primary/10'
              )}
            >
              {/* 头像 */}
              <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full bg-muted">
                <Image
                  src={`https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(seed)}`}
                  alt=""
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">
                    {m.nickname || '匿名用户'}
                  </span>
                  {isHostMember && (
                    <Crown
                      className="h-3.5 w-3.5 shrink-0 text-amber-500"
                      aria-label="房主"
                    />
                  )}
                </div>
                <div className="truncate text-[10px] text-muted-foreground">
                  ID: {m.uid.slice(0, 8)}
                  {isMe && ' (我)'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(MemberList);
