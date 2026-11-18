/**
 * Phase 12 on the parent page: Caregivers (docs/design/phase12-caregivers.md). A parent adds
 * someone who looks after the kid for a while, chooses their phones, what they may see and do,
 * and when it ends (at most 30 days away), and changes, renews or ends it; the one-time link shows
 * once. Every choice says what it shows, and that the kid's phone lists them.
 */
import type { FC } from "hono/jsx";
import { CAN_WORDS, CAREGIVER_CAN, type Caregiver, DEFAULT_CAN, NAME_MAX, accessCurrent } from "../../family/caregivers/store.js";
import type { DeviceView } from "../../family/devices.js";
import { formatAgo, isoInZone } from "../../time.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";

/** A time for a datetime-local field, in the family's zone: "2026-11-21T18:00". */
export const localInput = (ms: number, tz: string): string => isoInZone(ms, tz).slice(0, 16);

const What: FC<{ caregiver: Caregiver }> = ({ caregiver }) => (
  <>{CAREGIVER_CAN.filter((k) => caregiver.can[k]).map((k) => CAN_WORDS[k].title).join(" · ") || "Nothing"}</>
);

const State: FC<{ view: View; caregiver: Caregiver }> = ({ view, caregiver: c }) =>
  accessCurrent(c, view.now) ? (
    <span class="chip">
      Until <Time ms={c.endsAt} tz={view.tz} />
    </span>
  ) : (
    <span class="chip waiting">
      Ended <Time ms={c.endedAt ?? c.endsAt} tz={view.tz} />
    </span>
  );

/** The phones, what they may do: the add form's and the change form's fields. */
const ChoiceFields: FC<{ phones: DeviceView[]; caregiver?: Caregiver; prefix: string }> = ({ phones, caregiver, prefix }) => (
  <>
    <label for={`${prefix}-name`}>Their name, as your kid will see it</label>
    <input id={`${prefix}-name`} type="text" name="name" maxlength={NAME_MAX} required value={caregiver?.name ?? ""} placeholder="Grandma" />
    <fieldset>
      <legend>
        <strong>Which phones</strong>
      </legend>
      {phones.map((p) => (
        <label class="check">
          <input type="checkbox" name="phone" value={p.id} checked={caregiver ? caregiver.phones.includes(p.id) : phones.length === 1} /> {p.name}
          {p.revokedAt !== null && " (disconnected)"}
        </label>
      ))}
    </fieldset>
    <fieldset>
      <legend>
        <strong>What they may see and do</strong>
      </legend>
      {CAREGIVER_CAN.map((k) => (
        <label class="check">
          <input type="checkbox" name="can" value={k} checked={caregiver ? caregiver.can[k] : DEFAULT_CAN[k]} /> <strong>{CAN_WORDS[k].title}.</strong>{" "}
          {CAN_WORDS[k].detail}
        </label>
      ))}
      <p class="muted small">
        Never the apps, screen time, calls, websites, where the phone has been or your places, the activity log or settings, and nothing that loosens a
        rule: no resuming early, no more time, no apps. Never other caregivers either.
      </p>
    </fieldset>
  </>
);

const UntilField: FC<{ view: View; id: string; value: number; label: string }> = ({ view, id, value, label }) => (
  <>
    <label for={id}>{label}</label>
    <input id={id} type="datetime-local" name="until" required value={localInput(value, view.tz)} min={localInput(view.now, view.tz)} max={localInput(view.now + 30 * 86_400_000, view.tz)} />
    <p class="muted small">In {view.tz}. At most 30 days from now; you can renew it before then. Their access stops at that moment by itself.</p>
  </>
);

export const CaregiversPage: FC<{ view: View; caregivers: Caregiver[]; phones: DeviceView[]; suggestedEnd: number; message?: string; error?: string }> = ({
  view,
  caregivers,
  phones,
  suggestedEnd,
  message,
  error,
}) => {
  const current = caregivers.filter((c) => accessCurrent(c, view.now));
  const ended = caregivers.filter((c) => !accessCurrent(c, view.now));
  const names = new Map(phones.map((p) => [p.id, p.name]));
  const Card: FC<{ c: Caregiver }> = ({ c }) => (
    <div class="card">
      <div class="row spread">
        <strong>{c.name}</strong>
        <State view={view} caregiver={c} />
      </div>
      <p class="small">
        {c.phones.map((id) => names.get(id) ?? "a phone").join(", ") || "No phone"} · <What caregiver={c} />
      </p>
      <p class="small muted">
        {c.joined ? (
          <>Joined; last signed in {c.lastSignedInAt ? formatAgo(c.lastSignedInAt, view.now) : "never"}.</>
        ) : (
          "Hasn't used their link yet."
        )}
      </p>
      <p>
        <a class="go" href={`/caregivers/${c.id}`}>
          {accessCurrent(c, view.now) ? "Change, renew or end" : "Give access again, or remove"}
        </a>
      </p>
    </div>
  );
  return (
    <Layout view={view} title="Caregivers">
      <h1>Caregivers</h1>
      <p>
        Someone looking after your kid for a while (a grandparent for a weekend, a babysitter, a coach on a trip, the other household) can have their own
        sign-in, to see and do only what you choose here, on the phones you choose, until a time you choose. Nothing they can do loosens a rule. Your kid's
        phone lists each one, with what they can see and do and until when.
      </p>
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <h2>With access now</h2>
      {current.length === 0 ? <p class="muted">No one.</p> : <div class="cards">{current.map((c) => <Card c={c} />)}</div>}
      {ended.length > 0 && (
        <>
          <h2>Access ended</h2>
          <div class="cards">
            {ended.map((c) => (
              <Card c={c} />
            ))}
          </div>
        </>
      )}
      <h2 id="add">Add a caregiver</h2>
      {phones.length === 0 ? (
        <p class="muted">Add a phone first.</p>
      ) : (
        <form class="stack card" method="post" action="/caregivers">
          <Csrf view={view} />
          <ChoiceFields phones={phones} prefix="add" />
          <UntilField view={view} id="add-until" value={suggestedEnd} label="Their access ends" />
          <button type="submit">Add, and make their link</button>
          <p class="muted small">
            Belay shows you a link to send them, once. With it they choose a username and a password, as a parent does. It works once, for 7 days at most.
          </p>
        </form>
      )}
    </Layout>
  );
};

