/** The kid's requests on every phone, and what AI apps proposed: the two things that wait for a parent. */
import type { FC } from "hono/jsx";
import { LIMITS, MORE_TIME_CHOICES } from "../../family/policy.js";
import { changeWords, type Proposal } from "../../family/proposals.js";
import { STATUS_WORDS, type AgreementAnswerView, type AppRequestView, type MoreTimeView, type RequestView } from "../../family/requests.js";
import { Csrf, Layout, Notice, Time, type View } from "../ui.js";

const appLink = (r: { deviceId: string; package: string }) => `/devices/${r.deviceId}/apps/${encodeURIComponent(r.package)}`;

/** A limit's name on its phone (the family's words), "every limit" for "*". */
export type LimitNames = (deviceId: string, limitId: string) => string;

const Reason: FC<{ request: RequestView }> = ({ request }) =>
  request.reason ? (
    <>
      <p class="small muted">In their words:</p>
      <blockquote class="kid">{request.reason}</blockquote>
    </>
  ) : (
    <p class="small muted">They didn't say why.</p>
  );

/** The app's name, linked to its page when the server knows the app on that phone. */
const AppName: FC<{ request: AppRequestView; known: ReadonlySet<string> }> = ({ request, known }) =>
  known.has(`${request.deviceId} ${request.package}`) ? (
    <a class="name" href={appLink(request)}>
      {request.label}
    </a>
  ) : (
    <span class="name">{request.label}</span>
  );

/** "More time for Games", "More screen time" for every limit. */
const moreTimeTitle = (r: MoreTimeView, limitName: LimitNames) => (r.limitId === "*" ? "More screen time" : `More time for ${limitName(r.deviceId, r.limitId)}`);

/** What it's about, in one line, for the answered list. */
function subject(r: RequestView, limitName: LimitNames): string {
  switch (r.kind) {
    case "app":
      return r.label;
    case "more_time":
      return r.status === "approved" && r.givenMinutes !== null ? `${moreTimeTitle(r, limitName)}: ${r.givenMinutes} minutes given` : moreTimeTitle(r, limitName);
    case "agreement":
      return r.answer === "agree" ? `Agreed to the family agreement (version ${r.version})` : `Wants to talk about the family agreement (version ${r.version})`;
  }
}

/** A "more time" request: 15, 30 or 60 minutes for today, "Let's talk", or "No", with a note. */
const OpenMoreTime: FC<{ view: View; request: MoreTimeView; showDevice: boolean; limitName: LimitNames }> = ({ view, request, showDevice, limitName }) => (
  <div class="card">
    <div class="row spread">
      <strong>{moreTimeTitle(request, limitName)}</strong>
      <span class="chip waiting">{STATUS_WORDS[request.status]}</span>
    </div>
    <p class="small">
      {showDevice && <>{request.deviceName} · </>}
      Asked for {request.minutes} minutes{request.label && <> while in {request.label}</>}, <Time ms={Math.min(request.askedAt, request.receivedAt)} tz={view.tz} />
      {request.status === "talk" && " · you said let's talk"}
    </p>
    <Reason request={request} />
    <form class="stack" method="post" action={`/devices/${request.deviceId}/requests/${request.id}/answer`}>
      <Csrf view={view} />
      <input type="hidden" name="back" value="requests" />
      <label for={`note-${request.id}`}>Your answer, shown on the phone (optional)</label>
      <textarea id={`note-${request.id}`} name="note" maxlength={LIMITS.answerNote}>
        {request.note ?? ""}
      </textarea>
      <div class="row">
        {MORE_TIME_CHOICES.map((m) => (
          <button type="submit" name="give" value={String(m)}>
            {m} minutes
          </button>
        ))}
        <button type="submit" name="answer" value="talk" class="quiet">
          Let's talk
        </button>
        <button type="submit" name="answer" value="declined" class="quiet">
          No
        </button>
      </div>
      <p class="muted small">The minutes are for the phone's day today: they end when its day does, like the limit's own.</p>
    </form>
  </div>
);

