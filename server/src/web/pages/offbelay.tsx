/**
 * Phase 11's parent pages: a phone's Off belay section (what the server keeps about it, with
 * "Stop collecting", and "Hand this phone over"), and the confirmation that lists exactly what a
 * stop deletes. Every step loosens or deletes, so each is a parent's, here; AI apps can't.
 */
import type { FC } from "hono/jsx";
import type { Kept } from "../../family/collection.js";
import type { DeviceView } from "../../family/devices.js";
import type { Handover } from "../../family/offbelay/store.js";
import type { StageView } from "../../family/screentime/rules.js";
import { formatAgo } from "../../time.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";

export interface OffBelayData {
  device: DeviceView;
  kept: Kept[];
  handover: Handover | null;
  /** The phone's stage, and the family's Off belay. */
  stage: StageView | null;
  offBelay: StageView | null;
  /** The phone's rules hold apps back, filter the web or are paused, in words (empty: none of it). */
  blocking: string[];
}

const KeptLine: FC<{ view: View; device: DeviceView; kept: Kept }> = ({ device, kept }) => (
  <div class="row spread">
    <span>
      <strong>{kept.title}</strong>
      <br />
      <span class="small">{kept.goes.length ? `Kept: ${kept.goes.join("; ")}.` : "Nothing kept."}</span>
      <br />
      <span class="small muted">{kept.stopping}</span>
    </span>
    {kept.anything && !device.revokedAt && (
      <a class="button quiet" href={`/devices/${device.id}/collection/${kept.category}`}>
        Stop collecting and delete…
      </a>
    )}
  </div>
);

