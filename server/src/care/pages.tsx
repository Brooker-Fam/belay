/**
 * Phase 12: a caregiver's own pages (docs/design/phase12-caregivers.md), apart from the parent
 * pages: their own plain layout, with no parent menu, and only what a parent let them see. Hono
 * JSX escapes every string: a phone's name, the caregiver's and the kid's words are shown as text.
 */
import type { FC, PropsWithChildren } from "hono/jsx";
import { PASSWORD_MIN } from "../auth/parents.js";
import { CAN_WORDS, CAREGIVER_CAN, type Caregiver } from "../family/caregivers/store.js";
import { CARE_PAUSE_MINUTES } from "../family/caregivers/changes.js";
import type { FixView } from "../family/location/store.js";
import type { HelpView } from "../family/requests.js";
import { formatAgo, formatDateTime, offsetLabel } from "../time.js";
import { FixLine, type Where } from "../web/pages/help.js";
import { Csrf, Notice, Time, type View } from "../web/ui.js";

/** What every caregiver page knows: a View (the parent pages' components take it), and who's signed in. */
export interface CareView extends View {
  /** Null on the sign-in and join pages. */
  caregiverName: string | null;
  /** When their access ends, for every page's footer. */
  endsAt: number | null;
}

const duration = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`);

export const CareLayout: FC<PropsWithChildren<{ view: CareView; title: string }>> = ({ view, title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light dark" />
      <meta name="robots" content="noindex" />
      <meta name="theme-color" content="#1f6f5c" />
      <meta name="apple-mobile-web-app-title" content="Belay" />
      <title>{`${title} · Belay`}</title>
      {/* Opens the caregiver page from a Home Screen (where iOS lets a web page get notifications). */}
      <link rel="manifest" href="/care.webmanifest" />
      <link rel="icon" href={view.assets.icon} type="image/svg+xml" />
      <link rel="stylesheet" href={view.assets.css} />
      <script src={view.assets.js} defer></script>
    </head>
    <body>
      {view.caregiverName !== null && (
        <header class="top">
          <div class="bar">
            <a class="brand" href="/care">
              Belay
            </a>
            <form method="post" action="/care/logout">
              <Csrf view={view} />
              <button class="link" type="submit">
                Sign out {view.caregiverName}
              </button>
            </form>
          </div>
        </header>
      )}
      <main id="main" class="narrow">
        {children}
      </main>
      <footer>
        {view.endsAt !== null && <>Your access ends {formatDateTime(view.endsAt, view.tz)}. </>}
        Times are in {view.tz} ({offsetLabel(view.now, view.tz)}). A parent chose what you can see and do here.
      </footer>
    </body>
  </html>
);

const PasswordFields: FC = () => (
  <>
    <label for="password">Password</label>
    <input id="password" type="password" name="password" autocomplete="new-password" minlength={PASSWORD_MIN} maxlength={256} required />
    <p class="muted small">At least {PASSWORD_MIN} characters. A few unrelated words together works well.</p>
    <label for="repeat">The same password again</label>
    <input id="repeat" type="password" name="repeat" autocomplete="new-password" required />
  </>
);

export const CareLoginPage: FC<{ view: CareView; error?: string; username?: string; next?: string }> = ({ view, error, username, next }) => (
  <CareLayout view={view} title="Caregiver sign-in">
    <h1>Sign in to look after a phone</h1>
    <p>For a caregiver a parent added in Belay. A parent's own sign-in is <a href="/login">here</a>.</p>
    {error && <Notice kind="error">{error}</Notice>}
    <form class="stack" method="post" action="/care/login">
      <input type="hidden" name="next" value={next ?? "/care"} />
      <label for="username">Username</label>
      <input id="username" type="text" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck={false} required value={username} />
      <label for="password">Password</label>
      <input id="password" type="password" name="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
    <p class="muted small">Forgot your password? Ask the parent for a new link.</p>
  </CareLayout>
);

/** What a caregiver may see and do, as a list, for the join page and their own. */
export const CanList: FC<{ caregiver: Caregiver }> = ({ caregiver }) => (
  <ul>
    {CAREGIVER_CAN.filter((k) => caregiver.can[k]).map((k) => (
      <li>
        <strong>{CAN_WORDS[k].title}</strong>: {CAN_WORDS[k].detail}
      </li>
    ))}
  </ul>
);

export const CareJoinPage: FC<{ view: CareView; token: string; caregiver: Caregiver; phones: string[]; error?: string; username?: string }> = ({
  view,
  token,
  caregiver,
  phones,
  error,
  username,
}) => (
  <CareLayout view={view} title="Join as a caregiver">
    <h1>Hello, {caregiver.name}</h1>
    <p>
      {caregiver.createdBy ?? "A parent"} gave you some access to {phones.join(", ") || "a phone"} in their family's Belay, until{" "}
      <Time ms={caregiver.endsAt} tz={view.tz} />. You'll be able to:
    </p>
    <CanList caregiver={caregiver} />
    <p class="muted small">
      Nothing more: not the apps, screen time, calls, websites or where the phone has been, and nothing that gives the kid more. The kid's phone shows
      your name, what you can see and do, and until when.
    </p>
    {error && <Notice kind="error">{error}</Notice>}
    <form class="stack" method="post" action={`/care/join/${token}`}>
      <label for="username">{caregiver.joined ? "Your username" : "Choose a username, for signing in"}</label>
      <input
        id="username"
        type="text"
        name="username"
        autocomplete="username"
        autocapitalize="none"
        autocorrect="off"
        spellcheck={false}
        maxlength={64}
        required
        value={username ?? caregiver.username ?? ""}
      />
      <PasswordFields />
      <button type="submit">{caregiver.joined ? "Set my new password" : "Join"}</button>
    </form>
  </CareLayout>
);

export const CareMessagePage: FC<{ view: CareView; title: string; message: string; link?: { href: string; label: string } }> = ({ view, title, message, link }) => (
  <CareLayout view={view} title={title}>
    <h1>{title}</h1>
    <p>{message}</p>
    {link && (
      <p>
        <a class="go" href={link.href}>
          {link.label}
        </a>
      </p>
    )}
  </CareLayout>
);

/** One phone, as a caregiver's choices let them see it. Each part is there only when a parent chose it. */
export interface CarePhone {
  id: string;
  name: string;
  disconnected: boolean;
  /** `status`: what the server knows of it now. */
  status: {
    online: boolean;
    lastSeenAt: number | null;
    battery: number | null;
    charging: boolean | null;
    /** The pause in force, if any; `yours` when this caregiver set it. */
    pause: { until: number | null; yours: boolean } | null;
    /** The schedule the phone last said is on, while it is: its name (the family's words). */
    schedule: { name: string; until: number; reportedAt: number | null } | null;
  } | null;
  /** `pause`. */
  canPause: boolean;
  /** `locate`: and whether the phone's location takes checks now. */
  locate: { on: boolean } | null;
}

const Status: FC<{ view: CareView; status: NonNullable<CarePhone["status"]> }> = ({ view, status }) => (
  <dl>
    <dt>Online</dt>
    <dd>{status.online ? "Yes, now" : status.lastSeenAt ? `Not now: last heard from ${formatAgo(status.lastSeenAt, view.now)}` : "Not heard from yet"}</dd>
    <dt>Battery</dt>
    <dd>{status.battery === null ? "Not known" : `${status.battery}%${status.charging === true ? ", charging" : ""}`}</dd>
    <dt>Paused</dt>
    <dd>
      {status.pause === null ? (
        "No"
      ) : status.pause.until === null ? (
        "Yes, until a parent resumes it"
      ) : (
        <>
          Yes, until <Time ms={status.pause.until} tz={view.tz} />
          {status.pause.yours ? " (you paused it)" : ""}
        </>
      )}
    </dd>
    <dt>Schedule now</dt>
    <dd>
      {status.schedule === null ? (
        "None"
      ) : (
        <>
          {status.schedule.name}, until <Time ms={status.schedule.until} tz={view.tz} />
          {status.schedule.reportedAt !== null && <span class="muted small"> (as the phone said {formatAgo(status.schedule.reportedAt, view.now)})</span>}
        </>
      )}
    </dd>
  </dl>
);

const PauseForm: FC<{ view: CareView; phone: CarePhone }> = ({ view, phone }) => (
  <form class="stack" method="post" action={`/care/phones/${phone.id}/pause`}>
    <Csrf view={view} />
    <label for={`minutes-${phone.id}`}>Pause {phone.name} for</label>
    <select id={`minutes-${phone.id}`} name="minutes">
      {CARE_PAUSE_MINUTES.map((m) => (
        <option value={String(m)} selected={m === 30}>
          {duration(m)}
        </option>
      ))}
    </select>
    <div class="row">
      <button type="submit" name="lock" value="0">
        Pause
      </button>
      <button type="submit" name="lock" value="1" class="quiet">
        Pause and lock the screen now
      </button>
    </div>
    <p class="muted small">
      Apps pause; calls, texts, 911 and 988 still work. The phone shows your name. A pause only ever gets longer here, and only a parent can end one early.
    </p>
  </form>
);

const LocateForm: FC<{ view: CareView; phone: CarePhone; on: boolean }> = ({ view, phone, on }) =>
  on ? (
    <form class="stack" method="post" action={`/care/phones/${phone.id}/locate`}>
      <Csrf view={view} />
      <button type="submit" class="quiet">
        Check where {phone.name} is now
      </button>
      <p class="muted small">It asks the phone for where it is and waits up to a minute. The kid gets a notification that you checked.</p>
    </form>
  ) : (
    <p class="muted small">Location is off for {phone.name}, so you can't check where it is. A parent can turn it on.</p>
  );

/** A help request, as a caregiver sees it: what the kid said, where the phone was if they shared it, and Call. Never "I've seen it": that's a parent's. */
const CareHelpCard: FC<{ view: CareView; request: HelpView; kidNumber: string | null; where: Where }> = ({ view, request: r, kidNumber, where }) => (
  <div class="card help" id={`help-${r.id}`}>
    <div class="row spread">
      <strong class="title">{r.deviceName} needs help</strong>
      <span class="chip blocked">{r.seenAt !== null ? "A parent saw it" : r.status === "withdrawn" ? "Withdrawn" : "No parent has seen it yet"}</span>
    </div>
    <p class="small">
      Sent <Time ms={Math.min(r.askedAt, r.receivedAt)} tz={view.tz} /> ({formatAgo(Math.min(r.askedAt, r.receivedAt), view.now)})
      {r.withdrawnAt !== null && <> · the kid withdrew it</>}
    </p>
    {r.reason ? (
      <>
        <p class="small muted">In their words:</p>
        <blockquote class="kid">{r.reason}</blockquote>
      </>
    ) : (
      <p class="small muted">They didn't write anything.</p>
    )}
    {r.fix ? (
      <p class="small">
        Where the phone was, shared by the kid: <FixLine view={view} deviceId={r.deviceId} fix={r.fix} where={where} />
      </p>
    ) : (
      <p class="small muted">They didn't share where the phone is.</p>
    )}
    {kidNumber && (
      <p>
        <a class="button call" href={`tel:${kidNumber}`}>
          Call {kidNumber}
        </a>
      </p>
    )}
    <p class="muted small">If they're in danger, call 911. Belay doesn't call anyone for you.</p>
  </div>
);

const Notifications: FC<{ view: CareView; publicKey: string; browsers: number }> = ({ view, publicKey, browsers }) => (
  <section class="card" id="notifications">
    <h2>Notifications</h2>
    <p>
      Belay can tell you on this phone or computer at once when the kid presses "I need help". Each notice is end-to-end encrypted to your browser.
      {browsers > 0 && ` You have them on in ${browsers} browser${browsers === 1 ? "" : "s"}.`}
    </p>
    <p class="muted small" data-push-unsupported hidden>
      This browser can't get notifications from Belay. On an iPhone or iPad, add this page to your Home Screen first (Share, then Add to Home
      Screen), open it from there, and turn notifications on.
    </p>
    <noscript>
      <p class="muted small">Turning notifications on needs JavaScript.</p>
    </noscript>
    <div class="row">
      <form method="post" action="/care/push/subscribe" id="push-on" data-vapid-key={publicKey} class="inline">
        <Csrf view={view} />
        <input type="hidden" name="endpoint" value="" />
        <input type="hidden" name="p256dh" value="" />
        <input type="hidden" name="auth" value="" />
        <button type="button" hidden>
          Turn on notifications on this browser
        </button>
      </form>
      <form method="post" action="/care/push/unsubscribe" id="push-off" class="inline">
        <Csrf view={view} />
        <input type="hidden" name="endpoint" value="" />
        <button type="button" class="quiet" hidden>
          Turn off on this browser
        </button>
      </form>
      {browsers > 0 && (
        <form method="post" action="/care/push/test" class="inline">
          <Csrf view={view} />
          <button type="submit" class="quiet">
            Send a test notice
          </button>
        </form>
      )}
    </div>
    <p class="small" data-push-status role="status"></p>
  </section>
);

export const CareHomePage: FC<{
  view: CareView;
  caregiver: Caregiver;
  phones: CarePhone[];
  help: { requests: HelpView[]; kidNumber: (deviceId: string) => string | null; where: Where } | null;
  push: { publicKey: string; browsers: number } | null;
  message?: string;
  error?: string;
}> = ({ view, caregiver, phones, help, push, message, error }) => (
  <CareLayout view={view} title="Looking after">
    <h1>Hello, {caregiver.name}</h1>
    {message && <Notice>{message}</Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    {help && help.requests.some((r) => r.seenAt === null && r.status !== "withdrawn") && (
      <div class="help-banner" role="alert">
        <strong>The kid asked for help.</strong> <a href="#help">See what they said</a>.
      </div>
    )}
    <p>
      Until <Time ms={caregiver.endsAt} tz={view.tz} />, {caregiver.createdBy ?? "a parent"} in this family lets you:
    </p>
    <CanList caregiver={caregiver} />
    {phones.length === 0 && <p class="muted">No phone yet: a parent chooses which phones you look after.</p>}
    {phones.map((phone) => (
      <section class="card" id={`phone-${phone.id}`}>
        <h2>{phone.name}</h2>
        {phone.disconnected ? (
          <p class="muted">This phone is disconnected from Belay, so there's nothing to see or do here.</p>
        ) : (
          <>
            {phone.status && <Status view={view} status={phone.status} />}
            {phone.canPause && <PauseForm view={view} phone={phone} />}
            {phone.locate && <LocateForm view={view} phone={phone} on={phone.locate.on} />}
          </>
        )}
      </section>
    ))}
    {help && (
      <section id="help">
        <h2>"I need help"</h2>
        {help.requests.length === 0 ? (
          <p class="muted">No help requests since your access began. When the kid presses "I need help", it shows here, and as a notification if you turn them on.</p>
        ) : (
          help.requests.map((r) => <CareHelpCard view={view} request={r} kidNumber={help.kidNumber(r.deviceId)} where={help.where} />)
        )}
      </section>
    )}
    {push && <Notifications view={view} publicKey={push.publicKey} browsers={push.browsers} />}
  </CareLayout>
);

/** The answer to a caregiver's check: this one fix, or why there's none. */
export const CareCheckPage: FC<{ view: CareView; phone: { id: string; name: string }; fix: FixView | null; where: Where; expired: boolean }> = ({
  view,
  phone,
  fix,
  where,
  expired,
}) => (
  <CareLayout view={view} title={`Where ${phone.name} is`}>
    <h1>Where {phone.name} is</h1>
    {expired ? (
      <p>That check was a while ago. Check again to see where the phone is now.</p>
    ) : fix ? (
      <p>
        <FixLine view={view} deviceId={phone.id} fix={fix} where={where} />
      </p>
    ) : (
      <p>The phone hasn't answered in a minute. It may be offline, or out of reach of GPS. Try again in a few minutes.</p>
    )}
    <p class="muted small">The kid got a notification that you checked.</p>
    <p>
      <a class="go" href={`/care#phone-${phone.id}`}>
        Back
      </a>
    </p>
  </CareLayout>
);

