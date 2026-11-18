import { CameraControls } from "./camera-controls";
import { CameraClient, type Camera } from "@librecam/sdk";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Camera as CameraIcon,
  CameraOff,
  CircleAlert,
  CircleHelp,
  Download,
  Grid2X2,
  LayoutDashboard,
  LoaderCircle,
  Moon,
  Radio,
  RefreshCw,
  RotateCw,
  ScanLine,
  Settings,
  Sun,
  Video,
  Wifi,
  WifiOff,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { camerasKey, useCameraEvents } from "./network";
import { Player } from "./player";
import "./index.css";

const pages = {
  overview: {
    title: "Overview",
    icon: LayoutDashboard,
    description: "Camera connectivity and video availability at a glance.",
  },
  discovery: {
    title: "Discovery",
    icon: ScanLine,
    description: "Find PPPP cameras on the server’s local network.",
  },
  cameras: {
    title: "Cameras",
    icon: CameraIcon,
    description: "Manage camera sessions and inspect device details.",
  },
  live: {
    title: "Live view",
    icon: Video,
    description: "Open a single camera stream and capture a snapshot.",
  },
  multiview: {
    title: "Multiview",
    icon: Grid2X2,
    description: "Choose up to four cameras to watch in parallel.",
  },
  diagnostics: {
    title: "Diagnostics",
    icon: Activity,
    description: "Inspect PPPP session transitions and received video traffic.",
  },
  settings: {
    title: "Settings",
    icon: Settings,
    description:
      "Configure the server connection and review credential settings.",
  },
} as const;

type Page = keyof typeof pages;
type Connection = { endpoint: string; token: string };
type Action = {
  id: string;
  kind: "connect" | "reconnect" | "disconnect" | "snapshot";
};

function currentPage(): Page {
  const page = window.location.hash.slice(1);
  return Object.hasOwn(pages, page) ? (page as Page) : "overview";
}

function name(camera: Camera): string {
  return [camera.device.prefix.replace(/\0/g, ""), camera.device.serial]
    .filter(Boolean)
    .join(" · ");
}

function firmware(camera: Camera): string {
  const version = camera.properties?.firmware ?? camera.properties?.sysver;
  return typeof version === "string" ? version : "—";
}

function isAuthenticated(camera: Camera): boolean {
  return camera.authenticated ?? camera.state === "authenticated";
}

function CameraBadge({ camera }: { camera: Camera }) {
  const state = camera.sessionState ?? camera.state;
  const label = {
    disconnected: "Disconnected",
    connecting: "Connecting",
    connected: "Connected",
    authenticating: "Authenticating",
    authenticated: "Authenticated",
    reconnecting: "Reconnecting",
    closed: "Disconnected",
  }[state];
  const tone =
    state === "authenticated"
      ? "text-success"
      : state === "disconnected" || state === "closed"
        ? "text-muted"
        : "text-warning";
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-full border border-current/25 px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function Empty({ scan }: { scan?: () => void }) {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <div className="mb-1 rounded-lg bg-brand-soft p-2.5 text-brand">
        <CameraOff className="size-5" />
      </div>
      <p className="font-semibold">No cameras discovered</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted">
        Scan the local network to find cameras connected to the same network as
        the server.
      </p>
      {scan && (
        <Button variant="outline" className="mt-2" onClick={scan}>
          <ScanLine className="size-4" /> Scan network
        </Button>
      )}
    </div>
  );
}

