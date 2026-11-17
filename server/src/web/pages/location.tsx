/**
 * Phase 4 and 7 on the parent pages: a phone's Location and help tab. Whether and how the phone
 * shares where it is (each mode, and what each provider means), the last fix in words by the
 * family's places, "Check now", the list of checks (the same list the kid sees on the phone), the
 * arrivals and departures, the Places editor, lost mode, and the numbers for "Call" and the
 * emergency card. No map is embedded and no address is searched: both would need a third-party
 * service. "Open in a map" is a plain link only the parent's browser follows.
 */
import type { FC } from "hono/jsx";
import type { Enforcement } from "../../device/schemas.js";
import type { DeviceView } from "../../family/devices.js";
import type { PhoneHelp } from "../../family/kidside.js";
import type { Check, PlaceEventView } from "../../family/location/fixes.js";
import { LOCATION_LIMITS, LOST_MESSAGE, type FixView, type LocationSettings, type Place } from "../../family/location/store.js";
import type { HelpView } from "../../family/requests.js";
import { MAX_PARENT_NUMBERS, type ParentNumber } from "../../settings.js";
import { Csrf, Layout, Notice, OnThisPage, PostButton, Time, type View } from "../ui.js";
import { FixLine, HelpCard, type Where } from "./help.js";
import { PhoneTabs } from "./screentime.js";

export interface LocationPageData {
  device: DeviceView;
  settings: LocationSettings | null;
  places: Place[];
  /** The newest fix the server keeps, of any kind. */
  latest: FixView | null;
  checks: Check[];
  events: PlaceEventView[];
  /** What Belay on the phone says about location (enforcement.location). */
  report: Enforcement["location"] | null;
  help: PhoneHelp;
  familyNumbers: ParentNumber[];
  unseenHelp: HelpView[];
  where: Where;
  /** After "Check now": the check, and the fix that answered it, if one did in time. */
  checked: { command: string; fix: FixView | null } | null;
}

const EVERY = [15, 20, 30, 45, 60, 90, 120];

/** Who checked: a parent, their AI app (by the name it registered with), or the server's command line. */
function checker(c: Check["command"]): string {
  if (c.via) return `${c.via}, through ${c.issuedBy ?? "a parent"}'s connection`;
  return c.issuedBy ?? "the server's command line";
}

const CHECK_WORDS: Record<Check["command"]["state"], string> = {
  waiting: "waiting for the phone",
  done: "the phone answered",
  failed: "the phone couldn't find where it is",
  expired: "the phone got it too late, so it didn't check",
  not_done: "the phone didn't answer in time",
  replaced: "a newer check took its place",
};

const ModeLine: FC<{ settings: LocationSettings | null }> = ({ settings: s }) => {
  if (!s || s.mode === "off") return <p>Location is off: Belay doesn't share where this phone is, and has no location permission on it.</p>;
  if (s.mode === "on_demand") return <p>On demand: Belay shares where the phone is only when you check, and the kid gets a notice each time.</p>;
  return (
    <p>
      Every {s.everyMinutes} minutes{s.hours ? `, from ${s.hours.start} to ${s.hours.end} in the phone's time` : ", all day"}, with arrivals and departures for
      the places below. Checks work too.
    </p>
  );
};

/** What Belay on the phone says about location, its own words untrusted and quoted. */
const PhoneReport: FC<{ view: View; settings: LocationSettings | null; report: Enforcement["location"] | null }> = ({ view, settings, report }) => {
  const using = settings !== null && (settings.mode !== "off" || settings.lost !== null);
  if (!report) return using ? <p class="small muted">The phone hasn't said yet whether it can share where it is: it does with its next check-in.</p> : null;
  return (
    <>
      <p class="small">
        On the phone: Belay {report.permission ? "has" : "doesn't have"} location permission; location is {report.location_on ? "on" : "off"}
        {report.last_fix_at != null && (
          <>
            ; its last fix was <Time ms={report.last_fix_at} tz={view.tz} />
          </>
        )}
        .
      </p>
      {using && !report.location_on && !settings.keepOn && (
        <Notice kind="warn">The kid turned location off on the phone, so Belay can't share where it is. Keeping location on (below) stops that.</Notice>
      )}
      {report.problem && (
        <>
          <p class="small muted">Belay on the phone says:</p>
          <blockquote>{report.problem}</blockquote>
        </>
      )}
    </>
  );
};