/** The kid wants to talk about the agreement: "Let's talk", or that you saw it, with a note. */
const OpenAgreement: FC<{ view: View; request: AgreementAnswerView; showDevice: boolean }> = ({ view, request, showDevice }) => (
  <div class="card">
    <div class="row spread">
      <strong>Wants to talk about the family agreement</strong>
      <span class="chip waiting">{STATUS_WORDS[request.status]}</span>
    </div>
    <p class="small">
      {showDevice && <>{request.deviceName} · </>}
      <a href={`/devices/${request.deviceId}/agreement`}>Version {request.version}</a>, <Time ms={Math.min(request.askedAt, request.receivedAt)} tz={view.tz} />
    </p>
    <Reason request={request} />
    <form class="stack" method="post" action={`/devices/${request.deviceId}/requests/${request.id}/answer`}>
      <Csrf view={view} />
      <input type="hidden" name="back" value="requests" />
      <label for={`note-${request.id}`}>Your answer, shown on the phone (optional)</label>
      <textarea id={`note-${request.id}`} name="note" maxlength={LIMITS.answerNote}>
        {request.note ?? ""}
      </textarea>
      <div class="row">
        <button type="submit" name="answer" value="talk">
          Let's talk
        </button>
        <button type="submit" name="answer" value="approved" class="quiet">
          Got it
        </button>
      </div>
      <p class="muted small">To change the agreement, write a new version on the phone's Agreement page: the kid is asked again.</p>
    </form>
  </div>
);

const OpenRequest: FC<{ view: View; request: AppRequestView; showDevice: boolean; known: ReadonlySet<string> }> = ({ view, request, showDevice, known }) => (
  <div class="card">
    <div class="row spread">
      <AppName request={request} known={known} />
      <span class="chip waiting">{STATUS_WORDS[request.status]}</span>
    </div>
    <p class="pkg">{request.package}</p>
    <p class="small">
      {showDevice && <>{request.deviceName} · </>}
      Asked <Time ms={Math.min(request.askedAt, request.receivedAt)} tz={view.tz} />
    </p>
    <Reason request={request} />
    <form class="stack" method="post" action={`/devices/${request.deviceId}/requests/${request.id}/answer`}>
      <Csrf view={view} />
      <input type="hidden" name="back" value="requests" />
      <label for={`note-${request.id}`}>Your answer, shown on the phone (optional)</label>
      <textarea id={`note-${request.id}`} name="note" maxlength={LIMITS.answerNote}>
        {request.note ?? ""}
      </textarea>
      <div class="row">
        <button type="submit" name="answer" value="approved">
          Approve
        </button>
        <button type="submit" name="answer" value="talk" class="quiet">
          Let's talk
        </button>
        <button type="submit" name="answer" value="declined" class="quiet">
          Decline
        </button>
      </div>
      <p class="muted small">Approving also allows the app. Declining or "let's talk" leaves it as it is.</p>
    </form>
  </div>
);

