import { useMutation } from "@tanstack/react-query";
import type { CameraClient, CameraControl } from "@librecam/sdk";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Lightbulb,
  Moon,
  Move,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const directions = [
  ["up", ArrowUp],
  ["left", ArrowLeft],
  ["down", ArrowDown],
  ["right", ArrowRight],
] as const;

export function CameraControls({
  client,
  id,
  disabled,
}: {
  client: CameraClient;
  id: string;
  disabled: boolean;
}) {
  const control = useMutation({
    mutationFn: (command: CameraControl) => client.control(id, command),
  });
  const busy = disabled || control.isPending;
  return (
    <section
      aria-label="Camera controls"
      className="rounded-lg border border-border p-4"
    >
      <h2 className="font-semibold">Camera controls</h2>
      <div className="mt-3 flex flex-wrap gap-x-8 gap-y-4">
        {(
          [
            ["light", "Lamp", Lightbulb],
            ["white-light", "White light", Lightbulb],
            ["infrared", "IR cut", Moon],
          ] as const
        ).map(([kind, label, Icon]) => (
          <fieldset key={kind} className="min-w-0">
            <legend className="mb-2 text-xs text-muted">
              <Icon className="mr-1.5 inline size-4 text-brand" />
              {label}
            </legend>
            <div className="flex gap-2">
              {[true, false].map((enabled) => (
                <Button
                  key={String(enabled)}
                  variant="outline"
                  aria-label={`${label} ${enabled ? "on" : "off"}`}
                  disabled={busy}
                  onClick={() => control.mutate({ kind, enabled })}
                >
                  {enabled ? "On" : "Off"}
                </Button>
              ))}
            </div>
          </fieldset>
        ))}
        <fieldset>
          <legend className="mb-2 text-xs text-muted">
            <Move className="mr-1.5 inline size-4 text-brand" />
            Pan / tilt
          </legend>
          <div className="flex flex-wrap gap-2">
            {directions.map(([direction, Icon]) => (
              <Button
                key={direction}
                variant="outline"
                className="size-9 px-0"
                aria-label={`Move ${direction}`}
                title={`Move ${direction}`}
                disabled={busy}
                onClick={() => control.mutate({ kind: "ptz", direction })}
              >
                <Icon className="size-4" />
              </Button>
            ))}
          </div>
        </fieldset>
      </div>
      {control.isPending && (
        <p role="status" className="mt-3 text-xs text-muted">
          Sending command…
        </p>
      )}
      {control.isSuccess && (
        <p role="status" className="mt-3 text-xs text-success">
          Command acknowledged by the camera. The effect depends on its
          firmware.
        </p>
      )}
      {control.error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {control.error.message}
        </p>
      )}
    </section>
  );
}