const SharingForm: FC<{ view: View; device: DeviceView; settings: LocationSettings | null }> = ({ view, device, settings }) => {
  const s = settings;
  const mode = s?.mode ?? "off";
  return (
    <form class="stack card" method="post" action={`/devices/${device.id}/location`} id="sharing">
      <Csrf view={view} />
      <fieldset>
        <legend>
          <strong>Share where the phone is</strong>
        </legend>
        <label class="check">
          <input type="radio" name="mode" value="off" checked={mode === "off"} /> Off: never (the default)
        </label>
        <label class="check">
          <input type="radio" name="mode" value="on_demand" checked={mode === "on_demand"} /> On demand: only when you check
        </label>
        <label class="check">
          <input type="radio" name="mode" value="periodic" checked={mode === "periodic"} /> Periodic: on a schedule, with arrivals and departures
        </label>
      </fieldset>
      <div class="row">
        <label for="every">Periodic: every</label>
        <select id="every" name="every">
          {EVERY.map((m) => (
            <option value={String(m)} selected={(s?.everyMinutes ?? LOCATION_LIMITS.defaultEvery) === m}>
              {m} minutes
            </option>
          ))}
        </select>
        <label for="hours-start">from</label>
        <input id="hours-start" type="time" name="hours_start" value={s?.hours?.start ?? ""} />
        <label for="hours-end">to</label>
        <input id="hours-end" type="time" name="hours_end" value={s?.hours?.end ?? ""} />
      </div>
      <p class="muted small">Leave the hours empty for all day. They're in the phone's own time; an end before the start ends the next day.</p>
      <fieldset>
        <legend>
          <strong>How the phone finds where it is</strong>
        </legend>
        <label class="check">
          <input type="radio" name="provider" value="gps" checked={(s?.provider ?? "gps") === "gps"} /> GPS only: the phone's own satellite receiver.
          Private: nobody else handles the request. Slower indoors, and uses more battery for each fix.
        </label>
        <label class="check">
          <input type="radio" name="provider" value="fused" checked={s?.provider === "fused"} /> Android's combined provider ("fused"): faster, and works
          indoors, but on a Pixel it's Google's location service that answers, under Google's own location settings.
        </label>
        <label class="check">
          <input type="checkbox" name="fallback_fused" value="1" checked={s?.fallbackFused === true} /> When GPS finds nothing in a minute, try the
          combined provider
        </label>
      </fieldset>
      <label class="check">
        <input type="checkbox" name="keep_on" value="1" checked={s?.keepOn === true} /> Keep location on: the kid can't turn it off in Settings
      </label>
      <p class="muted small">
        The kid always sees what's shared, how often, and every check, on Belay's screen; Android shows "Your organization allows Belay to access your
        location". Only a parent changes any of this: AI apps can't, and can't propose it.
      </p>
      <div>
        <button type="submit">Save</button>
      </div>
    </form>
  );
};

const PlaceForm: FC<{ view: View; device: DeviceView; place?: Place; canUseFix: boolean }> = ({ view, device, place, canUseFix }) => {
  const key = place?.id ?? "new";
  return (
    <form class="stack" method="post" action={`/devices/${device.id}/location/places`}>
      <Csrf view={view} />
      {place && <input type="hidden" name="id" value={place.id} />}
      <div class="row">
        <label for={`name-${key}`}>Name</label>
        <input id={`name-${key}`} type="text" name="name" maxlength={LOCATION_LIMITS.placeName} required value={place?.name ?? ""} placeholder="School" />
        <label for={`radius-${key}`}>Radius (m)</label>
        <input
          id={`radius-${key}`}
          type="number"
          name="radius"
          min={LOCATION_LIMITS.minRadius}
          max={LOCATION_LIMITS.maxRadius}
          step={10}
          required
          value={String(place?.radiusM ?? 150)}
        />
      </div>
      <label for={`center-${key}`}>Center: latitude, longitude (paste them from a map)</label>
      <input
        id={`center-${key}`}
        type="text"
        name="center"
        value={place ? `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}` : ""}
        placeholder="40.10000, -73.20000"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
      />
      {canUseFix && (
        <label class="check">
          <input type="checkbox" name="use_fix" value="1" /> Use where the phone is now (its last fix) instead
        </label>
      )}
      <div class="row">
        <label class="check">
          <input type="checkbox" name="notify" value="arrive" checked={place?.notify.includes("arrive") ?? false} /> Tell me when the phone arrives
        </label>
        <label class="check">
          <input type="checkbox" name="notify" value="leave" checked={place?.notify.includes("leave") ?? false} /> and when it leaves
        </label>
      </div>
      <div>
        <button type="submit" class={place ? "quiet" : undefined}>
          {place ? "Save" : "Add the place"}
        </button>
      </div>
    </form>
  );
};