/** The hand-over, before it: what it does, what's still on, and the typed confirmation. */
const HandOverForm: FC<{ view: View; data: OffBelayData }> = ({ view, data }) => {
  const { device, stage, offBelay, blocking, kept } = data;
  const stillKept = kept.filter((k) => k.goes.length).map((k) => k.title.toLowerCase());
  return (
    <div class="card danger-zone">
      <p>
        <strong>Hand this phone over</strong> when it's time for it to be simply the kid's. Belay lifts the locks on factory reset, debugging and
        accounts, and clears reset protection and the accounts Play may use, so the phone isn't tied to your Google account any more. The phone then tells the kid what happens
        next: back up their photos and anything else they want to their own account, remove your account, and reset the phone from Settings. After
        the reset, Belay isn't on it. Then disconnect it here, and delete everything about it.
      </p>
      {offBelay && stage?.id !== offBelay.id && (
        <Notice kind="warn">
          This phone isn't on {offBelay.name} yet{stage ? ` (it's on ${stage.name})` : ""}. Move it there first on its Screen-time rules tab, so its
          screen time stops too.
        </Notice>
      )}
      {blocking.length > 0 && (
        <Notice kind="warn">
          Belay still {blocking.join(", ")} on this phone, which can get in the way of backing up: turn protection off, or allow what the kid needs,
          first.
        </Notice>
      )}
      {stillKept.length > 0 && (
        <p class="muted small">
          The server still keeps {stillKept.join(", ")} about it. Stop collecting above to delete it now, or delete everything about the phone after
          the reset.
        </p>
      )}
      {device.facts?.health.test_only && <p class="muted small">This is a debug build: it never set reset protection, so it leaves that alone.</p>}
      {device.revokedAt !== null ? (
        <p class="muted">This phone is disconnected, so it wouldn't get the hand-over.</p>
      ) : (
        <form class="stack" method="post" action={`/devices/${device.id}/handover`}>
          <Csrf view={view} />
          <label for="handover-confirm">
            To hand it over, type the phone's name: <strong>{device.name}</strong>
          </label>
          <input id="handover-confirm" type="text" name="confirm" autocomplete="off" maxlength={60} />
          <div>
            <button type="submit" class="danger">
              Hand this phone over
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

/** After the hand-over: whether the phone has it, what's next, and taking it back. */
const HandedOver: FC<{ view: View; device: DeviceView; handover: Handover }> = ({ view, device, handover }) => {
  const applied = device.enforcement?.policy_version ?? null;
  const has = applied !== null && applied >= handover.version;
  return (
    <div class="card">
      <p>
        <strong>Handed over</strong> <Time ms={handover.at} tz={view.tz} /> by {handover.byName ?? "the server's command line"}.{" "}
        {has
          ? `The phone has it (it applied rules version ${applied}): it shows the kid what to back up, and how to reset it.`
          : `Waiting for the phone to get it (rules version ${handover.version}); it was last heard from ${device.lastSeenAt ? formatAgo(device.lastSeenAt, view.now) : "never"}.`}
      </p>
      <ol class="steps">
        <li>
          With the kid: back up their photos and anything else they want to keep to their own Google account, remove your account from the phone,
          then Settings &gt; System &gt; Reset options &gt; Erase all data. Reset from Settings, not from recovery mode.
        </li>
        <li>After the reset the phone goes quiet here, as expected. Disconnect it below, then delete everything about it.</li>
      </ol>
      <p class="small muted">
        Taking it back stops the phone showing it. What it lifted stays lifted until you lock it again, under Hardening and Settings the kid can't
        change.
      </p>
      <PostButton view={view} action={`/devices/${device.id}/handover/cancel`} kind="quiet" confirm={`Take back handing ${device.name} over?`}>
        Take the hand-over back
      </PostButton>
    </div>
  );
};

/** The phone page's Off belay section. */
export const OffBelaySection: FC<{ view: View; data: OffBelayData }> = ({ view, data }) => (
  <>
    <h2 id="off-belay">Off belay</h2>
    <p class="muted small">
      When the kid is ready, the rules end in steps, each one yours: stop blocking (move the phone to Off belay, the last stage, and turn protection
      off), stop collecting, then hand the phone over. The phone shows the kid each step. AI apps can't take any of them.
    </p>
    <h3 id="collecting">What the server keeps about this phone</h3>
    <div class="card stack">
      {data.kept.map((kept) => (
        <KeptLine view={view} device={data.device} kept={kept} />
      ))}
      <p class="muted small">Device health (the phone's model, battery, and how Belay is doing) is kept while Belay is on the phone.</p>
    </div>
    <h3 id="handover">Hand this phone over</h3>
    {data.handover ? <HandedOver view={view} device={data.device} handover={data.handover} /> : <HandOverForm view={view} data={data} />}
  </>
);

/** The confirmation for stopping one category: exactly what goes, what changes on the phone, and what stays. */
export const CollectionPage: FC<{ view: View; device: DeviceView; kept: Kept; error?: string }> = ({ view, device, kept, error }) => (
  <Layout view={view} title={`Stop collecting: ${kept.title}`}>
    <p class="small">
      <a href={`/devices/${device.id}#collecting`}>← {device.name}</a>
    </p>
    <h1>
      Stop collecting {kept.title.toLowerCase()} for {device.name}?
    </h1>
    {error && <Notice kind="error">{error}</Notice>}
    <h2>What goes</h2>
    {kept.goes.length ? (
      <ul>
        {kept.goes.map((g) => (
          <li>{g}</li>
        ))}
      </ul>
    ) : (
      <p class="muted">Nothing is kept now.</p>
    )}
    <h2>On the phone</h2>
    <p>{kept.stopping}</p>
    {kept.stays.length > 0 && (
      <>
        <h2>What stays</h2>
        <ul>
          {kept.stays.map((s) => (
            <li>{s}</li>
          ))}
        </ul>
      </>
    )}
    <p class="muted small">
      It can't be undone. The server's daily backups still hold it until they age out (the newest 14 are kept), as do any copies you made. The
      activity log keeps a line saying what was deleted.
    </p>
    <form method="post" action={`/devices/${device.id}/collection/${kept.category}`}>
      <Csrf view={view} />
      <input type="hidden" name="fingerprint" value={kept.fingerprint} />
      <button type="submit" class="danger">
        Stop collecting and delete
      </button>
    </form>
  </Layout>
);
