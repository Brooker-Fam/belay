import type { Child, FC } from "hono/jsx";
import type { Parent } from "../../auth/parents.js";
import type { Grant } from "../../oauth/store.js";
import type { PushSubscription } from "../../push.js";
import { ACTIVITY_DAYS, AI_SCOPES, CALL_DAYS, LOCATION_DAYS, MAP_SITES, MAX_PARENT_NUMBERS, OFF_BY_DEFAULT, type Settings, USAGE_MONTHS } from "../../settings.js";
import { formatAgo, timeZones } from "../../time.js";
import { ChangePasswordForm } from "./auth.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";

/** Web Push on this browser: the buttons only show once app.js finds the browser can do it. */
const Notifications: FC<{ view: View; publicKey: string; browsers: PushSubscription[] }> = ({ view, publicKey, browsers }) => (
  <div class="card">
    <p>
      Belay can tell you on your phone or computer when a phone has a request waiting, or an AI app proposes a change. Each notice is end-to-end
      encrypted to your browser: its push service (Apple, Google, Mozilla or Microsoft) carries it but can't read it.
    </p>
    <p class="muted small" data-push-unsupported hidden>
      This browser can't get notifications from Belay. On an iPhone or iPad, add Belay to your Home Screen first (Share, then Add to Home Screen),
      open it from there, and turn notifications on in its Settings.
    </p>
    <noscript>
      <p class="muted small">Turning notifications on needs JavaScript.</p>
    </noscript>
    <div class="row">
      <form method="post" action="/settings/push/subscribe" id="push-on" data-vapid-key={publicKey} class="inline">
        <Csrf view={view} />
        <input type="hidden" name="endpoint" value="" />
        <input type="hidden" name="p256dh" value="" />
        <input type="hidden" name="auth" value="" />
        <button type="button" hidden>
          Turn on notifications on this browser
        </button>
      </form>
      <form method="post" action="/settings/push/unsubscribe" id="push-off" class="inline">
        <Csrf view={view} />
        <input type="hidden" name="endpoint" value="" />
        <button type="button" class="quiet" hidden>
          Turn off on this browser
        </button>
      </form>
    </div>
    <p class="small" data-push-status role="status"></p>
    <h3>Your browsers</h3>
    {browsers.length === 0 && <p class="muted">None yet.</p>}
    {browsers.map((b) => (
      <div class="row spread">
        <span>
          <strong>{b.name}</strong>
          <br />
          <span class="small muted">
            turned on <Time ms={b.createdAt} tz={view.tz} />; last notice {b.lastSentAt ? formatAgo(b.lastSentAt, view.now) : "never"}
          </span>
        </span>
        <PostButton view={view} action={`/settings/push/${b.id}/remove`} kind="danger" confirm={`Stop notices to ${b.name}?`}>
          Remove
        </PostButton>
      </div>
    ))}
    {browsers.length > 0 && (
      <p>
        <PostButton view={view} action="/settings/push/test" kind="quiet">
          Send a test notice
        </PostButton>
      </p>
    )}
  </div>
);

