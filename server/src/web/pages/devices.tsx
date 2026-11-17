import type { Child, FC } from "hono/jsx";
import type { PendingCode } from "../../device/enroll.js";
import type { AgentFile } from "../../family/agent.js";
import type { RecoveryState } from "../../family/recovery.js";
import type { Command } from "../../family/commands.js";
import { RESTRICTION_WORDS } from "../../family/android.js";
import { type App, type Change, type Review, PERMISSION_NAMES, SOURCE_NAMES, playStoreUrl, versionText } from "../../family/apps.js";
import { type DeviceView, patchAgeDays } from "../../family/devices.js";
import { type AskAgain, type Decision, LIMITS, type Rules } from "../../family/policy.js";
import type { AppRequestView as RequestView } from "../../family/requests.js";
import { formatAgo, formatDate, formatDuration } from "../../time.js";
import { Csrf, Layout, Notice, PermissionChips, PostButton, Problems, StatusBadge, Time, type View } from "../ui.js";
import {
  HardeningCard,
  MaintenanceCard,
  NewAppsCard,
  PauseCard,
  ProtectionCard,
  RequestAnswer,
  RestrictionsCard,
  RulesStatus,
  SupportCard,
  WebCard,
  decidedByWords,
} from "./rules.js";
import { OtherUsersCard, RecoveryCard, UpdateCard } from "./belay.js";
import { ChangeLine } from "./timeline.js";
import { PhoneTabs } from "./screentime.js";

export interface DeviceSummary {
  device: DeviceView;
  userApps: number;
  unreviewed: number;
  /** The kid's requests waiting for a parent. */
  requests: number;
  protectedOn: boolean;
}

/** One app's rule on the phone, for the app list. */
export interface AppRule {
  state: "allowed" | "blocked" | "waiting" | "runs";
  decision: Decision | null;
  /** False for the apps Belay never blocks (the phone app, texting, Belay...). */
  canBlock: boolean;
  /** Why the phone never blocks it, when it doesn't. */
  neverWhy: string | null;
}

export interface PhoneRules {
  rules: Rules;
  /** User apps on the phone without a decision: what turning protection on allows. */
  undecidedApps: number;
  ruleOf: (app: Pick<App, "package" | "system">) => AppRule;
  /** The kid's requests a parent hasn't settled (waiting, or "let's talk"). */
  openRequests: RequestView[];
  /** Of those, the ones for apps the server doesn't know on the phone yet. */
  requestsForUnknownApps: RequestView[];
  /** Decisions about apps the phone has never reported: blocked (or allowed) before install. */
  beforeInstall: (Decision & { state: "allowed" | "blocked" })[];
  /** When new apps run without asking now, but asked before: what switching back leaves to choose. */
  askAgain: AskAgain | null;
  /** Phase 6: the versions of Belay on the server, newest first, to offer the phone. */
  agentFiles: AgentFile[];
  /** Phase 6: the phone's recovery key, and its last use. */
  recovery: RecoveryState;
  /** Phase 10: the commands sent to the phone, newest first. */
  commands: Command[];
}

/** Apps decided before the phone ever had them: each one clearable, and the AI apps' all at once. */
const BeforeInstall: FC<{ view: View; device: DeviceView; decisions: PhoneRules["beforeInstall"] }> = ({ view, device, decisions }) => {
  const byAi = decisions.filter((d) => d.decidedBy === "ai").length;
  const action = `/devices/${device.id}/before-install/clear`;
  return (
    <>
      <h3 id="before-install">Blocked before install</h3>
      <div class="card">
        <p class="muted small">
          Apps that aren't on the phone, decided ahead of time: if one is installed, the phone {decisions.some((d) => d.state === "allowed") ? "blocks it, or lets it run" : "blocks it"}.
          Each one is part of the rules the phone gets, so Belay keeps at most {LIMITS.maxPreDecisions}, and AI apps may add at most {LIMITS.maxPreBlocksByAi}.
          Clearing one removes its decision.
        </p>
        {byAi > 0 && (
          <p>
            <PostButton view={view} action={action} fields={{ ai: "1" }} kind="quiet" confirm={`Clear the ${byAi} app${byAi === 1 ? "" : "s"} AI apps blocked before install?`}>
              Clear the ones AI apps added ({byAi})
            </PostButton>
          </p>
        )}
        {decisions.map((d) => (
          <div class="row spread">
            <span>
              <span class="pkg">{d.package}</span>
              <br />
              <span class="small muted">
                {d.state} {decidedByWords(d)}, <Time ms={d.decidedAt} tz={view.tz} />
              </span>
              {d.note && <blockquote>{d.note}</blockquote>}
            </span>
            <PostButton view={view} action={action} fields={{ package: d.package }} kind="quiet">
              Clear
            </PostButton>
          </div>
        ))}
      </div>
    </>
  );
};

