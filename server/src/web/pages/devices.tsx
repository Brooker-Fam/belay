import type { FC } from "hono/jsx";
import type { PendingCode } from "../../device/enroll.js";
import { type App, type Change, type Review, PERMISSION_NAMES, SOURCE_NAMES, playStoreUrl, versionText } from "../../family/apps.js";
import { type DeviceView, patchAgeDays } from "../../family/devices.js";
import { formatAgo, formatDate, formatDuration } from "../../time.js";
import { Csrf, Layout, Notice, PermissionChips, PostButton, Problems, StatusBadge, Time, type View } from "../ui.js";
import { ChangeLine } from "./timeline.js";

export interface DeviceSummary {
  device: DeviceView;
  userApps: number;
  unreviewed: number;
}

const Facts: FC<{ device: DeviceView; view: View }> = ({ device, view }) => {
  const f = device.facts;
  if (!f) return <p class="muted">No facts from the phone yet.</p>;
  const age = patchAgeDays(f, view.now);
  const storage =
    f.storage_free_bytes != null && f.storage_total_bytes != null
      ? `${(f.storage_free_bytes / 1e9).toFixed(1)} GB free of ${(f.storage_total_bytes / 1e9).toFixed(0)} GB`
      : "unknown";
  const h = f.health;
  return (
    <dl class="facts">
      <dt>Phone</dt>
      <dd>
        {f.manufacturer} {f.model}
      </dd>
      <dt>Android</dt>
      <dd>
        {f.android_release} (SDK {f.sdk_full}), security patch {f.security_patch}
        {age !== null && ` (${age} days old)`}
      </dd>
      <dt>Battery</dt>
      <dd>{f.battery_percent != null ? `${f.battery_percent}%${f.charging ? ", charging" : ""}` : "unknown"}</dd>
      <dt>Storage</dt>
      <dd>{storage}</dd>
      <dt>Last restart</dt>
      <dd>
        <Time ms={f.last_boot_at} tz={view.tz} />
      </dd>
      <dt>Belay on the phone</dt>
      <dd>
        version {f.agent_version_name}
        {h.test_only && " (debug build)"}; device owner: {h.device_owner ? "yes" : "no"}; can't be uninstalled:{" "}
        {h.uninstall_blocked == null ? "unknown" : h.uninstall_blocked ? "yes" : "no"}; battery exemption: {h.battery_exempt ? "yes" : "no"}; usage
        access: {h.usage_access ? "yes" : "no"}
      </dd>
      <dt>Last heard from</dt>
      <dd>{device.lastSeenAt ? formatAgo(device.lastSeenAt, view.now) : "never"}</dd>
      <dt>Last app list</dt>
      <dd>{device.lastInventoryAt ? formatAgo(device.lastInventoryAt, view.now) : "not yet"}</dd>
      <dt>Enrolled</dt>
      <dd>
        <Time ms={device.enrolledAt} tz={view.tz} />
      </dd>
    </dl>
  );
};

export const DevicesPage: FC<{ view: View; devices: DeviceSummary[]; pending: PendingCode[] }> = ({ view, devices, pending }) => (
  <Layout view={view} title="Phones">
    <h1>Phones</h1>
    {devices.length === 0 && pending.length === 0 && (
      <Notice>
        No phones yet. <a href="/add">Add a phone</a> to start.
      </Notice>
    )}
    <div class="cards">
      {devices.map(({ device, userApps, unreviewed }) => (
        <a class="card" href={`/devices/${device.id}`}>
          <div class="row spread">
            <strong>{device.name}</strong>
            <StatusBadge status={device.status} />
          </div>
          {device.facts && (
            <p class="muted small">
              {device.facts.model}, Android {device.facts.android_release}
            </p>
          )}
          <p class="small">
            {userApps} apps {unreviewed > 0 && <span class="chip new">{unreviewed} to review</span>}
          </p>
          <p class="small muted">Last heard from {device.lastSeenAt ? formatAgo(device.lastSeenAt, view.now) : "never"}</p>
          <Problems problems={device.problems.filter((p) => p.code !== "disconnected")} />
        </a>
      ))}
      {pending.map((code) => (
        <div class="card">
          <div class="row spread">
            <strong>{code.deviceName}</strong>
            <StatusBadge status="waiting" />
          </div>
          <p class="small muted">The enrollment code expires in {formatDuration(code.expiresAt - view.now)}.</p>
        </div>
      ))}
    </div>
  </Layout>
);