export const SettingsPage: FC<{
  view: View;
  settings: Settings;
  parents: Parent[];
  meId: string;
  grants: Grant[];
  mcpUrl: string;
  push: { publicKey: string; browsers: PushSubscription[] };
  /** The daily summary's form (web/pages/server.tsx). */
  digest?: Child;
  message?: string;
  error?: string;
}> = ({ view, settings, parents, meId, grants, mcpUrl, push, digest, message, error }) => {
  const apps = grants.filter((g) => g.kind === "oauth");
  const tokens = grants.filter((g) => g.kind === "pat");
  return (
    <Layout view={view} title="Settings">
      <h1>Settings</h1>
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      <h2>Family</h2>
      <form class="stack card" method="post" action="/settings">
        <Csrf view={view} />
        <label for="timezone">Timezone</label>
        <input id="timezone" type="text" name="timezone" list="zones" required value={settings.timezone} />
        <datalist id="zones">
          {timeZones().map((tz) => (
            <option value={tz} />
          ))}
        </datalist>
        <label for="silent">Report a phone as silent after this many hours without contact</label>
        <input id="silent" type="number" name="silent_hours" min={1} max={168} required value={String(settings.silentHours)} />
        <label for="usage-months">Keep screen time for this many months, then delete it (with the extra time given that long ago)</label>
        <input id="usage-months" type="number" name="usage_months" min={USAGE_MONTHS.min} max={USAGE_MONTHS.max} required value={String(settings.usageMonths)} />
        <fieldset>
          <legend>
            <strong>How long Belay keeps where the phone was, in days</strong>
          </legend>
          <div class="row">
            <label for="days-periodic">Shared on a schedule</label>
            <input id="days-periodic" type="number" name="days_periodic" min={LOCATION_DAYS.periodic.min} max={LOCATION_DAYS.periodic.max} required value={String(settings.locationDays.periodic)} />
            <label for="days-checks">Your checks</label>
            <input id="days-checks" type="number" name="days_checks" min={LOCATION_DAYS.checks.min} max={LOCATION_DAYS.checks.max} required value={String(settings.locationDays.checks)} />
          </div>
          <div class="row">
            <label for="days-events">Arrivals and departures</label>
            <input
              id="days-events"
              type="number"
              name="days_placeEvents"
              min={LOCATION_DAYS.placeEvents.min}
              max={LOCATION_DAYS.placeEvents.max}
              required
              value={String(settings.locationDays.placeEvents)}
            />
            <label for="days-lost">Lost mode, after it ends</label>
            <input id="days-lost" type="number" name="days_lostAfter" min={LOCATION_DAYS.lostAfter.min} max={LOCATION_DAYS.lostAfter.max} required value={String(settings.locationDays.lostAfter)} />
          </div>
          <p class="muted small">Where the phone was when the kid asked for help is kept with their request. The hourly clean-up deletes the rest.</p>
          <label for="map-site">"Open in a map" goes to</label>
          <select id="map-site" name="map_site">
            {Object.entries(MAP_SITES).map(([key, name]) => (
              <option value={key} selected={settings.mapSite === key}>
                {name}
              </option>
            ))}
          </select>
          <p class="muted small">Only your browser follows that link, when you click it. Belay's server never asks a map site anything, and shows no map.</p>
        </fieldset>
        <label for="call-days">Keep the record of calls for this many days, then delete it (only for phones that record calls)</label>
        <input id="call-days" type="number" name="call_days" min={CALL_DAYS.min} max={CALL_DAYS.max} required value={String(settings.callDays)} />
        <label for="activity-days">Keep the activity log for this many days, then delete older entries ({ACTIVITY_DAYS.min} at least)</label>
        <input id="activity-days" type="number" name="activity_days" min={ACTIVITY_DAYS.min} max={ACTIVITY_DAYS.max} required value={String(settings.activityDays)} />
        <fieldset>
          <legend>
            <strong>What AI apps may read</strong>
          </legend>
          <p class="muted small">Connected AI apps (like Claude) send what they read to their provider. Turn off what they shouldn't see. The kid's phone shows which ones are on.</p>
          {settings.newAiScopes.length > 0 && (
            <p class="small">
              <span class="chip new">new</span> marks what Belay added since you last saved these.{" "}
              {settings.newAiScopes.some((s) => settings.aiScopes[s])
                ? "It's on, like the others you left on: save to keep it, or untick it."
                : settings.newAiScopes.every((s) => OFF_BY_DEFAULT.includes(s))
                  ? "It starts off for every family: tick it to let AI apps read it."
                  : "Because you turned something off before, it starts off: tick it to let AI apps read it."}
            </p>
          )}
          {Object.entries(AI_SCOPES).map(([key, label]) => (
            <label class="check">
              <input type="checkbox" name="ai_scope" value={key} checked={settings.aiScopes[key as keyof typeof AI_SCOPES]} /> {label}
              {OFF_BY_DEFAULT.includes(key as keyof typeof AI_SCOPES) && <span class="small muted"> (off until you turn it on)</span>}
              {settings.newAiScopes.includes(key as keyof typeof AI_SCOPES) && <span class="chip new">new</span>}
            </label>
          ))}
        </fieldset>
        <div>
          <button type="submit">Save</button>
        </div>
      </form>

      <h2 id="numbers">The emergency card</h2>
      <form class="stack card numbers" method="post" action="/settings/parent-numbers">
        <Csrf view={view} />
        <p class="small">
          The kid's emergency card, on Belay's screen even while the phone is paused, always has 911 and 988, call or text. It also lists these
          numbers, on every phone that doesn't have its own (a phone's Location and help tab can give it its own), and the contacts marked parent on a
          phone's Calls tab.
        </p>
        {Array.from({ length: MAX_PARENT_NUMBERS }, (_, i) => settings.parentNumbers[i] ?? { name: "", number: "" }).map((p, i) => (
          <div class="row">
            <input type="text" name="name" maxlength={40} value={p.name} placeholder={i === 0 ? "Mom" : "Name"} aria-label={`Name ${i + 1}`} />
            <input type="text" name="number" value={p.number} placeholder="+15555550100" inputmode="tel" aria-label={`Number ${i + 1}`} />
          </div>
        ))}
        <p class="muted small">In international form: + and the country code, like +15555550100.</p>
        <div>
          <button type="submit">Save numbers</button>
        </div>
      </form>

      <h2 id="notifications">Notifications</h2>
      <Notifications view={view} publicKey={push.publicKey} browsers={push.browsers} />
      {digest}

      <h2>AI access</h2>
      <div class="card">
        <p>
          Connect Claude or another MCP client to <code>{mcpUrl}</code>. It can read what you allow above, mark apps reviewed, block an app, pause
          or lock a phone, and tighten its screen time. Anything that loosens a rule is only a proposal until a parent approves it on the Proposals
          page, and only a parent answers the kid's requests or turns measuring screen time on or off.
        </p>
        <h3>Connected apps</h3>
        {apps.length === 0 && <p class="muted">None.</p>}
        {apps.map((g) => (
          <div class="row spread">
            <span>
              <strong>{g.clientName}</strong> {g.clientHost && <span class="muted small">({g.clientHost})</span>}
              <br />
              <span class="small muted">
                connected by {g.parentName} <Time ms={g.createdAt} tz={view.tz} />; last used {g.lastUsedAt ? formatAgo(g.lastUsedAt, view.now) : "never"}
              </span>
            </span>
            <PostButton view={view} action={`/settings/ai/${g.id}/revoke`} kind="danger" confirm={`Disconnect ${g.clientName}?`}>
              Disconnect
            </PostButton>
          </div>
        ))}
        <h3>Personal access tokens</h3>
        <p class="muted small">For Claude Code and other clients that send a header. Each one works until you revoke it.</p>
        {tokens.map((g) => (
          <div class="row spread">
            <span>
              <strong>{g.clientName}</strong>
              <br />
              <span class="small muted">
                made by {g.parentName} <Time ms={g.createdAt} tz={view.tz} />; last used {g.lastUsedAt ? formatAgo(g.lastUsedAt, view.now) : "never"}
              </span>
            </span>
            <PostButton view={view} action={`/settings/ai/${g.id}/revoke`} kind="danger" confirm={`Revoke ${g.clientName}?`}>
              Revoke
            </PostButton>
          </div>
        ))}
        <form class="row" method="post" action="/settings/tokens">
          <Csrf view={view} />
          <label for="token-name" class="sr-only">
            Token name
          </label>
          <input id="token-name" type="text" name="name" maxlength={60} required placeholder="Claude Code on my laptop" />
          <button type="submit" class="quiet">
            Make a token
          </button>
        </form>
      </div>

      <h2>Parents</h2>
      <div class="card">
        {parents.map((p) => (
          <div class="row spread">
            <span>
              {p.name} <span class="muted small">({p.username})</span>
              {p.id === meId && <span class="chip">you</span>}
            </span>
            {p.id !== meId && (
              <PostButton view={view} action={`/settings/parents/${p.id}/remove`} kind="danger" confirm={`Remove ${p.name}? Their sign-ins and AI connections end.`}>
                Remove
              </PostButton>
            )}
          </div>
        ))}
        <p>
          <PostButton view={view} action="/settings/invite" kind="quiet">
            Invite another parent
          </PostButton>
        </p>
      </div>

      <h2>Your account</h2>
      <div class="card">
        <ChangePasswordForm view={view} />
      </div>
      <div class="card">
        <p>Signed in somewhere you shouldn't be? This signs you out on every browser, including this one.</p>
        <PostButton view={view} action="/settings/sign-out-everywhere" kind="danger" confirm="Sign out on every browser?">
          Sign out everywhere
        </PostButton>
      </div>
    </Layout>
  );
};

/** For a secret shown once: an invite link or a personal access token. */
export const ShownOncePage: FC<{ view: View; title: string; intro: string; secret: string; after?: string; command?: string }> = ({
  view,
  title,
  intro,
  secret,
  after,
  command,
}) => (
  <Layout view={view} title={title}>
    <h1>{title}</h1>
    <Notice kind="warn">This is shown only once. Copy it now.</Notice>
    <p>{intro}</p>
    <pre id="secret">{secret}</pre>
    <p>
      <button type="button" class="quiet" data-copy="secret" hidden>
        Copy
      </button>
    </p>
    {command && (
      <>
        <p>For Claude Code:</p>
        <pre>{command}</pre>
      </>
    )}
    {after && <p class="muted">{after}</p>}
    <p>
      <a href="/settings">Back to Settings</a>
    </p>
  </Layout>
);