export const RequestsPage: FC<{
  view: View;
  requests: RequestView[];
  phones: number;
  /** "deviceId package" for the apps the server knows on each phone. */
  known: ReadonlySet<string>;
  limitName: LimitNames;
  message?: string;
  error?: string;
}> = ({ view, requests, phones, known, limitName, message, error }) => {
  const open = requests.filter((r) => r.status === "pending" || r.status === "talk");
  const answered = requests.filter((r) => r.status === "approved" || r.status === "declined");
  return (
    <Layout view={view} title="Requests">
      <h1>Requests</h1>
      <p class="muted">
        What the kid asked for from Belay's screen on their phone: apps, more time, and what they think of the family agreement. They see your answer,
        and your note, there.
      </p>
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {open.length === 0 && <p class="muted">Nothing is waiting for you.</p>}
      {open.map((r) =>
        r.kind === "app" ? (
          <OpenRequest view={view} request={r} showDevice={phones > 1} known={known} />
        ) : r.kind === "more_time" ? (
          <OpenMoreTime view={view} request={r} showDevice={phones > 1} limitName={limitName} />
        ) : (
          <OpenAgreement view={view} request={r} showDevice={phones > 1} />
        ),
      )}
      {answered.length > 0 && (
        <>
          <h2>Answered in the last 30 days</h2>
          <div class="card">
            {answered.map((r) => (
              <div class="change">
                <Time ms={r.answeredAt ?? r.receivedAt} tz={view.tz}>
                  {r.kind === "agreement" && r.answer === "agree" && r.answeredBy === null ? "Agreed" : STATUS_WORDS[r.status]}
                </Time>
                <div>
                  {r.kind === "app" ? <AppName request={r} known={known} /> : <span class="name">{subject(r, limitName)}</span>}{" "}
                  <span class="small muted">{r.deviceName}</span>
                  <div class="small muted">
                    {r.answeredBy ? `by ${r.answeredBy}, ` : ""}
                    <Time ms={r.answeredAt ?? r.receivedAt} tz={view.tz} />
                  </div>
                  {r.reason && (
                    <>
                      <span class="small muted">In their words:</span>
                      <blockquote class="kid">{r.reason}</blockquote>
                    </>
                  )}
                  {r.note && (
                    <>
                      <span class="small muted">Your answer:</span>
                      <blockquote>{r.note}</blockquote>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Layout>
  );
};

const PROPOSAL_STATUS = { pending: "Waiting for you", approved: "Approved", rejected: "Rejected", outdated: "Out of date" } as const;

const EFFECT_CHIP = { tightens: "chip allowed", loosens: "chip blocked", neither: "chip" } as const;

export const ProposalsPage: FC<{
  view: View;
  proposals: Proposal[];
  /** For pending proposals that are out of date now: what changed since (family/proposals.ts, outdatedBecause). */
  stale: ReadonlyMap<string, string>;
  /** For screen-time proposals: each change in words, and whether it tightens or loosens. */
  details?: ReadonlyMap<string, { effect: "tightens" | "loosens" | "neither"; words: string }[]>;
  message?: string;
  error?: string;
}> = ({ view, proposals, stale, details, message, error }) => {
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");
  return (
    <Layout view={view} title="Proposals">
      <h1>Proposals</h1>
      <p class="muted">
        What AI apps you connected proposed that would loosen a phone's rules. Nothing changes until a parent approves it here. They can block an app
        or pause a phone themselves; the Activity page shows when they did.
      </p>
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {pending.length === 0 && <p class="muted">Nothing is waiting for you.</p>}
      {pending.map((p) => (
        <div class="card">
          <div class="row spread">
            <strong>{changeWords(p.change, p.label).title}</strong>
            <span class="chip waiting">{PROPOSAL_STATUS[p.status]}</span>
          </div>
          <p class="small">
            {p.deviceName}
            {p.change.kind === "allow_app" && <span class="pkg"> · {p.change.package}</span>}
          </p>
          <p class="small muted">
            Proposed by {p.clientName}
            {p.parentName && <>, through {p.parentName}'s connection</>}, <Time ms={p.createdAt} tz={view.tz} />. Its reason, in its words:
          </p>
          <blockquote class="ai">{p.reason}</blockquote>
          {details?.get(p.id) && (
            <ul class="small">
              {details.get(p.id)?.map((c) => (
                <li>
                  {c.words} <span class={EFFECT_CHIP[c.effect]}>{c.effect === "neither" ? "neither" : c.effect}</span>
                </li>
              ))}
            </ul>
          )}
          {stale.has(p.id) && (
            <Notice kind="warn">
              This is out of date: {stale.get(p.id)} Approving it changes nothing; if you still want it, make the change on the phone's page.
            </Notice>
          )}
          <form class="stack" method="post" action={`/proposals/${p.id}/approve`}>
            <Csrf view={view} />
            {p.change.kind === "allow_app" && (
              <>
                <label for={`note-${p.id}`}>A note shown on the phone (optional)</label>
                <textarea id={`note-${p.id}`} name="note" maxlength={LIMITS.answerNote}></textarea>
              </>
            )}
            <div class="row">
              <button type="submit">Approve</button>
              <button type="submit" class="quiet" formaction={`/proposals/${p.id}/reject`}>
                Reject
              </button>
            </div>
          </form>
        </div>
      ))}
      {decided.length > 0 && (
        <>
          <h2>Decided</h2>
          <div class="card">
            {decided.map((p) => (
              <div class="change">
                <Time ms={p.decidedAt ?? p.createdAt} tz={view.tz}>
                  {PROPOSAL_STATUS[p.status]}
                </Time>
                <div>
                  {changeWords(p.change, p.label).title} <span class="small muted">{p.deviceName}</span>
                  <div class="small muted">
                    proposed by {p.clientName}
                    {p.decidedBy && (p.status === "outdated" ? `; not applied when ${p.decidedBy} approved it` : `; ${p.status} by ${p.decidedBy}`)}
                  </div>
                  {p.status === "outdated" && p.outdatedWhy && <div class="small">{p.outdatedWhy}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Layout>
  );
};
