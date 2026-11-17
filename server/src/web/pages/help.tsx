/**
 * Phase 7 on the parent pages: the kid's "I need help", first on the Requests page (and above
 * everything on the Phones page and the phone's page) until a parent marks it seen, with "Call"
 * (a tel: link to the parent's own phone app) and where the phone was if the kid shared it. And the
 * way every page shows a fix (Phase 4): in words, by the family's places, with its accuracy and
 * age, and "Open in a map", a plain link only the parent's browser follows, when clicked.
 */
import type { FC } from "hono/jsx";
import { distanceWords } from "../../family/location/describe.js";
import type { FixView } from "../../family/location/store.js";
import { type HelpView, helpWords } from "../../family/requests.js";
import { LIMITS } from "../../family/policy.js";
import { formatAgo } from "../../time.js";
import { Csrf, Time, type View } from "../ui.js";

/** How the pages describe where the phone was, without any third-party service. */
export interface Where {
  /** "At School, within 40 m" or "1.2 km from Home", by the phone's places; null when it has none. */
  describe: (deviceId: string, fix: FixView) => string | null;
  /** The family's map site, for "Open in a map". */
  mapLink: (fix: FixView) => string;
}

/** One fix: in words, how accurate, when, and "Open in a map". */
export const FixLine: FC<{ view: View; deviceId: string; fix: FixView; where: Where }> = ({ view, deviceId, fix, where }) => {
  const words = where.describe(deviceId, fix);
  return (
    <span class="fix">
      <strong>{words ?? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}`}</strong>
      {words?.startsWith("At ") ? "" : ` · accurate to ${distanceWords(fix.accuracyM)}`}
      {words === null ? "" : <span class="coords small muted"> ({fix.lat.toFixed(5)}, {fix.lng.toFixed(5)})</span>}
      {" · "}
      <Time ms={fix.at} tz={view.tz} /> ({formatAgo(fix.at, view.now)}) ·{" "}
      <a href={where.mapLink(fix)} rel="noopener noreferrer" target="_blank">
        Open in a map
      </a>
      {fix.mock && <span class="chip warn">Android says an app made this up</span>}
    </span>
  );
};

/** A help request no parent has seen: what the kid said, where the phone was, "Call", and "I've seen it". */
export const HelpCard: FC<{ view: View; request: HelpView; showDevice: boolean; kidNumber: string | null; where: Where; back?: string }> = ({
  view,
  request: r,
  showDevice,
  kidNumber,
  where,
  back,
}) => (
  <div class="card help" id={`help-${r.id}`}>
    <div class="row spread">
      <strong class="title">{showDevice ? `${r.deviceName} needs help` : "Needs help"}</strong>
      <span class="chip blocked">{helpWords(r)}</span>
    </div>
    <p class="small">
      Sent <Time ms={Math.min(r.askedAt, r.receivedAt)} tz={view.tz} /> ({formatAgo(Math.min(r.askedAt, r.receivedAt), view.now)})
      {r.withdrawnAt !== null && (
        <>
          {" "}
          · the kid withdrew it <Time ms={Math.min(r.withdrawnAt, r.updatedAt)} tz={view.tz} />
        </>
      )}
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
    <div class="row">
      {kidNumber ? (
        <a class="button call" href={`tel:${kidNumber}`}>
          Call {kidNumber}
        </a>
      ) : (
        <span class="small">
          <a href={`/devices/${r.deviceId}/location#numbers`}>Add the kid's number</a> to call from here.
        </span>
      )}
      <form method="post" action={`/devices/${r.deviceId}/requests/${r.id}/seen`} class="row inline">
        <Csrf view={view} />
        {back && <input type="hidden" name="back" value={back} />}
        <input type="text" name="note" maxlength={LIMITS.answerNote} placeholder="A note for the phone (optional)" aria-label="A note shown on the phone" />
        <button type="submit">I've seen it</button>
      </form>
    </div>
    <p class="muted small">
      The kid's phone shows "Your parent saw this" with the time once you mark it seen. If they're in danger, call 911. Belay doesn't call
      anyone for you.
    </p>
  </div>
);

/** Above everything on a page: a help request no parent has seen, with a link to it. */
export const HelpBanner: FC<{ requests: HelpView[]; showDevice: boolean }> = ({ requests, showDevice }) =>
  requests.length ? (
    <div class="help-banner" role="alert">
      <strong>
        {requests.length === 1
          ? `${showDevice ? `${requests[0]?.deviceName ?? "A phone"} needs` : "The kid needs"} help.`
          : `${requests.length} help requests haven't been seen.`}
      </strong>{" "}
      <a href="/requests#help">Open the Requests page</a> to see what they said, call, and mark it seen.
    </div>
  ) : null;
