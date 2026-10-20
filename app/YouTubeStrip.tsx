"use client";
import { useEffect, useRef } from "react";
import { YouTubeMedia, type YouTubeHandlers } from "@/lib/youtube";

/** YouTube player in the media strip; hands a media-element-like adapter to the page via onMedia. */
export default function YouTubeStrip({ id, start, className, onMedia, ...handlers }: YouTubeHandlers & {
  id: string; start: number; className?: string; onMedia: (m: YouTubeMedia | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hRef = useRef(handlers);
  hRef.current = handlers;
  const mediaRef = useRef(onMedia);
  mediaRef.current = onMedia;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // The IFrame API replaces its host element, so give it a child React doesn't own.
    const host = document.createElement("div");
    wrap.appendChild(host);
    const media = new YouTubeMedia(host, id, start, () => hRef.current);
    mediaRef.current(media);
    return () => {
      media.destroy();
      mediaRef.current(null);
      wrap.replaceChildren();
    };
  }, [id, start]);

  return <div ref={wrapRef} className={className} style={{ aspectRatio: "16 / 9", width: 284, height: 160 }} data-testid="youtube-strip" />;
}