export const CaregiverPage: FC<{ view: View; caregiver: Caregiver; phones: DeviceView[]; suggestedEnd: number; message?: string; error?: string }> = ({
  view,
  caregiver: c,
  phones,
  suggestedEnd,
  message,
  error,
}) => {
  const current = accessCurrent(c, view.now);
  return (
    <Layout view={view} title={c.name}>
      <h1>{c.name}</h1>
      <p>
        <State view={view} caregiver={c} /> {c.createdBy && <span class="small muted">Added by {c.createdBy}.</span>}{" "}
        {c.endedBy && <span class="small muted">Ended by {c.endedBy}.</span>}
      </p>
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <h2>{current ? "Renew" : "Give access again"}</h2>
      <form class="stack card" method="post" action={`/caregivers/${c.id}/renew`}>
        <Csrf view={view} />
        <UntilField view={view} id="renew-until" value={current ? Math.max(c.endsAt, suggestedEnd) : suggestedEnd} label={current ? "Their access ends instead" : "Their access ends"} />
        <button type="submit">{current ? "Renew" : "Give access again"}</button>
        {!current && <p class="muted small">From now: the help requests from before don't show to them.</p>}
      </form>
      <h2>Change</h2>
      <form class="stack card" method="post" action={`/caregivers/${c.id}`}>
        <Csrf view={view} />
        <ChoiceFields phones={phones} caregiver={c} prefix="change" />
        <button type="submit">Save</button>
      </form>
      {current && (
        <>
          <h2>Sign-in link</h2>
          <div class="card">
            <p>
              {c.joined
                ? "Forgot their password? A new link lets them choose another, and signs them out everywhere else."
                : "Lost the link? A new one stops the old one."}
            </p>
            <PostButton view={view} action={`/caregivers/${c.id}/link`} kind="quiet">
              Make a new link
            </PostButton>
          </div>
          <h2>End access</h2>
          <div class="card">
            <p>They're signed out at once, their notifications stop, and your kid's phone stops listing them. A pause they set stays until its end; you can resume it.</p>
            <PostButton view={view} action={`/caregivers/${c.id}/end`} kind="danger" confirm={`End ${c.name}'s access now?`}>
              End access now
            </PostButton>
          </div>
        </>
      )}
      {!current && (
        <>
          <h2>Remove</h2>
          <div class="card">
            <p>Deletes their account. The activity log keeps what they did, under their name.</p>
            <PostButton view={view} action={`/caregivers/${c.id}/remove`} kind="danger" confirm={`Remove ${c.name}?`}>
              Remove
            </PostButton>
          </div>
        </>
      )}
      <p>
        <a class="go" href="/caregivers">
          Back to Caregivers
        </a>
      </p>
    </Layout>
  );
};

/** The one-time link, shown once. */
export const CaregiverLinkPage: FC<{ view: View; caregiver: Caregiver; link: string; expiresAt: number }> = ({ view, caregiver, link, expiresAt }) => (
  <Layout view={view} title={`A link for ${caregiver.name}`}>
    <h1>A link for {caregiver.name}</h1>
    <Notice kind="warn">This is shown only once. Copy it now.</Notice>
    <p>
      Send it to {caregiver.name} in a message only they read. Whoever opens it first becomes {caregiver.name} here, so don't open it yourself. It works
      once, until <Time ms={expiresAt} tz={view.tz} />.
    </p>
    <pre id="secret">{link}</pre>
    <p>
      <button type="button" class="quiet" data-copy="secret" hidden>
        Copy
      </button>
    </p>
    <p class="muted">
      They sign in at {new URL(link).origin}/care afterwards. Belay keeps only a hash of the link.
    </p>
    <p>
      <a class="go" href="/caregivers">
        Back to Caregivers
      </a>
    </p>
  </Layout>
);
