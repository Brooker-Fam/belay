/** Shared pieces of the parent pages (Hono JSX: every string is escaped). */
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { DeviceStatus, Problem } from "../family/devices.js";
import { PERMISSION_NAMES } from "../family/apps.js";
import { formatDateTime, isoInZone, offsetLabel } from "../time.js";

/** What every page needs to know about the request. */
export interface View {
  /** Null on the sign-in, setup and invite pages. */
  parentName: string | null;
  csrf: string;
  tz: string;
  now: number;
  path: string;
  assets: { css: string; js: string; icon: string };
  /** What waits for a parent, for the menu: the kid's requests and AI apps' proposals. */
  waiting?: { requests: number; proposals: number };
}

const NAV = [
  ["/", "Phones", null],
  ["/requests", "Requests", "requests"],
  ["/proposals", "Proposals", "proposals"],
  ["/timeline", "Timeline", null],
  ["/add", "Add a phone", null],
  ["/settings", "Settings", null],
  ["/activity", "Activity", null],
] as const;

function current(path: string, href: string): boolean {
  return href === "/" ? path === "/" || path.startsWith("/devices") : path.startsWith(href);
}

export const Layout: FC<PropsWithChildren<{ view: View; title: string; narrow?: boolean }>> = ({ view, title, narrow, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <meta name="theme-color" content="#1f6f5c" />
      <meta name="apple-mobile-web-app-title" content="Belay" />
      <title>{`${title} · Belay`}</title>
      <link rel="manifest" href="/manifest.webmanifest" />
      <link rel="icon" href={view.assets.icon} type="image/svg+xml" />
      <link rel="stylesheet" href={view.assets.css} />
      <script src={view.assets.js} defer></script>
    </head>
    <body>
      {view.parentName !== null && (
        <header class="top">
          <div class="bar">
            <a class="brand" href="/">
              Belay
            </a>
            <nav aria-label="Main">
              {NAV.map(([href, label, count]) => {
                const n = count ? (view.waiting?.[count] ?? 0) : 0;
                return (
                  <a href={href} aria-current={current(view.path, href) ? "page" : undefined}>
                    {label}
                    {n > 0 && (
                      <span class="badge" aria-label={`${n} waiting`}>
                        {n}
                      </span>
                    )}
                  </a>
                );
              })}
            </nav>
            <form method="post" action="/logout">
              <Csrf view={view} />
              <button class="link" type="submit">
                Sign out {view.parentName}
              </button>
            </form>
          </div>
        </header>
      )}
      <main class={narrow ? "narrow" : undefined}>{children}</main>
      <footer>
        Times are in {view.tz} ({offsetLabel(view.now, view.tz)}). Belay keeps this family's data on this server only.
      </footer>
    </body>
  </html>
);

export const Csrf: FC<{ view: View }> = ({ view }) => <input type="hidden" name="_csrf" value={view.csrf} />;

export const Time: FC<{ ms: number; tz: string; children?: Child }> = ({ ms, tz, children }) => (
  <time datetime={isoInZone(ms, tz)} title={isoInZone(ms, tz)}>
    {children ?? formatDateTime(ms, tz)}
  </time>
);

const STATUS_WORDS: Record<DeviceStatus | "waiting", string> = {
  ok: "OK",
  attention: "Needs attention",
  silent: "Silent",
  disconnected: "Disconnected",
  waiting: "Waiting to enroll",
};

export const StatusBadge: FC<{ status: DeviceStatus | "waiting" }> = ({ status }) => <span class={`status ${status}`}>{STATUS_WORDS[status]}</span>;

export const Problems: FC<{ problems: Problem[] }> = ({ problems }) =>
  problems.length ? (
    <ul class="problems">
      {problems.map((p) => (
        <li class={p.code === "tampering" || p.code === "signing_changed" || p.code === "other_users" ? "tamper" : undefined}>{p.text}</li>
      ))}
    </ul>
  ) : null;

export const Notice: FC<PropsWithChildren<{ kind?: "error" | "warn" }>> = ({ kind, children }) => (
  <div class={kind ? `notice ${kind}` : "notice"} role={kind === "error" ? "alert" : "status"}>
    {children}
  </div>
);

export const PermissionChips: FC<{ permissions: string[]; highlight?: string[] }> = ({ permissions, highlight = [] }) => (
  <>
    {permissions.map((p) => (
      <span class={highlight.includes(p) ? "chip warn" : "chip"}>{PERMISSION_NAMES[p] ?? p}</span>
    ))}
  </>
);

/** A POST button with the CSRF token, optionally asking first. */
export const PostButton: FC<PropsWithChildren<{ view: View; action: string; confirm?: string; kind?: "quiet" | "danger"; fields?: Record<string, string> }>> = ({
  view,
  action,
  confirm,
  kind,
  fields = {},
  children,
}) => (
  <form method="post" action={action} data-confirm={confirm} class="inline">
    <Csrf view={view} />
    {Object.entries(fields).map(([name, value]) => (
      <input type="hidden" name={name} value={value} />
    ))}
    <button type="submit" class={kind}>
      {children}
    </button>
  </form>
);