const RuleChip: FC<{ rule: AppRule }> = ({ rule }) =>
  rule.state === "allowed" ? (
    <span class="chip allowed">Allowed</span>
  ) : rule.state === "blocked" ? (
    <span class="chip blocked">Blocked</span>
  ) : rule.state === "waiting" ? (
    <span class="chip waiting">Waiting for you</span>
  ) : null;

/** Allow or block, for the page's "decide" form (forms can't nest in the review form). */
const DecideButtons: FC<{ app: Pick<App, "package" | "system">; rule: AppRule }> = ({ app, rule }) => (
  <div class="row decide">
    {rule.state === "blocked" ? (
      <button type="submit" form="decide" name="allow" value={app.package} class="quiet">
        Unblock
      </button>
    ) : (
      <>
        {rule.state !== "allowed" && !app.system && (
          <button type="submit" form="decide" name="allow" value={app.package} class="quiet">
            Allow
          </button>
        )}
        {rule.canBlock && (
          <button type="submit" form="decide" name="block" value={app.package} class="quiet">
            Block
          </button>
        )}
      </>
    )}
  </div>
);

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
      {h.other_users != null && (
        <>
          <dt>Other users and profiles</dt>
          <dd>{h.other_users === 0 ? "none" : h.other_users}</dd>
        </>
      )}
      {h.foreign_restrictions && h.foreign_restrictions.length > 0 && (
        <>
          <dt>Restrictions Belay didn't set</dt>
          <dd>
            {h.foreign_restrictions.map((key) => (RESTRICTION_WORDS[key] ? `${RESTRICTION_WORDS[key]} (${key})` : key)).join(", ")}
            <br />
            <span class="small muted">Something else on the phone set these, such as Android's own Parental Controls or another admin app.</span>
          </dd>
        </>
      )}
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