function CameraTable({
  cameras,
  action,
  busy,
  open,
}: {
  cameras: Camera[];
  action: (action: Action) => void;
  busy?: string;
  open: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-left">
        <thead className="bg-background/50 text-xs text-muted">
          <tr>
            {[
              "Camera",
              "Network address",
              "Firmware",
              "Session",
              "Actions",
            ].map((heading) => (
              <th scope="col" className="px-4 py-3 font-medium" key={heading}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {cameras.map((camera) => (
            <tr key={camera.id} className="hover:bg-accent/35">
              <th scope="row" className="px-4 py-3 font-medium">
                <button
                  className="flex items-center gap-2 text-left hover:text-brand"
                  onClick={() => open(camera.id)}
                >
                  <span className="rounded-md bg-brand-soft p-2 text-brand">
                    <CameraIcon className="size-4" />
                  </span>
                  {name(camera)}
                </button>
              </th>
              <td className="px-4 py-3 font-mono text-xs text-muted">
                {camera.ip}:{camera.port}
              </td>
              <td className="px-4 py-3 text-xs text-muted">
                {firmware(camera)}
              </td>
              <td className="px-4 py-3">
                <CameraBadge camera={camera} />
              </td>
              <td className="px-4 py-3">
                <Button
                  variant="outline"
                  className="min-h-8 px-2.5 text-xs"
                  disabled={busy === camera.id}
                  onClick={() =>
                    action({
                      id: camera.id,
                      kind:
                        camera.state === "disconnected"
                          ? "connect"
                          : "disconnect",
                    })
                  }
                >
                  {camera.state === "disconnected" ? "Connect" : "Disconnect"}
                </Button>
                {camera.state !== "disconnected" && (
                  <Button
                    variant="outline"
                    className="ml-1 min-h-8 px-2.5 text-xs"
                    disabled={busy === camera.id}
                    onClick={() => action({ id: camera.id, kind: "reconnect" })}
                  >
                    Reconnect
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Config({
  connection,
  save,
  mode,
  toggleMode,
}: {
  connection: Connection;
  save: (connection: Connection) => void;
  mode: "dark" | "light";
  toggleMode: () => void;
}) {
  const [endpoint, setEndpoint] = useState(connection.endpoint);
  const [token, setToken] = useState(connection.token);
  const [message, setMessage] = useState("");
  const [invalid, setInvalid] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let origin = "";
    try {
      if (endpoint.trim()) {
        const url = new URL(endpoint.trim());
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error();
        origin = url.origin;
      }
    } catch {
      setInvalid(true);
      setMessage("Enter a server origin such as http://localhost:3000.");
      return;
    }
    if (token && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      setInvalid(true);
      setMessage(
        "Enter the server’s API token using 32–256 base64url characters.",
      );
      return;
    }
    setInvalid(false);
    save({ endpoint: origin, token });
    setMessage("Connection settings applied.");
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <form onSubmit={submit} className="panel grid content-start gap-4 p-5">
        <h2 className="font-semibold">API connection</h2>
        <label className="grid gap-1.5 text-xs font-medium">
          Server origin
          <input
            className="field text-sm"
            placeholder="Same origin (default)"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium">
          API token
          <input
            className="field text-sm"
            type="password"
            autoComplete="off"
            placeholder="Optional on a local server"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <p className="text-xs leading-relaxed text-muted">
          The token stays in memory and is cleared when you reload the page. For
          a separate server origin, allow this UI origin in the server’s CORS
          configuration.
        </p>
        <div>
          <Button type="submit">Apply connection</Button>
        </div>
        {message && (
          <p
            role={invalid ? "alert" : "status"}
            className={invalid ? "text-danger" : "text-success"}
          >
            {message}
          </p>
        )}
      </form>
      <div className="grid content-start gap-4">
        <section className="panel p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <CircleHelp className="size-4 text-brand" /> Camera credentials
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Set <code>PPPP_USER</code> and <code>PPPP_PASS</code> in the
            server’s environment, then restart the server and reconnect your
            cameras.
          </p>
        </section>
        <section className="panel flex flex-wrap items-center justify-between gap-3 p-5">
          <h2 className="font-semibold">Appearance</h2>
          <Button variant="outline" onClick={toggleMode}>
            {mode === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
            Use {mode === "dark" ? "light" : "dark"} mode
          </Button>
        </section>
      </div>
    </div>
  );
}

function Console({
  connection,
  save,
  mode,
  toggleMode,
}: {
  connection: Connection;
  save: (value: Connection) => void;
  mode: "dark" | "light";
  toggleMode: () => void;
}) {
  const cache = useQueryClient();
  const client = useMemo(
    () => new CameraClient(connection.endpoint, connection.token),
    [connection],
  );
  const [page, setPage] = useState<Page>(currentPage);
  const [selection, setSelection] = useState("");
  const [streamVersions, setStreamVersions] = useState<Record<string, number>>(
    {},
  );
  const [flippedCameras, setFlippedCameras] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem("librecam.flipped-cameras") ?? "[]",
      );
      return Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem(
      "librecam.flipped-cameras",
      JSON.stringify(flippedCameras),
    );
  }, [flippedCameras]);
  const [grid, setGrid] = useState<string[]>([]);
  const events = useCameraEvents(client);
  const inventory = useQuery({
    queryKey: camerasKey,
    queryFn: ({ signal }) => client.list(signal),
    refetchInterval: events === "live" ? 10000 : 3000,
    retry: 1,
  });
  const scan = useMutation({
    mutationFn: () => client.discover(),
    onSuccess: (cameras) => cache.setQueryData(camerasKey, cameras),
  });
  const action = useMutation({
    mutationFn: async ({ id, kind }: Action) => {
      if (kind === "connect") return client.connect(id);
      if (kind === "reconnect") return client.reconnect(id);
      if (kind === "disconnect") return client.disconnect(id);
      const url = URL.createObjectURL(
        await client.snapshot(id, AbortSignal.timeout(12000)),
      );
      const download = Object.assign(document.createElement("a"), {
        href: url,
        download: `librecam-${id}.jpg`,
      });
      download.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return undefined;
    },
    onSuccess: (camera, { id, kind }) => {
      if (kind === "reconnect")
        setStreamVersions((versions) => ({
          ...versions,
          [id]: (versions[id] ?? 0) + 1,
        }));
      if (camera)
        cache.setQueryData<Camera[]>(camerasKey, (items = []) =>
          items.map((item) => (item.id === camera.id ? camera : item)),
        );
      void cache.invalidateQueries({ queryKey: camerasKey });
    },
  });
  useEffect(() => {
    const onNavigate = () => setPage(currentPage());
    window.addEventListener("hashchange", onNavigate);
    return () => window.removeEventListener("hashchange", onNavigate);
  }, []);

  const cameras = inventory.data ?? [];
  const selected =
    cameras.find((camera) => camera.id === selection) ?? cameras[0];
  const watched = grid.flatMap((id) =>
    cameras.filter((camera) => camera.id === id),
  );
  const authenticated = cameras.filter(isAuthenticated).length;
  const available = cameras.filter((camera) => camera.videoAvailable).length;
  const offline = inventory.isError;
  const error = action.error ?? scan.error ?? inventory.error;
  const active = pages[page];
  function open(id: string) {
    setSelection(id);
    window.location.hash = "live";
  }
  const scanButton = (
    <Button disabled={scan.isPending} onClick={() => scan.mutate()}>
      {scan.isPending ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <ScanLine className="size-4" />
      )}
      {scan.isPending ? "Scanning…" : "Scan network"}
    </Button>
  );
  const table =
    cameras.length > 0 ? (
      <CameraTable
        cameras={cameras}
        action={(value) => action.mutate(value)}
        busy={action.isPending ? action.variables?.id : undefined}
        open={open}
      />
    ) : (
      <Empty scan={scan.isPending ? undefined : () => scan.mutate()} />
    );
  const showCameraData =
    !inventory.isPending && (!offline || cameras.length > 0);

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[14.25rem_minmax(0,1fr)]">
      <aside className="border-b border-border bg-panel lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between px-4 py-4 lg:px-5 lg:py-6">
          <a className="flex items-center gap-3" href="#overview">
            <span className="rounded-xl bg-primary p-2.5 text-primary-foreground">
              <Video className="size-5" />
            </span>
            <div>
              <p className="text-base font-bold tracking-tight">LibreCam</p>
              <p className="text-[11px] text-muted">Camera console</p>
            </div>
          </a>
          <Button
            aria-label="Toggle theme"
            variant="outline"
            className="size-9 px-0 lg:hidden"
            onClick={toggleMode}
          >
            {mode === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>
        </div>
        <nav
          aria-label="Main navigation"
          className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:px-4"
        >
          {Object.entries(pages).map(([id, { title, icon: Icon }]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={page === id ? "page" : undefined}
              className={`flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium ${page === id ? "bg-brand-soft text-brand" : "text-muted hover:bg-accent hover:text-foreground"}`}
            >
              <Icon className="size-4" />
              {title}
            </a>
          ))}
        </nav>
        <div className="mx-4 mt-auto mb-4 hidden items-center gap-2 border-t border-border pt-4 text-xs text-muted lg:flex">
          <Radio className="size-4 text-brand" /> PPPP local network
        </div>
      </aside>

      <div className="min-w-0">
        <header className="flex min-h-16 items-center justify-between gap-3 border-b border-border bg-panel/60 px-4 sm:px-7">
          <span className="flex items-center gap-2 text-xs text-muted">
            <active.icon className="size-4" />
            {active.title}
          </span>
          <div className="flex items-center gap-2.5">
            <span
              role="status"
              className={`flex items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-xs ${offline ? "text-danger" : events === "live" ? "text-success" : "text-muted"}`}
            >
              {offline ? (
                <WifiOff className="size-3.5" />
              ) : (
                <Wifi className="size-3.5" />
              )}
              {offline
                ? "API unavailable"
                : inventory.isPending
                  ? "Connecting"
                  : events === "live"
                    ? "Events live"
                    : events === "retrying"
                      ? "Polling · reconnecting"
                      : "Polling"}
            </span>
            <Button
              aria-label="Toggle theme"
              variant="outline"
              className="hidden size-9 px-0 lg:inline-flex"
              onClick={toggleMode}
            >
              {mode === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
          </div>
        </header>
        <main className="mx-auto max-w-[100rem] px-4 py-6 sm:px-7 sm:py-8">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {active.title}
              </h1>
              <p className="mt-1.5 text-sm text-muted">{active.description}</p>
            </div>
            {["overview", "discovery", "cameras"].includes(page) && scanButton}
          </div>
          {error && (
            <div
              role="alert"
              className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-danger/40 bg-panel p-3 text-sm text-danger"
            >
              <CircleAlert className="size-4" />
              {error.message}
              {offline && (
                <Button
                  variant="outline"
                  className="ml-auto"
                  onClick={() => void inventory.refetch()}
                >
                  Retry connection
                </Button>
              )}
            </div>
          )}
          {scan.isSuccess && page === "discovery" && (
            <p role="status" className="mb-4 text-xs text-muted">
              Scan completed. {scan.data.length} known camera
              {scan.data.length === 1 ? "" : "s"} in the inventory.
            </p>
          )}
          {inventory.isPending && page !== "settings" && (
            <p
              role="status"
              className="panel flex items-center gap-2 p-4 text-muted"
            >
              <LoaderCircle className="size-4 animate-spin" /> Loading camera
              inventory…
            </p>
          )}

          {page === "overview" && showCameraData && (
            <>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                {(
                  [
                    ["Cameras", cameras.length, CameraIcon, "text-brand"],
                    ["Authenticated", authenticated, Wifi, "text-success"],
                    ["Video available", available, Video, "text-brand"],
                    [
                      "Disconnected",
                      cameras.filter(
                        (camera) => camera.state === "disconnected",
                      ).length,
                      WifiOff,
                      "text-warning",
                    ],
                  ] as const
                ).map(([label, value, Icon, color]) => (
                  <article
                    key={label}
                    className="panel flex items-center gap-3 p-4"
                  >
                    <span className={`rounded-lg bg-accent p-2.5 ${color}`}>
                      <Icon className="size-5" />
                    </span>
                    <div>
                      <p className="text-xs text-muted">{label}</p>
                      <p className="mt-0.5 text-xl font-semibold">{value}</p>
                    </div>
                  </article>
                ))}
              </div>
              <section className="panel mt-5 overflow-hidden">
                <div className="flex items-center justify-between gap-2 p-4">
                  <h2 className="font-semibold">Camera inventory</h2>
                  <a
                    href="#cameras"
                    className="flex items-center gap-1 text-xs font-medium text-brand"
                  >
                    Manage cameras <ArrowRight className="size-3.5" />
                  </a>
                </div>
                {table}
              </section>
            </>
          )}

          {(page === "discovery" || page === "cameras") && showCameraData && (
            <section className="panel overflow-hidden">
              <div className="flex items-center justify-between gap-3 p-4">
                <h2 className="font-semibold">
                  {page === "discovery"
                    ? "Discovered devices"
                    : "Camera inventory"}
                </h2>
                <Button
                  variant="outline"
                  disabled={inventory.isFetching}
                  onClick={() => void inventory.refetch()}
                >
                  <RefreshCw
                    className={`size-4 ${inventory.isFetching ? "animate-spin" : ""}`}
                  />{" "}
                  Refresh
                </Button>
              </div>
              {table}
            </section>
          )}

          {page === "live" && showCameraData && (
            <section className="panel grid gap-4 p-4">
              {!selected ? (
                <Empty />
              ) : (
                <>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <label className="grid min-w-48 gap-1.5 text-xs font-medium">
                      Camera
                      <select
                        className="field"
                        value={selected.id}
                        onChange={(event) => setSelection(event.target.value)}
                      >
                        {cameras.map((camera) => (
                          <option key={camera.id} value={camera.id}>
                            {name(camera)} · {camera.ip}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={action.isPending}
                        onClick={() =>
                          action.mutate({
                            id: selected.id,
                            kind:
                              selected.state === "disconnected"
                                ? "connect"
                                : "disconnect",
                          })
                        }
                      >
                        {selected.state === "disconnected"
                          ? "Connect"
                          : "Disconnect"}
                      </Button>
                      {selected.state !== "disconnected" && (
                        <Button
                          variant="outline"
                          disabled={action.isPending}
                          onClick={() =>
                            action.mutate({
                              id: selected.id,
                              kind: "reconnect",
                            })
                          }
                        >
                          <RefreshCw className="size-4" /> Reconnect
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        disabled={
                          !isAuthenticated(selected) || action.isPending
                        }
                        onClick={() =>
                          action.mutate({ id: selected.id, kind: "snapshot" })
                        }
                      >
                        <Download className="size-4" /> Snapshot
                      </Button>
                      <Button
                        variant="outline"
                        aria-pressed={flippedCameras.includes(selected.id)}
                        onClick={() =>
                          setFlippedCameras((ids) =>
                            ids.includes(selected.id)
                              ? ids.filter((id) => id !== selected.id)
                              : [...ids, selected.id],
                          )
                        }
                      >
                        <RotateCw className="size-4" /> Rotate image 180°
                      </Button>
                    </div>
                  </div>
                  <Player
                    key={`${selected.id}:${streamVersions[selected.id] ?? 0}`}
                    client={client}
                    id={selected.id}
                    name={name(selected)}
                    authenticated={!offline && isAuthenticated(selected)}
                    flipped={flippedCameras.includes(selected.id)}
                  />
                  <CameraControls
                    key={`controls-${selected.id}`}
                    client={client}
                    id={selected.id}
                    disabled={
                      offline || !isAuthenticated(selected) || action.isPending
                    }
                  />
                </>
              )}
            </section>
          )}

          {page === "multiview" && showCameraData && (
            <section className="panel grid gap-4 p-4">
              {!cameras.length ? (
                <Empty />
              ) : (
                <>
                  <fieldset>
                    <legend className="mb-2 text-xs font-medium">
                      Cameras ({watched.length}/4)
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {cameras.map((camera) => (
                        <label
                          key={camera.id}
                          className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
                        >
                          <input
                            type="checkbox"
                            className="accent-primary"
                            checked={grid.includes(camera.id)}
                            disabled={
                              !grid.includes(camera.id) && watched.length >= 4
                            }
                            onChange={() =>
                              setGrid((items) =>
                                items.includes(camera.id)
                                  ? items.filter((id) => id !== camera.id)
                                  : [
                                      ...items.filter((id) =>
                                        cameras.some((item) => item.id === id),
                                      ),
                                      camera.id,
                                    ],
                              )
                            }
                          />
                          {name(camera)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {!watched.length ? (
                    <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-muted">
                      Select cameras to open their streams.
                    </p>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      {watched.map((camera) => (
                        <article
                          className="rounded-lg border border-border p-2"
                          key={camera.id}
                        >
                          <div className="flex items-center justify-between gap-2 px-1 pb-2 text-xs">
                            <span>{name(camera)}</span>
                            <a
                              className="text-brand"
                              href="#live"
                              onClick={() => setSelection(camera.id)}
                            >
                              Open
                            </a>
                          </div>
                          <Player
                            key={`${camera.id}:${streamVersions[camera.id] ?? 0}`}
                            client={client}
                            id={camera.id}
                            name={name(camera)}
                            authenticated={!offline && isAuthenticated(camera)}
                            flipped={flippedCameras.includes(camera.id)}
                          />
                        </article>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {page === "diagnostics" && showCameraData && (
            <section className="panel overflow-hidden">
              {!cameras.length ? (
                <Empty />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[38rem] text-left">
                    <thead className="bg-background/50 text-xs text-muted">
                      <tr>
                        {[
                          "Camera",
                          "PPPP session",
                          "Video request",
                          "Chunks received",
                          "Video metrics",
                          "Viewers",
                          "Last frame",
                        ].map((label) => (
                          <th
                            key={label}
                            scope="col"
                            className="px-4 py-3 font-medium"
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {cameras.map((camera) => (
                        <tr key={camera.id}>
                          <th scope="row" className="px-4 py-3 font-medium">
                            {name(camera)}
                          </th>
                          <td className="px-4 py-3">
                            <CameraBadge camera={camera} />
                          </td>
                          <td className="px-4 py-3 text-muted">
                            {camera.videoActive
                              ? "Acknowledged"
                              : camera.videoRequested
                                ? "Pending"
                                : "Idle"}
                          </td>
                          <td className="px-4 py-3 font-mono">
                            {camera.videoChunks}
                            {camera.videoDiagnostics && (
                              <div className="mt-1 whitespace-nowrap text-xs text-muted">
                                PPPP headers {camera.videoDiagnostics.headers} ·
                                JPEG at +32{" "}
                                {camera.videoDiagnostics.jpegStartsAt32}
                                <br />
                                Incomplete {
                                  camera.videoDiagnostics.incomplete
                                }{" "}
                                · Invalid {camera.videoDiagnostics.invalidJpeg}{" "}
                                · Frames {camera.videoDiagnostics.frames}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs whitespace-nowrap">
                            <div className="font-medium">
                              {camera.videoFps ?? 0} FPS ·{" "}
                              {new Intl.NumberFormat().format(
                                camera.videoDiagnostics?.bytesReceived ?? 0,
                              )}{" "}
                              bytes
                            </div>
                            <div className="mt-1 text-muted">
                              Complete {camera.videoDiagnostics?.frames ?? 0} ·
                              Preview{" "}
                              {camera.videoDiagnostics?.previewFrames ?? 0}
                              <br />
                              Fragmented{" "}
                              {camera.videoDiagnostics?.fragmentedFrames ?? 0} ·
                              Missing EOI{" "}
                              {camera.videoDiagnostics?.missingEoi ?? 0}
                              <br />
                              Discarded{" "}
                              {camera.videoDiagnostics?.discardedFrames ?? 0} ·
                              HTTP drops {camera.videoDeliveryDrops ?? 0} · Slow
                              viewer drops {camera.slowViewerDrops ?? 0}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-mono">
                            {camera.viewers ?? 0}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted">
                            {camera.lastFrameAt
                              ? new Date(camera.lastFrameAt).toLocaleString()
                              : "No recent frame"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          {page === "settings" && (
            <Config
              connection={connection}
              save={save}
              mode={mode}
              toggleMode={toggleMode}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function App() {
  const [connection, setConnection] = useState<Connection>(() => ({
    endpoint: localStorage.getItem("librecam.endpoint") ?? "",
    token: "",
  }));
  const [queryClient, setQueryClient] = useState(() => new QueryClient());
  const [generation, setGeneration] = useState(0);
  const [mode, setMode] = useState<"dark" | "light">(() =>
    localStorage.getItem("librecam.theme") === "light" ? "light" : "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem("librecam.theme", mode);
  }, [mode]);
  function save(value: Connection) {
    if (
      value.endpoint === connection.endpoint &&
      value.token === connection.token
    )
      return;
    localStorage.setItem("librecam.endpoint", value.endpoint);
    setConnection(value);
    setQueryClient(new QueryClient());
    setGeneration((current) => current + 1);
  }
  return (
    <QueryClientProvider client={queryClient}>
      <Console
        key={generation}
        connection={connection}
        save={save}
        mode={mode}
        toggleMode={() =>
          setMode((value) => (value === "dark" ? "light" : "dark"))
        }
      />
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
