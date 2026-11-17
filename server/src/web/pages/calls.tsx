/**
 * Phase 5 on the parent pages: a phone's Calls tab. Turning calls on or off (Belay becomes the
 * phone app, and what that means for 911 and 988), who may call and whom the kid may call, quiet
 * times and recording; the Contacts editor; the private and blocked numbers; and recent calls,
 * with "Add as contact" and "Block" beside a caller who isn't a contact. Contact names are the
 * family's words, escaped like everything in JSX.
 */
import type { FC } from "hono/jsx";
import type { Enforcement } from "../../device/schemas.js";
import { CALL_LIMITS } from "../../family/calls/numbers.js";
import type { CallRecordView } from "../../family/calls/records.js";
import type { CallSettings, Contact, ListedNumber } from "../../family/calls/store.js";
import { OUTCOME_WORDS, REASON_WORDS, rulesInWords } from "../../family/calls/words.js";
import type { DeviceView } from "../../family/devices.js";
import type { ContactRequestView } from "../../family/requests.js";
import type { ParentNumber } from "../../settings.js";
import { formatDuration } from "../../time.js";
import { Csrf, Layout, Notice, OnThisPage, PostButton, Time, type View } from "../ui.js";
import { PhoneTabs } from "./screentime.js";

export interface CallsPageData {
  device: DeviceView;
  settings: CallSettings | null;
  contacts: Contact[];
  privateNumbers: ListedNumber[];
  blockedNumbers: ListedNumber[];
  records: CallRecordView[];
  /** What Belay on the phone says about calls (enforcement.calls). */
  report: Enforcement["calls"] | null;
  /** The numbers on the kid's emergency card that aren't contacts. */
  cardNotContacts: ParentNumber[];
  requests: ContactRequestView[];
  /** How many days of records the family keeps. */
  callDays: number;
}

const ACTION_CHOICES = [
  ["ring", "Ring"],
  ["voicemail", "Go to voicemail"],
  ["reject", "Are refused"],
] as const;

const Always: FC = () => (
  <p class="small">
    <strong>911, 988 and every emergency number always work</strong>, in and out, in every mode, even when the phone is paused or at bedtime: Belay allows
    them in its own code, whatever these rules say, and Android sends an emergency call to the phone's own dialer. For 2 hours after a call to an emergency
    number or 988, every caller rings, so they can call back. Belay never records calls with them.
  </p>
);

