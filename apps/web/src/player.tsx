import { memo, useEffect, useRef, useState } from "react";
import { CameraOff, LoaderCircle, RotateCw, Video } from "lucide-react";
import type { CameraClient } from "@librecam/sdk";
import { Button } from "@/components/ui/button";

interface PlayerProps {
  client: CameraClient;
  id: string;
  name: string;
  authenticated: boolean;
  flipped?: boolean;
}

export const Player = memo(function Player({
  client,
  id,
  name,
  authenticated,
  flipped = false,
}: PlayerProps) {
  const image = useRef<HTMLImageElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{
    phase: "waiting" | "live" | "error";
    detail?: string;
  }>({ phase: "waiting" });

  useEffect(() => {
    if (!authenticated) return;
    const abort = new AbortController();
    const element = image.current;
    if (!element) return;
    let previousUrl: string | undefined;
    let loaded = false;
    let rejected = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetDeadline = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        setView({
          phase: "error",
          detail:
            rejected > 0
              ? "The browser could not decode the frames from the camera."
              : "The camera stopped delivering frames.",
        });
        abort.abort();
      }, 15000);
    };
    resetDeadline();

    async function play() {
      setView({ phase: "waiting" });
      try {
        for await (const frame of client.video(id, abort.signal)) {
          if (abort.signal.aborted || !element) return;
          // Update the image directly so each frame does not rerender the player.
          const currentUrl = URL.createObjectURL(frame);
          try {
            const next = new Image();
            next.src = currentUrl;
            try {
              await next.decode();
            } catch {
              rejected++;
              continue;
            }
            if (abort.signal.aborted) return;
            element.src = currentUrl;
            if (previousUrl) URL.revokeObjectURL(previousUrl);
            previousUrl = currentUrl;
          } finally {
            if (previousUrl !== currentUrl) URL.revokeObjectURL(currentUrl);
          }
          rejected = 0;
          resetDeadline();
          if (!loaded) {
            loaded = true;
            setView({ phase: "live" });
          }
        }
        if (!abort.signal.aborted)
          setView({ phase: "error", detail: "The stream ended." });
      } catch (error) {
        if (!abort.signal.aborted)
          setView({
            phase: "error",
            detail:
              error instanceof Error
                ? error.message
                : "The stream could not be opened.",
          });
      } finally {
        clearTimeout(idle);
      }
    }
    void play();
    return () => {
      abort.abort();
      clearTimeout(idle);
      element.removeAttribute("src");
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    };
  }, [authenticated, client, id, attempt]);

  const live = authenticated && view.phase === "live";
  return (
    <div className="video-stage aspect-video">
      {authenticated && (
        <img
          ref={image}
          className={`absolute inset-0 size-full object-contain ${flipped ? "rotate-180" : ""} ${live ? "" : "invisible"}`}
          alt={`Live view of ${name}`}
        />
      )}
      {live ? (
        <span className="absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-xs font-semibold text-white">
          <span className="mr-1.5 inline-block size-1.5 rounded-full bg-emerald-400" />
          Live
        </span>
      ) : (
        <div className="relative z-10 flex max-w-sm flex-col items-center gap-2 px-4 text-center">
          {!authenticated ? (
            <CameraOff className="size-7" />
          ) : view.phase === "waiting" ? (
            <LoaderCircle className="size-7 animate-spin" />
          ) : (
            <Video className="size-7" />
          )}
          <p className="font-medium text-white">
            {!authenticated
              ? "Camera disconnected"
              : view.phase === "waiting"
                ? "Connected · waiting for video"
                : "Video unavailable"}
          </p>
          <p className="text-xs leading-relaxed text-slate-300">
            {!authenticated
              ? "Connect this camera to start a live stream."
              : view.phase === "waiting"
                ? "The player will open when the first JPEG frame arrives."
                : view.detail}
          </p>
          {authenticated && view.phase === "error" && (
            <Button
              variant="outline"
              className="mt-1"
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RotateCw className="size-4" /> Retry stream
            </Button>
          )}
        </div>
      )}
    </div>
  );
});
