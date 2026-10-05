import { useRef, useState, useEffect, useMemo, memo } from 'react';

interface VirtualListProps<T> {
  items: T[];
  itemHeight: number; // 每项预估高度（px）
  overscan?: number; // 上下额外渲染的项数
  renderItem: (item: T, index: number) => React.ReactNode;
  className?: string;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  // 可选：底部内容（加载更多、sentinel 等）
  footer?: React.ReactNode;
  footerHeight?: number;
}

/**
 * 虚拟列表组件：仅渲染视口可见的项，大幅减少 DOM 节点数
 * 适用于数百到数千条数据的长列表
 */
function VirtualListInner<T>({
  items,
  itemHeight,
  overscan = 5,
  renderItem,
  className = '',
  onScroll,
  footer,
  footerHeight = 40,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // 监听容器尺寸变化
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      setViewportHeight(el.clientHeight);
    };
    updateSize();

    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalCount = items.length;
  const totalHeight = totalCount * itemHeight + (footer ? footerHeight : 0);

  // 计算可见范围
  const { startIndex, endIndex, offsetY } = useMemo(() => {
    if (viewportHeight === 0 || totalCount === 0) {
      return { startIndex: 0, endIndex: 0, offsetY: 0 };
    }
    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const visibleCount = Math.ceil(viewportHeight / itemHeight) + overscan * 2;
    const end = Math.min(totalCount, start + visibleCount);
    return {
      startIndex: start,
      endIndex: end,
      offsetY: start * itemHeight,
    };
  }, [scrollTop, viewportHeight, totalCount, itemHeight, overscan]);

  const visibleItems = useMemo(() => {
    return items.slice(startIndex, endIndex);
  }, [items, startIndex, endIndex]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    onScroll?.(e);
  };

  if (totalCount === 0) {
    return (
      <div ref={containerRef} className={`overflow-y-auto ${className}`}>
        {footer}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`overflow-y-auto ${className}`}
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${offsetY}px)`, position: 'absolute', left: 0, right: 0, top: 0 }}>
          {visibleItems.map((item, i) => {
            const actualIndex = startIndex + i;
            return (
              <div key={String((item as any).id || actualIndex)} style={{ height: itemHeight }}>
                {renderItem(item, actualIndex)}
              </div>
            );
          })}
        </div>
        {footer && (
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: footerHeight,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// memo 避免父级重渲染时不必要的 recalc
export default memo(VirtualListInner) as typeof VirtualListInner;