const unreviewedText = (app: App): string | null => {
  if (!app.unreviewed) return null;
  if (app.unreviewed.kind === "new") return "New: not reviewed yet";
  if (app.unreviewed.kind === "reinstalled") return "Installed again since it was reviewed";
  return `Now has ${app.unreviewed.gained.map((p) => PERMISSION_NAMES[p] ?? p).join(", ")} since it was reviewed`;
};

const AppItem: FC<{ app: App; deviceId: string; view: View }> = ({ app, deviceId, view }) => (
  <div class="app">
    <div>{app.unreviewed && <input type="checkbox" name="package" value={app.package} aria-label={`Select ${app.label}`} />}</div>
    <div>
      <div class="row">
        <a class="name" href={`/devices/${deviceId}/apps/${encodeURIComponent(app.package)}`}>
          {app.label}
        </a>
        {app.unreviewed && <span class="chip new">new</span>}
        {app.system && <span class="chip">system</span>}
        {!app.enabled && <span class="chip">turned off</span>}
      </div>
      <div class="pkg">{app.package}</div>
      <div class="small">
        {versionText(app.versionName, app.versionCode)} · from {SOURCE_NAMES[app.source] ?? app.source}
        {app.firstInstallTime !== null && (
          <>
            {" "}
            · installed <Time ms={app.firstInstallTime} tz={view.tz}>{formatDate(app.firstInstallTime, view.tz)}</Time>
          </>
        )}
      </div>
      {unreviewedText(app) && <div class="small">{unreviewedText(app)}</div>}
      <div>
        <PermissionChips permissions={app.permissions} highlight={app.unreviewed?.kind === "permissions" ? app.unreviewed.gained : []} />
        {!app.detailsKnown && <span class="small muted">Details arrive with the phone's next app list.</span>}
      </div>
    </div>
  </div>
);

export const DevicePage: FC<{
  view: View;
  device: DeviceView;
  apps: App[];
  filter: { q: string; system: boolean; permission: string };
  message?: string;
}> = ({ view, device, apps, filter, message }) => {
  const unreviewed = apps.filter((a) => a.unreviewed).length;
  return (
    <Layout view={view} title={device.name}>
      <div class="row spread">
        <h1>{device.name}</h1>
        <StatusBadge status={device.status} />
      </div>
      {message && <Notice>{message}</Notice>}
      <Problems problems={device.problems} />

      <h2>Apps</h2>
      <form class="filters" method="get" action={`/devices/${device.id}`}>
        <label class="sr-only" for="q">
          Search apps
        </label>
        <input id="q" type="search" name="q" value={filter.q} placeholder="Search apps" />
        <select name="permission" aria-label="Only apps with this permission">
          <option value="">Any permission</option>
          {Object.entries(PERMISSION_NAMES).map(([value, label]) => (
            <option value={value} selected={filter.permission === value}>
              {label}
            </option>
          ))}
        </select>
        <label class="check">
          <input type="checkbox" name="system" value="1" checked={filter.system} /> System apps
        </label>
        <button type="submit" class="quiet">
          Show
        </button>
      </form>
      <form method="post" action={`/devices/${device.id}/review`}>
        <Csrf view={view} />
        <div class="card applist">
          {apps.length === 0 && <p class="muted">No apps match.</p>}
          {apps.map((app) => (
            <AppItem app={app} deviceId={device.id} view={view} />
          ))}
        </div>
        {unreviewed > 0 && (
          <div class="card">
            <label class="check">
              <input type="checkbox" data-select-all="package" /> Select all {unreviewed} new
            </label>
            <label for="note">Note (optional): what you decided and why</label>
            <textarea id="note" name="note" maxlength={2000}></textarea>
            <p>
              <button type="submit">Mark selected reviewed</button>
            </p>
            <p class="muted small">Marking an app reviewed only records that you looked at it. It doesn't change anything on the phone.</p>
          </div>
        )}
      </form>

      <h2>This phone</h2>
      <div class="card">
        <Facts device={device} view={view} />
      </div>

      <h2>Manage</h2>
      <div class="card">
        <form class="row" method="post" action={`/devices/${device.id}/rename`}>
          <Csrf view={view} />
          <label for="name">Name</label>
          <input id="name" type="text" name="name" value={device.name} maxlength={60} required />
          <button type="submit" class="quiet">
            Rename
          </button>
        </form>
      </div>
      <div class="card">
        <p>
          <strong>Reconnect</strong>: after a factory reset, or if the phone says it's disconnected. Makes a new enrollment code for this phone and
          keeps its history.
        </p>
        <PostButton view={view} action={`/devices/${device.id}/reconnect`} kind="quiet">
          Make a reconnect code
        </PostButton>
      </div>
      <div class="card danger-zone">
        {device.revokedAt === null ? (
          <>
            <p>
              <strong>Disconnect</strong>: the phone's access stops at once. Belay stays on the phone until it's reset. Its history stays here.
            </p>
            <PostButton view={view} action={`/devices/${device.id}/disconnect`} kind="danger" confirm={`Disconnect ${device.name}?`}>
              Disconnect this phone
            </PostButton>
          </>
        ) : (
          <>
            <p>
              <strong>Delete</strong> everything recorded about this phone: its apps, changes and reviews.
            </p>
            <PostButton view={view} action={`/devices/${device.id}/delete`} kind="danger" confirm={`Delete ${device.name} and its history? This can't be undone.`}>
              Delete this phone
            </PostButton>
          </>
        )}
      </div>
    </Layout>
  );
};

const ReviewLine: FC<{ review: Review; view: View }> = ({ review, view }) => (
  <li>
    <Time ms={review.reviewedAt} tz={view.tz} /> by {review.parentName ?? "a former parent account"}
    {review.via === "web" ? " on the web" : ` via ${review.via}`}
    {review.note && <blockquote>{review.note}</blockquote>}
  </li>
);

export const AppPage: FC<{ view: View; device: DeviceView; app: App; reviews: Review[]; changes: Change[] }> = ({ view, device, app, reviews, changes }) => (
  <Layout view={view} title={app.label}>
    <p class="small">
      <a href={`/devices/${device.id}`}>← {device.name}</a>
    </p>
    <h1>{app.label}</h1>
    <p class="pkg">{app.package}</p>
    {!app.present && <Notice kind="warn">This app isn't on the phone any more.</Notice>}
    {app.unreviewed && <Notice>{unreviewedText(app)}</Notice>}
    <div class="card">
      <dl class="facts">
        <dt>Version</dt>
        <dd>{versionText(app.versionName, app.versionCode)}</dd>
        <dt>Came from</dt>
        <dd>{SOURCE_NAMES[app.source] ?? app.source}</dd>
        <dt>Permissions</dt>
        <dd>{app.permissions.length ? <PermissionChips permissions={app.permissions} /> : "none of the sensitive ones"}</dd>
        {app.firstInstallTime !== null && (
          <>
            <dt>Installed</dt>
            <dd>
              <Time ms={app.firstInstallTime} tz={view.tz} />
            </dd>
          </>
        )}
        {app.lastUpdateTime !== null && app.lastUpdateTime !== app.firstInstallTime && (
          <>
            <dt>Updated</dt>
            <dd>
              <Time ms={app.lastUpdateTime} tz={view.tz} />
            </dd>
          </>
        )}
        <dt>Store page</dt>
        <dd>
          <a href={playStoreUrl(app.package)} rel="noreferrer noopener" target="_blank">
            Google Play
          </a>{" "}
          <span class="muted small">(if it's listed there)</span>
        </dd>
      </dl>
      <p class="muted small">The app's name and version come from its developer.</p>
    </div>

    <h2>Reviews</h2>
    {reviews.length ? (
      <ul>
        {reviews.map((r) => (
          <ReviewLine review={r} view={view} />
        ))}
      </ul>
    ) : (
      <p class="muted">Not reviewed yet.</p>
    )}
    {app.present && (
      <form class="stack card" method="post" action={`/devices/${device.id}/review`}>
        <Csrf view={view} />
        <input type="hidden" name="package" value={app.package} />
        <input type="hidden" name="back" value="app" />
        <label for="note">Note (optional): what you decided and why</label>
        <textarea id="note" name="note" maxlength={2000}></textarea>
        <div>
          <button type="submit">Mark reviewed</button>
        </div>
      </form>
    )}

    <h2>Changes</h2>
    {changes.length ? changes.map((c) => <ChangeLine change={c} view={view} showDevice={false} />) : <p class="muted">None recorded since Belay started watching.</p>}
  </Layout>
);