const NumbersCard: FC<{ view: View; device: DeviceView; help: PhoneHelp; familyNumbers: ParentNumber[] }> = ({ view, device, help, familyNumbers }) => {
  const own = help.ownParentNumbers;
  const shown = own ?? familyNumbers;
  const rows = Array.from({ length: MAX_PARENT_NUMBERS }, (_, i) => shown[i] ?? { name: "", number: "" });
  return (
    <div class="card numbers" id="numbers">
      <form class="row" method="post" action={`/devices/${device.id}/numbers/kid`}>
        <Csrf view={view} />
        <label for="kid-number">The kid's own number, for "Call" when they need help</label>
        <input id="kid-number" type="text" name="number" value={help.kidNumber ?? ""} placeholder="+15555550123" inputmode="tel" />
        <button type="submit" class="quiet">
          Save
        </button>
      </form>
      <p class="muted small">It stays on this server, for the Call button: the phone never gets it, and AI apps never see it.</p>
      <h3>The emergency card</h3>
      <p class="small">
        The kid's emergency card always has 911 and 988, call or text, and Android's own emergency information. It also lists these numbers.{" "}
        {own === null ? "This phone uses the family's numbers, from Settings." : "This phone has its own."}
      </p>
      <form class="stack" method="post" action={`/devices/${device.id}/numbers/parents`}>
        <Csrf view={view} />
        {rows.map((p, i) => (
          <div class="row">
            <input type="text" name="name" maxlength={40} value={p.name} placeholder={i === 0 ? "Mom" : "Name"} aria-label={`Name ${i + 1}`} />
            <input type="text" name="number" value={p.number} placeholder="+15555550100" inputmode="tel" aria-label={`Number ${i + 1}`} />
          </div>
        ))}
        <p class="muted small">Up to {MAX_PARENT_NUMBERS}, in international form: + and the country code, like +15555550100.</p>
        <div class="row">
          <button type="submit">Save for this phone</button>
          {own !== null && (
            <button type="submit" name="family" value="1" class="quiet">
              Use the family's numbers instead
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export const LocationPage: FC<{ view: View; data: LocationPageData; message?: string; error?: string }> = ({ view, data, message, error }) => {
  const { device, settings: s, where } = data;
  const connected = device.revokedAt === null;
  const takesChecks = s !== null && s.mode !== "off";
  return (
    <Layout view={view} title={`${device.name}: location and help`}>
      <h1>{device.name}</h1>
      <PhoneTabs view={view} device={device} current="location" />
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {data.unseenHelp.map((r) => (
        <HelpCard view={view} request={r} showDevice={false} kidNumber={data.help.kidNumber} where={where} back="location" />
      ))}
      <OnThisPage
        links={[
          ["#where", "Where the phone is"],
          ["#sharing", "Sharing"],
          ["#checks", "Checks"],
          ["#events", "Arrivals and departures"],
          ["#places", "Places"],
          ["#lost", "Lost mode"],
          ["#numbers", "Help and the emergency card"],
        ]}
      />

      <h2 id="where">Where the phone is</h2>
      <div class="card">
        <ModeLine settings={s} />
        {s?.lost && (
          <Notice kind="warn">
            Lost mode is on, since <Time ms={s.lost.since} tz={view.tz} />: the phone shares where it is every 5 minutes.
          </Notice>
        )}
        {data.checked && (
          <Notice kind={data.checked.fix ? undefined : "warn"}>
            {data.checked.fix ? (
              <>
                The phone answered: <FixLine view={view} deviceId={device.id} fix={data.checked.fix} where={where} />
              </>
            ) : (
              "No answer yet: the phone hasn't sent a fix within a minute. It may be offline, or GPS needs longer indoors. The check stays open for 2 minutes, and the fix shows here if it comes."
            )}
          </Notice>
        )}
        {data.latest ? (
          <p>
            Last fix: <FixLine view={view} deviceId={device.id} fix={data.latest} where={where} />
          </p>
        ) : (
          <p class="muted">Belay has no fix for this phone{takesChecks ? " yet" : ""}.</p>
        )}
        {takesChecks && connected && (
          <PostButton view={view} action={`/devices/${device.id}/location/check`}>
            Check now
          </PostButton>
        )}
        {takesChecks && <p class="muted small">Check now asks the phone for a fresh fix and waits up to a minute. The kid gets a notice: "Your parent checked where this phone is".</p>}
        <PhoneReport view={view} settings={s} report={data.report} />
        {s !== null && s.dropped > 0 && (
          <p class="small muted">
            The phone sent {s.dropped} fix{s.dropped === 1 ? "" : "es"} or place event{s.dropped === 1 ? "" : "s"} these rules didn't ask for; Belay didn't keep
            them{s.droppedAt !== null && <> (the last <Time ms={s.droppedAt} tz={view.tz} />)</>}.
          </p>
        )}
      </div>

      <h2>Sharing</h2>
      <SharingForm view={view} device={device} settings={s} />

      <h2 id="checks">Checks</h2>
      <div class="card">
        <p class="muted small">Every time a parent, or their AI app, checked where the phone is, the last 30 days. The kid sees the same list on the phone.</p>
        {data.checks.length === 0 && <p class="muted">No checks.</p>}
        {data.checks.map(({ command, fix }) => (
          <div class="change">
            <Time ms={command.issuedAt} tz={view.tz} />
            <div>
              <span>{checker(command)}</span>
              <div class="small">
                {fix ? <FixLine view={view} deviceId={device.id} fix={fix} where={where} /> : CHECK_WORDS[command.state]}
                {command.state === "failed" && command.problem && (
                  <>
                    <span class="muted"> Belay on the phone says:</span>
                    <blockquote>{command.problem}</blockquote>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <h2 id="events">Arrivals and departures</h2>
      <div class="card">
        {s?.mode !== "periodic" && <p class="muted small">Arrivals and departures need the phone to share where it is periodically.</p>}
        {data.events.length === 0 && <p class="muted">None in the last 7 days.</p>}
        {data.events.map((e) => (
          <div class="change">
            <Time ms={e.at} tz={view.tz} />
            <div>
              {e.kind === "arrived" ? "Arrived at" : "Left"} <strong>{e.placeName}</strong>
              {e.notifiedAt !== null && <span class="small muted"> · you were told</span>}
            </div>
          </div>
        ))}
      </div>

      <h2 id="places">Places</h2>
      <div class="card">
        <p class="muted small">
          The family's places, by name: the kid sees the names. They work only while the phone shares where it is periodically. A place's center comes from
          coordinates pasted from a map, or from where the phone is now; Belay doesn't search addresses, since that would need another company's service.
        </p>
        {data.places.map((p) => (
          <div class="rule">
            <div class="row spread">
              <strong>{p.name}</strong>
              <PostButton view={view} action={`/devices/${device.id}/location/places/${p.id}/remove`} kind="danger" confirm={`Remove ${p.name}?`}>
                Remove
              </PostButton>
            </div>
            <PlaceForm view={view} device={device} place={p} canUseFix={data.latest !== null} />
          </div>
        ))}
        {data.places.length < LOCATION_LIMITS.maxPlaces && (
          <>
            <h3>Add a place</h3>
            <PlaceForm view={view} device={device} canUseFix={data.latest !== null} />
          </>
        )}
      </div>

      <h2 id="lost">Lost mode</h2>
      <div class="card">
        {s?.lost ? (
          <>
            <p>
              This phone is in lost mode, since <Time ms={s.lost.since} tz={view.tz} />. Its lock screen says:
            </p>
            <blockquote>{s.lost.number ? `${s.lost.message} ${s.lost.number}` : s.lost.message}</blockquote>
            <PostButton view={view} action={`/devices/${device.id}/location/lost`} fields={{ off: "1" }} kind="quiet">
              Turn lost mode off
            </PostButton>
          </>
        ) : (
          <form class="stack" method="post" action={`/devices/${device.id}/location/lost`} data-confirm="Put this phone in lost mode?">
            <Csrf view={view} />
            <p class="small">
              For a phone that's lost: the lock screen shows your message and a number, location stays on (even if sharing is off), the phone shares
              where it is every 5 minutes, and its screen locks once. Everything goes back when you turn it off.
            </p>
            <label for="lost-message">The lock screen's message</label>
            <input id="lost-message" type="text" name="message" maxlength={LOCATION_LIMITS.lostMessage} value={s?.lostMessage ?? LOST_MESSAGE} required />
            <label for="lost-number">A number to show with it</label>
            <input id="lost-number" type="text" name="number" maxlength={LOCATION_LIMITS.lostNumber} value={s?.lostNumber ?? ""} placeholder="555-0100" inputmode="tel" />
            <div>
              <button type="submit" class="danger" disabled={!connected}>
                This phone is lost
              </button>
            </div>
          </form>
        )}
      </div>

      <h2>Help and the emergency card</h2>
      <NumbersCard view={view} device={device} help={data.help} familyNumbers={data.familyNumbers} />
    </Layout>
  );
};