/** What Belay on the phone says about calls: the server's own words, and the phone's, quoted. */
const PhoneReport: FC<{ settings: CallSettings | null; report: Enforcement["calls"] | null }> = ({ settings, report }) => {
  if (!settings?.enabled) return null;
  if (!report) return <p class="small muted">The phone hasn't said yet whether Belay is its phone app: it does with its next check-in.</p>;
  return (
    <>
      {report.dialer ? (
        <p class="small">On the phone: Belay is the phone app.</p>
      ) : (
        <Notice kind="warn">
          Calls are going through the phone's own app, so Belay can't decide who rings or keep a record of calls. Calls, 911 and 988 still work: Belay lets
          that happen on purpose, since a phone that can't take calls would be worse.
        </Notice>
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

const RulesForm: FC<{ view: View; device: DeviceView; settings: CallSettings | null }> = ({ view, device, settings }) => {
  const s = settings;
  const on = s?.enabled === true;
  const pick = <K extends "unknown" | "withheld">(key: K) => s?.[key] ?? "voicemail";
  return (
    <form class="stack card" method="post" action={`/devices/${device.id}/calls`} id="rules" data-confirm={on ? undefined : "Turn calls on? Belay becomes this phone's phone app."}>
      <Csrf view={view} />
      {!on && <input type="hidden" name="enabled" value="1" />}
      <fieldset>
        <legend>
          <strong>Who can call</strong>
        </legend>
        <label class="check">
          <input type="radio" name="mode" value="open" checked={(s?.mode ?? "open") === "open"} /> Anyone
        </label>
        <label class="check">
          <input type="radio" name="mode" value="contacts" checked={s?.mode === "contacts"} /> Only contacts (below) who can call
        </label>
      </fieldset>
      <div class="row">
        <label for="unknown">With only contacts, callers who aren't contacts</label>
        <select id="unknown" name="unknown">
          {ACTION_CHOICES.map(([value, words]) => (
            <option value={value} selected={pick("unknown") === value}>
              {words}
            </option>
          ))}
        </select>
      </div>
      <div class="row">
        <label for="withheld">With only contacts, callers with no caller ID</label>
        <select id="withheld" name="withheld">
          {ACTION_CHOICES.map(([value, words]) => (
            <option value={value} selected={pick("withheld") === value}>
              {words}
            </option>
          ))}
        </select>
      </div>
      <p class="muted small">A caller whose number fails the carrier's check counts as someone who isn't a contact. A refused call never rings.</p>
      <fieldset>
        <legend>
          <strong>Whom the kid can call</strong>
        </legend>
        <label class="check">
          <input type="radio" name="outgoing" value="any" checked={(s?.outgoing ?? "any") === "any"} /> Any number
        </label>
        <label class="check">
          <input type="radio" name="outgoing" value="contacts" checked={s?.outgoing === "contacts"} /> Only contacts who can call
        </label>
      </fieldset>
      <label class="check">
        <input type="checkbox" name="quiet" value="1" checked={s?.quiet === true} /> Quiet times: during bedtime and school schedules (Screen-time rules), only
        parents ring
      </label>
      <label class="check">
        <input type="checkbox" name="log" value="1" checked={s?.log === true} /> Keep a record of calls: when, which way, how long, and the contact or the
        number. Never what's said, and never 911, 988 or private numbers
      </label>
      <p class="muted small">
        The kid sees on the phone who can call them and whether calls are recorded. Only a parent turns calls on or off, or chooses to record them: AI apps
        can't, and can't propose it. They may tighten the rest, and propose the rest.
      </p>
      <div>
        <button type="submit">{on ? "Save" : "Turn calls on"}</button>
      </div>
    </form>
  );
};

const ContactForm: FC<{ view: View; device: DeviceView; contact?: Contact; prefill?: { name: string; number: string; parent: boolean } }> = ({ view, device, contact, prefill }) => {
  const key = contact?.id ?? "new";
  const numbers = Array.from({ length: CALL_LIMITS.numbersPerContact }, (_, i) => contact?.numbers[i] ?? (i === 0 ? (prefill?.number ?? "") : ""));
  return (
    <form class="stack" method="post" action={`/devices/${device.id}/calls/contacts`}>
      <Csrf view={view} />
      {contact && <input type="hidden" name="id" value={contact.id} />}
      <label for={`name-${key}`}>Name, as the kid sees it</label>
      <input id={`name-${key}`} type="text" name="name" maxlength={CALL_LIMITS.contactName} required value={contact?.name ?? prefill?.name ?? ""} placeholder="Grandma" />
      <div class="row">
        {numbers.map((n, i) => (
          <input type="text" name="number" value={n} placeholder={i === 0 ? "+15555550100" : "Another number"} inputmode="tel" aria-label={`Number ${i + 1}`} />
        ))}
      </div>
      <div class="row">
        <label class="check">
          <input type="checkbox" name="calls" value="1" checked={contact?.calls ?? true} /> Can call and be called
        </label>
        <label class="check">
          <input type="checkbox" name="texts" value="1" checked={contact?.texts ?? true} /> Can text
        </label>
        <label class="check">
          <input type="checkbox" name="parent" value="1" checked={contact?.parent ?? prefill?.parent ?? false} /> A parent: always rings, even at quiet times,
          and is on the kid's emergency card
        </label>
      </div>
      <div>
        <button type="submit" class={contact ? "quiet" : undefined}>
          {contact ? "Save" : "Add the contact"}
        </button>
      </div>
    </form>
  );
};

/** A list of numbers with its add form: blocked or private. */
const NumbersCard: FC<{ view: View; device: DeviceView; kind: "blocked" | "private"; numbers: ListedNumber[]; callsOn: boolean }> = ({ view, device, kind, numbers, callsOn }) => (
  <div class="card" id={kind}>
    {kind === "blocked" ? (
      <p class="small">
        Belay, as the phone app, puts these on Android's block list, which blocks their calls and texts too. {callsOn ? "" : "Blocking works only while calls are on."}{" "}
        It never blocks 911, 988 or an emergency number, a contact's number, or one on the emergency card.
      </p>
    ) : (
      <p class="small">
        Belay never records calls with these numbers, like a helpline the kid might call, besides 911, 988 and emergency numbers, which it never records
        anyway. Only a parent sees which numbers they are: AI apps see how many.
      </p>
    )}
    {numbers.length === 0 && <p class="muted">None.</p>}
    {numbers.map((n) => (
      <div class="row spread">
        <span>
          <strong class="pkg">{n.number}</strong>
          <span class="small muted">
            {" "}
            · {kind === "blocked" ? "blocked" : "added"} <Time ms={n.addedAt} tz={view.tz} />
            {n.clientName ? ` by ${n.clientName}, through ${n.addedBy ?? "a parent"}'s connection` : n.addedBy ? ` by ${n.addedBy}` : ""}
          </span>
        </span>
        <PostButton view={view} action={`/devices/${device.id}/calls/${kind}/remove`} fields={{ number: n.number }} kind="quiet">
          {kind === "blocked" ? "Unblock" : "Remove"}
        </PostButton>
      </div>
    ))}
    {numbers.length < (kind === "blocked" ? CALL_LIMITS.maxBlocked : CALL_LIMITS.maxPrivate) && (
      <form class="row" method="post" action={`/devices/${device.id}/calls/${kind}`}>
        <Csrf view={view} />
        <input type="text" name="number" required placeholder="+15555550100" inputmode="tel" aria-label={kind === "blocked" ? "A number to block" : "A private number"} />
        <button type="submit" class="quiet">
          {kind === "blocked" ? "Block" : "Add"}
        </button>
      </form>
    )}
  </div>
);

const DIRECTION = { in: "Incoming", out: "Outgoing" } as const;

/** One call: when, which way, who, what happened; for a caller who isn't a contact, "Add as contact" and "Block". */
const CallRow: FC<{ view: View; device: DeviceView; record: CallRecordView; names: ReadonlyMap<string, string>; blocked: ReadonlySet<string>; contactNumbers: ReadonlySet<string> }> = ({
  view,
  device,
  record: r,
  names,
  blocked,
  contactNumbers,
}) => {
  const contact = r.contactId === null ? null : (names.get(r.contactId) ?? r.contactName);
  const stranger = r.number !== null && !contactNumbers.has(r.number);
  return (
    <div class="change">
      <Time ms={r.at} tz={view.tz} />
      <div>
        <span>
          {DIRECTION[r.direction]}: {contact !== null ? <strong>{contact}</strong> : r.number !== null ? <strong class="pkg">{r.number}</strong> : "no caller ID"}
          {r.contactId !== null && !names.has(r.contactId) && <span class="small muted"> (a contact since removed)</span>}
        </span>
        <div class="small">
          {OUTCOME_WORDS[r.outcome]}
          {r.reason && <> · {REASON_WORDS[r.reason]}</>}
          {r.durationS > 0 && <> · {formatDuration(r.durationS * 1000)}</>}
        </div>
        {stranger && r.number !== null && (
          <div class="row">
            <form class="row inline" method="post" action={`/devices/${device.id}/calls/contacts`}>
              <Csrf view={view} />
              <input type="hidden" name="number" value={r.number} />
              <input type="hidden" name="calls" value="1" />
              <input type="hidden" name="texts" value="1" />
              <input type="text" name="name" maxlength={CALL_LIMITS.contactName} required placeholder="Their name" aria-label={`A name for ${r.number}`} />
              <button type="submit" class="quiet">
                Add as contact
              </button>
            </form>
            {!blocked.has(r.number) && (
              <PostButton view={view} action={`/devices/${device.id}/calls/blocked`} fields={{ number: r.number }} kind="danger" confirm={`Block ${r.number}?`}>
                Block
              </PostButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const CallsPage: FC<{ view: View; data: CallsPageData; message?: string; error?: string }> = ({ view, data, message, error }) => {
  const { device, settings: s } = data;
  const on = s?.enabled === true;
  const names = new Map(data.contacts.map((c) => [c.id, c.name]));
  const blocked = new Set(data.blockedNumbers.map((b) => b.number));
  const contactNumbers = new Set(data.contacts.flatMap((c) => c.numbers));
  return (
    <Layout view={view} title={`${device.name}: calls`}>
      <h1>{device.name}</h1>
      <PhoneTabs view={view} device={device} current="calls" />
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <OnThisPage
        links={[
          ["#calls", "Calls"],
          ["#rules", "Rules"],
          ["#contacts", "Contacts"],
          ...(data.requests.length > 0 ? [["#requests", "The kid's contact requests"] as const] : []),
          ["#blocked", "Blocked numbers"],
          ["#private", "Private numbers"],
          ["#recent", "Recent calls"],
        ]}
      />

      <h2 id="calls">Calls</h2>
      <div class="card">
        {on ? (
          <>
            <p>
              Calls are on, since {s.enabledAt !== null ? <Time ms={s.enabledAt} tz={view.tz} /> : "a while"}: Belay is this phone's phone app, and decides who
              rings.
            </p>
            <ul class="small">
              {rulesInWords(s).map((line) => (
                <li>{line}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            Calls are off: Belay leaves calls alone on this phone. Turn them on to decide who can call the kid and whom they can call. Belay then becomes the
            phone's phone app: the kid makes and takes calls in Belay, with the contacts you approve here.
          </p>
        )}
        <Always />
        <p class="small muted">
          If Belay ever stops working as the phone app, calls go through the phone's own app with no rules, and this page says so: a phone that can't take
          calls would be worse.
        </p>
        <PhoneReport settings={s} report={data.report} />
        {on && (
          <PostButton view={view} action={`/devices/${device.id}/calls/off`} kind="quiet" confirm="Turn calls off? Belay stops being the phone app, and the phone's own app takes calls with no rules.">
            Turn calls off
          </PostButton>
        )}
      </div>

      <h2>Rules</h2>
      <RulesForm view={view} device={device} settings={s} />

      <h2 id="contacts">Contacts</h2>
      <div class="card">
        <p class="muted small">
          The people who may call the kid and whom the kid may call, by the rules above. Belay keeps them on the phone in its own list; it never writes them
          into Android's Contacts. Parents are on the kid's emergency card too, with 911 and 988.
        </p>
        {data.cardNotContacts.length > 0 && (
          <Notice kind="warn">
            On the kid's emergency card but not a contact:{" "}
            {data.cardNotContacts.map((p, i) => (
              <>
                {i > 0 && ", "}
                {p.name} ({p.number})
              </>
            ))}
            . With only contacts, their calls follow the rule for callers who aren't contacts. Add them as parents below.
          </Notice>
        )}
        {data.contacts.length === 0 && <p class="muted">No contacts yet.</p>}
        {data.contacts.map((c) => (
          <div class="rule">
            <div class="row spread">
              <span>
                <strong>{c.name}</strong>{" "}
                <span class="small muted">
                  {c.parent ? "parent · " : ""}
                  {c.calls ? "calls" : "no calls"} · {c.texts ? "texts" : "no texts"}
                </span>
                <br />
                <span class="pkg">{c.numbers.join(", ")}</span>
              </span>
              <PostButton view={view} action={`/devices/${device.id}/calls/contacts/${c.id}/remove`} kind="danger" confirm={`Remove ${c.name}?`}>
                Remove<span class="sr-only"> {c.name}</span>
              </PostButton>
            </div>
            {/* Folded away: five fields a contact, open, made the list hard to read on a phone. */}
            <details>
              <summary>
                Change<span class="sr-only"> {c.name}</span>
              </summary>
              <ContactForm view={view} device={device} contact={c} />
            </details>
          </div>
        ))}
        {data.contacts.length < CALL_LIMITS.maxContacts && (
          <>
            <h3>Add a contact</h3>
            <ContactForm view={view} device={device} />
            {data.cardNotContacts.map((p) => (
              <form class="row" method="post" action={`/devices/${device.id}/calls/contacts`}>
                <Csrf view={view} />
                <input type="hidden" name="name" value={p.name} />
                <input type="hidden" name="number" value={p.number} />
                <input type="hidden" name="calls" value="1" />
                <input type="hidden" name="texts" value="1" />
                <input type="hidden" name="parent" value="1" />
                <button type="submit" class="quiet">
                  Add {p.name} ({p.number}) as a parent
                </button>
              </form>
            ))}
          </>
        )}
      </div>

      {data.requests.length > 0 && (
        <>
          <h2 id="requests">The kid's contact requests</h2>
          <div class="card">
            <p class="small">
              {data.requests.length === 1 ? "1 request is" : `${data.requests.length} requests are`} waiting for you on the <a href="/requests">Requests page</a>:
            </p>
            <ul class="small">
              {data.requests.map((r) => (
                <li>
                  <span class="kid">{r.contactName}</span> (<span class="pkg">{r.contactNumber}</span>)
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <h2>Blocked numbers</h2>
      <NumbersCard view={view} device={device} kind="blocked" numbers={data.blockedNumbers} callsOn={on} />

      <h2>Private numbers</h2>
      <NumbersCard view={view} device={device} kind="private" numbers={data.privateNumbers} callsOn={on} />

      <h2 id="recent">Recent calls</h2>
      <div class="card">
        {!s?.log || !on ? (
          <p class="muted small">Belay keeps no record of calls on this phone: tick "Keep a record of calls" above to see them here.</p>
        ) : (
          <p class="muted small">
            The last 30 days, newest first; records are kept {data.callDays} days (Settings). Never calls with 911, 988, emergency numbers or private
            numbers: Belay doesn't record them.
          </p>
        )}
        {s !== null && s.dropped > 0 && (
          <p class="small muted">
            The phone sent {s.dropped} call record{s.dropped === 1 ? "" : "s"} these rules didn't ask for; Belay didn't keep them
            {s.droppedAt !== null && (
              <>
                {" "}
                (the last <Time ms={s.droppedAt} tz={view.tz} />)
              </>
            )}
            .
          </p>
        )}
        {data.records.length === 0 && <p class="muted">No calls.</p>}
        {data.records.map((r) => (
          <CallRow view={view} device={device} record={r} names={names} blocked={blocked} contactNumbers={contactNumbers} />
        ))}
      </div>
    </Layout>
  );
};