export const DevicesPage: FC<{ view: View; devices: DeviceSummary[]; pending: PendingCode[]; server?: Child; help?: Child }> = ({ view, devices, pending, server, help }) => (
  <Layout view={view} title="Phones">
    <h1>Phones</h1>
    {help}
    {devices.length === 0 && pending.length === 0 && (
      <Notice>
        No phones yet. <a href="/add">Add a phone</a> to start.
      </Notice>
    )}
    <div class="cards">
      {devices.map(({ device, userApps, unreviewed, requests, protectedOn }) => (
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
            {requests > 0 && <span class="chip waiting">{requests === 1 ? "1 request" : `${requests} requests`} waiting</span>}
            <span class="chip">{protectedOn ? "Protected" : "Monitoring only"}</span>
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
    {server}
  </Layout>
);

const unreviewedText = (app: App): string | null => {
  if (!app.unreviewed) return null;
  if (app.unreviewed.kind === "new") return "New: not reviewed yet";
  if (app.unreviewed.kind === "reinstalled") return "Installed again since it was reviewed";
  return `Now has ${app.unreviewed.gained.map((p) => PERMISSION_NAMES[p] ?? p).join(", ")} since it was reviewed`;
};

const AppItem: FC<{ app: App; deviceId: string; view: View; rule: AppRule; request?: RequestView }> = ({ app, deviceId, view, rule, request }) => (
  <div class="app">
    <div>{app.unreviewed && <input type="checkbox" name="package" value={app.package} aria-label={`Select ${app.label}`} />}</div>
    <div>
      <div class="row">
        <a class="name" href={`/devices/${deviceId}/apps/${encodeURIComponent(app.package)}`}>
          {app.label}
        </a>
        <RuleChip rule={rule} />
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
      {request ? <RequestAnswer view={view} request={request} /> : <DecideButtons app={app} rule={rule} />}
    </div>
  </div>
);

/** A request for an app the server doesn't know on the phone yet (its app list hasn't caught up). */
const RequestItem: FC<{ request: RequestView; view: View }> = ({ request, view }) => (
  <div class="app">
    <div></div>
    <div>
      <div class="row">
        <span class="name">{request.label}</span>
        <span class="chip waiting">Waiting for you</span>
      </div>
      <div class="pkg">{request.package}</div>
      <div class="small muted">Not in the phone's app list yet.</div>
      <RequestAnswer view={view} request={request} />
    </div>
  </div>
);

export const DevicePage: FC<{
  view: View;
  device: DeviceView;
  apps: App[];
  phone: PhoneRules;
  filter: { q: string; system: boolean; permission: string };
  /** Phase 7: a help request no parent has seen, above everything. */
  help?: Child;
  message?: string;
  error?: string;
}> = ({ view, device, apps, phone, filter, help, message, error }) => {
  const unreviewed = apps.filter((a) => a.unreviewed).length;
  const requestFor = new Map(phone.openRequests.map((r) => [r.package, r]));
  const tampering = device.problems.filter((p) => p.code === "tampering");
  return (
    <Layout view={view} title={device.name}>
      <div class="row spread">
        <h1>{device.name}</h1>
        <StatusBadge status={device.status} />
      </div>
      <PhoneTabs view={view} device={device} current="apps" />
      {help}
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {tampering.length > 0 && (
        <Notice kind="error">
          <p>
            <strong>Someone may be getting around Belay on this phone.</strong> Android's own Parental Controls, in Settings, can add a hidden
            profile and lift Belay's suspensions, and Belay can't stop the phone's Settings opening. Have a look at the phone's Settings together.
          </p>
          <p class="small">Belay on the phone says:</p>
          <ul class="problems">
            {tampering.map((p) => (
              <li>{p.fromPhone}</li>
            ))}
          </ul>
        </Notice>
      )}
      <OtherUsersCard view={view} device={device} commands={phone.commands} />
      <Problems problems={device.problems.filter((p) => p.code !== "tampering" && p.code !== "other_users")} />

      <h2 id="rules">Rules</h2>
      <RulesStatus view={view} device={device} />
      <ProtectionCard view={view} device={device} rules={phone.rules} undecidedApps={phone.undecidedApps} askAgain={phone.askAgain} />
      <h3 id="pause">Pause</h3>
      <PauseCard view={view} device={device} rules={phone.rules} />
      <h3 id="new-apps">New apps</h3>
      <NewAppsCard view={view} device={device} rules={phone.rules} />

      <h2 id="apps">Apps</h2>
      <p class="muted small">
        Waiting apps first. A blocked app is hidden and suspended, but stays installed, so it stays in this list. Belay never blocks the phone app,
        texting, Settings or itself, so 911 and 988 always work.
      </p>
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
      {/* The app list sits in the review form, so its allow, block and answer buttons submit these forms instead. */}
      <form id="decide" method="post" action={`/devices/${device.id}/decide`}>
        <Csrf view={view} />
      </form>
      {phone.openRequests.map((r) => (
        <form id={`answer-${r.id}`} method="post" action={`/devices/${device.id}/requests/${r.id}/answer`}>
          <Csrf view={view} />
        </form>
      ))}
      <form method="post" action={`/devices/${device.id}/review`}>
        <Csrf view={view} />
        <div class="card applist">
          {phone.requestsForUnknownApps.map((r) => (
            <RequestItem request={r} view={view} />
          ))}
          {apps.length === 0 && <p class="muted">No apps match.</p>}
          {apps.map((app) => (
            <AppItem app={app} deviceId={device.id} view={view} rule={phone.ruleOf(app)} request={requestFor.get(app.package)} />
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
            <p class="muted small">Marking an app reviewed only records that you looked at it. It doesn't allow or block anything.</p>
          </div>
        )}
      </form>
      {phone.beforeInstall.length > 0 && <BeforeInstall view={view} device={device} decisions={phone.beforeInstall} />}

      <h2 id="web">Web</h2>
      <WebCard view={view} device={device} rules={phone.rules} />

      <h2 id="locks">Settings the kid can't change</h2>
      <RestrictionsCard view={view} device={device} rules={phone.rules} />
      <h3 id="support">Message on blocked-app screens</h3>
      <SupportCard view={view} device={device} rules={phone.rules} />

      <h2 id="maintenance">Maintenance mode</h2>
      <MaintenanceCard view={view} device={device} rules={phone.rules} />

      <h2 id="hardening">Hardening</h2>
      <HardeningCard view={view} device={device} rules={phone.rules} />
      <RecoveryCard view={view} device={device} rules={phone.rules} recovery={phone.recovery} />

      <h2 id="update">Updating Belay</h2>
      <UpdateCard view={view} device={device} files={phone.agentFiles} />

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

const STATE_WORDS: Record<AppRule["state"], string> = {
  allowed: "Allowed",
  blocked: "Blocked: hidden and suspended on the phone, and still installed",
  waiting: "Waiting for your approval: suspended on the phone",
  runs: "Runs: there's no decision, and new apps run without asking",
};

const ANSWER_WORDS: Record<RequestView["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
  talk: "Let's talk",
  superseded: "Asked again",
  withdrawn: "Withdrawn by the kid",
};

/** The app's rule, its history, and the kid's requests for it. */
const AppRuleCard: FC<{ view: View; device: DeviceView; app: App; rule: AppRule; history: Decision[]; requests: RequestView[] }> = ({
  view,
  device,
  app,
  rule,
  history,
  requests,
}) => {
  const open = requests.find((r) => r.status === "pending" || r.status === "talk");
  return (
    <>
      <h2>Rule</h2>
      <div class="card">
        <p>
          <strong>{app.system && rule.state === "runs" ? "Runs: it's a system app" : STATE_WORDS[rule.state]}</strong>
          {rule.decision && (
            <span class="small muted">
              {" "}
              {decidedByWords(rule.decision)}, <Time ms={rule.decision.decidedAt} tz={view.tz} />
            </span>
          )}
        </p>
        {rule.decision?.note && <blockquote>{rule.decision.note}</blockquote>}
        {rule.neverWhy !== null && <p class="muted small">{rule.neverWhy}</p>}
        {open && (
          <>
            <form id={`answer-${open.id}`} method="post" action={`/devices/${device.id}/requests/${open.id}/answer`}>
              <Csrf view={view} />
              <input type="hidden" name="back" value="app" />
            </form>
            <RequestAnswer view={view} request={open} />
          </>
        )}
        {!open && (
          <form class="stack" method="post" action={`/devices/${device.id}/decide`}>
            <Csrf view={view} />
            <input type="hidden" name="back" value="app" />
            <label for="decide-note">Note (optional): why</label>
            <textarea id="decide-note" name="note" maxlength={LIMITS.decisionNote}></textarea>
            <div class="row">
              {rule.state !== "allowed" && (
                <button type="submit" name="allow" value={app.package}>
                  {rule.state === "blocked" ? "Unblock" : "Allow"}
                </button>
              )}
              {rule.state !== "blocked" && rule.canBlock && (
                <button type="submit" name="block" value={app.package} class="quiet">
                  Block
                </button>
              )}
            </div>
          </form>
        )}
        {history.length > 1 && (
          <>
            <h3>Earlier</h3>
            <ul>
              {history.slice(1).map((d) => (
                <li>
                  <Time ms={d.decidedAt} tz={view.tz} />: {d.state === "undecided" ? "decision cleared" : d.state} {decidedByWords(d)}
                  {d.note && <blockquote>{d.note}</blockquote>}
                </li>
              ))}
            </ul>
          </>
        )}
        {requests.filter((r) => r !== open).length > 0 && (
          <>
            <h3>The kid's requests for it</h3>
            <ul>
              {requests
                .filter((r) => r !== open)
                .map((r) => (
                  <li>
                    <Time ms={Math.min(r.askedAt, r.receivedAt)} tz={view.tz} />: {ANSWER_WORDS[r.status]}
                    {r.answeredBy && ` by ${r.answeredBy}`}
                    {r.reason && (
                      <>
                        <span class="small muted"> In their words:</span>
                        <blockquote class="kid">{r.reason}</blockquote>
                      </>
                    )}
                    {r.note && (
                      <>
                        <span class="small muted"> Your answer:</span>
                        <blockquote>{r.note}</blockquote>
                      </>
                    )}
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
};

export const AppPage: FC<{
  view: View;
  device: DeviceView;
  app: App;
  reviews: Review[];
  changes: Change[];
  rule: AppRule;
  history: Decision[];
  requests: RequestView[];
  message?: string;
}> = ({ view, device, app, reviews, changes, rule, history, requests, message }) => (
  <Layout view={view} title={app.label}>
    <p class="small">
      <a href={`/devices/${device.id}`}>← {device.name}</a>
    </p>
    <h1>{app.label}</h1>
    <p class="pkg">{app.package}</p>
    {message && <Notice>{message}</Notice>}
    {!app.present && <Notice kind="warn">This app isn't on the phone any more.</Notice>}
    {app.unreviewed && <Notice>{unreviewedText(app)}</Notice>}
    <AppRuleCard view={view} device={device} app={app} rule={rule} history={history} requests={requests} />
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
