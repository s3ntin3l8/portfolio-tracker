"use client";

import React, { useState, useEffect, useRef, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface PullToRefreshProps {
  children: React.ReactNode;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function PullToRefresh({ children, scrollContainerRef }: PullToRefreshProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pullDistance, setPullDistance] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const startYRef = useRef(0);
  const activeRef = useRef(false);

  // Constants defining gesture behavior and heights
  const TRIGGER_HEIGHT = 65;
  const REFRESH_HEIGHT = 50;
  const MAX_PULL = 100;
  const RESISTANCE = 0.45;

  const pullDistanceRef = useRef(0);

  // Sync pullDistance to ref for event handlers to avoid re-binding listeners
  useEffect(() => {
    pullDistanceRef.current = pullDistance;
  }, [pullDistance]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleTouchStart = (e: TouchEvent) => {
      // Pull-to-refresh is only allowed if container is at the exact top
      if (container.scrollTop <= 0) {
        startYRef.current = e.touches[0].clientY;
        activeRef.current = true;
        setIsDragging(true);
      } else {
        activeRef.current = false;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!activeRef.current) return;
      const currentY = e.touches[0].clientY;
      const dy = currentY - startYRef.current;

      if (dy > 0) {
        // Prevent default browser bounce / reload gestures (like Chrome's pull-to-refresh)
        if (e.cancelable) {
          e.preventDefault();
        }
        const dist = Math.min(MAX_PULL, dy * RESISTANCE);
        setPullDistance(dist);
      }
    };

    const handleTouchEnd = () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      setIsDragging(false);

      if (pullDistanceRef.current >= TRIGGER_HEIGHT) {
        setPullDistance(REFRESH_HEIGHT);
        startTransition(() => {
          router.refresh();
        });
      } else {
        setPullDistance(0);
      }
    };

    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
    };
  }, [scrollContainerRef, router]);

  // Once router transition completes, release the container height back to 0
  useEffect(() => {
    if (!isPending) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPullDistance(0);
    }
  }, [isPending]);

  const isRefreshing = isPending;
  const showIndicator = pullDistance > 0 || isRefreshing;
  const rotation = isRefreshing ? 0 : pullDistance * 5;
  const scale = isRefreshing ? 1 : Math.min(1, pullDistance / TRIGGER_HEIGHT);
  const opacity = isRefreshing ? 1 : Math.min(1, pullDistance / (TRIGGER_HEIGHT * 0.7));

  return (
    <div className="relative w-full">
      {showIndicator && (
        <div
          className="absolute left-0 right-0 z-20 flex items-center justify-center overflow-hidden bg-background/95 border-b border-border"
          style={{
            height: `${pullDistance}px`,
            top: 0,
            transition: isDragging ? "none" : "height 0.22s cubic-bezier(0.25, 1, 0.5, 1)",
          }}
        >
          {/* Shimmer sweep effect */}
          {isRefreshing && (
            <div className="absolute inset-0 overflow-hidden">
              <div
                className="absolute inset-0 animate-shimmer bg-[length:200%_100%] bg-gradient-to-r from-transparent via-primary/20 to-transparent"
                aria-hidden
              />
            </div>
          )}

          <div
            className="relative flex items-center justify-center transition-opacity"
            style={{
              opacity,
              transform: `scale(${scale})`,
              transition: isDragging ? "none" : "transform 0.22s ease, opacity 0.22s ease",
            }}
          >
            <RefreshCw
              className={cn("size-5 text-primary", isRefreshing && "animate-spin")}
              style={{
                transform: isRefreshing ? undefined : `rotate(${rotation}deg)`,
              }}
            />
          </div>
        </div>
      )}

      {/* Main content wrapper translated downward during pull */}
      <div
        style={{
          transform: `translateY(${pullDistance}px)`,
          transition: isDragging ? "none" : "transform 0.22s cubic-bezier(0.25, 1, 0.5, 1)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
