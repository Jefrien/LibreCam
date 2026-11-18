import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Camera, CameraClient, CameraEvent } from "@librecam/sdk";

export const camerasKey = ["cameras"] as const;

export function useCameraEvents(client: CameraClient) {
  const cache = useQueryClient();
  const [state, setState] = useState<"connecting" | "live" | "retrying">(
    "connecting",
  );

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;
    function reconnect() {
      setState("retrying");
      retry = setTimeout(open, Math.min(15000, 1000 * 2 ** attempts++));
    }
    function open() {
      try {
        socket = client.openEvents();
      } catch {
        reconnect();
        return;
      }
      socket.onopen = () => {
        attempts = 0;
        setState("live");
        void cache.invalidateQueries({ queryKey: camerasKey });
      };
      socket.onclose = () => {
        if (!stopped) reconnect();
      };
      socket.onmessage = (message) => {
        try {
          const event: CameraEvent = JSON.parse(String(message.data));
          if (event.type === "cameras")
            cache.setQueryData(camerasKey, event.cameras);
          if (event.type === "camera.status") {
            cache.setQueryData<Camera[]>(camerasKey, (cameras = []) =>
              [
                ...cameras.filter((camera) => camera.id !== event.camera.id),
                event.camera,
              ].sort((a, b) => a.id.localeCompare(b.id)),
            );
          }
        } catch {
          // Polling still refreshes inventory if an event cannot be parsed.
        }
      };
    }
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      if (socket) {
        socket.onmessage = null;
        socket.onopen = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [cache, client]);
  return state;
}
