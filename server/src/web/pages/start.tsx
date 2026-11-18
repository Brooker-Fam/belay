/**
 * The Phones page's Getting started card (family/start.ts): the steps of setting Belay up, as a
 * list with each step's state in words (the ring or tick beside it only decorates them), a few
 * plain words on why it matters while it isn't done, and a link to where it's done; then the
 * optional parts, "When you're ready", with their pages and the guide's sections. And, in
 * Settings, bringing it back once a parent hid it. Hono's JSX escapes every name in it.
 */
import type { Child, FC, PropsWithChildren } from "hono/jsx";
import type { GettingStarted, StartPhone, StartStep, StepState } from "../../family/start.js";
import { AI_SCOPES, type AiScope } from "../../settings.js";
import { formatDuration } from "../../time.js";
import { Csrf, PostButton, type View } from "../ui.js";
import { DOCS } from "./add.js";

/** The guide's sections, by their anchors on GitHub (a test checks each one is a heading of docs/guide.md). */
export const GUIDE = `${DOCS}/guide.md`;
const SERVER_DOCS = `${DOCS}/server.md`;

const STATE_WORDS: Record<StepState, string> = {
  done: "Done",
  waiting: "Waiting for the phone",
  todo: "Not yet",
  open: "Up to you",
};

/** "a, b and c"; "a, b and c, and d" when one of them has an "and" of its own. */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  const serial = items.length > 2 && items.some((i) => i.includes(" and "));
  return `${items.slice(0, -1).join(", ")}${serial ? "," : ""} and ${items.at(-1) ?? ""}`;
}

/** At most three names, then how many more. */
function some(names: string[]): string {
  return names.length <= 3 ? list(names) : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** "1 of the 4 essential steps is done" */
function progress({ done, of }: GettingStarted["essential"]): string {
  if (done === 0) return `none of the ${of} essential steps is done yet`;
  return `${done} of the ${of} essential steps ${done === 1 ? "is" : "are"} done`;
}

/** A category's name in a sentence: "device status". */
const category = (key: AiScope): string => (AI_SCOPES[key].split(":")[0] ?? key).toLowerCase();

/** One step: its title, its state in words, what Belay sees now, why it matters until it's done, and where it's done. */
const Step: FC<PropsWithChildren<{ title: string; state: StepState; optional?: boolean; why: Child; links: Child }>> = ({ title, state, optional, why, links, children }) => (
  <li class={`step ${state}`}>
    <p class="step-title">
      <strong>{title}</strong>
      <span class="sr-only">: </span> <span class={`chip state ${state}`}>{STATE_WORDS[state]}</span>
      {optional && (
        <>
          <span class="sr-only">, </span>
          <span class="chip">Optional</span>
        </>
      )}
    </p>
    {children}
    {state !== "done" && <p class="small muted">{why}</p>}
    {links && <p class="small links">{links}</p>}
  </li>
);

const rulesWords = (p: Extract<StartStep, { id: "rules" }>["phones"][number]): string =>
  p.rules === "applied"
    ? `${p.name} applied its rules.${p.protectedOn ? "" : " Protection is off, so new apps run without asking."}`
    : p.rules === "waiting"
      ? `${p.name} hasn't applied its rules yet. It does within a minute when it's online.`
      : `${p.name} has no rules yet: Belay reports what happens on it, and blocks nothing.`;

/** The link for a phone's rules: turning protection on while it's off, else the rules. */
const RulesLink: FC<{ phone: StartPhone & { protectedOn: boolean } }> = ({ phone }) => (
  <a href={`/devices/${phone.id}#rules`}>{phone.protectedOn ? `The rules on ${phone.name}` : `Turn protection on for ${phone.name}`}</a>
);

const StepItem: FC<{ view: View; step: StartStep }> = ({ view, step }) => {
  switch (step.id) {
    case "phone":
      return (
        <Step
          title="Add the kid's phone"
          state={step.state}
          why={
            <>
              Belay manages the phone as its device owner. Setting it up takes a computer, a USB cable and a freshly reset phone, once:{" "}
              <a href={`${GUIDE}#4-get-belay-onto-the-phone`}>Get Belay onto the phone, in the guide</a>.
            </>
          }
          links={
            step.state === "done" ? null : (
              // A new family's first thing to do: a button's look, for the page's main action.
              <a class="button" href="/add">
                Add a phone
              </a>
            )
          }
        >
          <p class="small">
            {step.state === "done"
              ? `${list(step.phones.map((p) => p.name))} ${step.phones.length === 1 ? "is" : "are"} enrolled.`
              : step.state === "waiting"
                ? `An enrollment code for ${some(step.codes.map((c) => c.deviceName))} is waiting to be used, for ${formatDuration(Math.max(...step.codes.map((c) => c.expiresAt)) - view.now)} more.`
                : "No phone yet."}
          </p>
        </Step>
      );
    case "rules":
      return (
        <Step
          title="The phone applies its first rules"
          state={step.state}
          why="The phone enforces its rules by itself, offline too. Turning protection on, in one step, makes new apps wait for you, filters the web and locks the settings that would undo Belay."
          links={
            step.phones.length === 1 && step.phones[0] && (step.state !== "done" || !step.phones[0].protectedOn) ? <RulesLink phone={step.phones[0]} /> : null
          }
        >
          {step.phones.length === 0 && <p class="small">Once the phone is added.</p>}
          {step.phones.length === 1 && step.phones[0] && <p class="small">{rulesWords(step.phones[0])}</p>}
          {step.phones.length > 1 && (
            <ul class="small">
              {step.phones.map((p) => (
                <li>
                  {rulesWords(p)} {(p.rules !== "applied" || !p.protectedOn) && <RulesLink phone={p} />}
                </li>
              ))}
            </ul>
          )}
        </Step>
      );
    case "look":
      return (
        <Step
          title="Look over the phone's rules and its stage"
          state={step.state}
          why="Belay's defaults are a starting point: screen time, schedules and stages are off until you set them, and each piece can loosen as your kid shows they can handle more."
          links={
            <>
              {step.phone && (
                <>
                  <a href={`/devices/${step.phone.id}#rules`}>The rules on {step.phone.name}</a>
                  <a href={`/devices/${step.phone.id}/screen-time/rules`}>Its screen-time rules</a>
                </>
              )}
              <a href="/stages">Stages</a>
            </>
          }
        >
          <p class="small">Belay can't tell when you've looked, so this one has no tick.</p>
        </Step>
      );
    case "notifications":
      return (
        <Step
          title="Turn on notifications"
          state={step.state}
          why="So you hear at once when your kid asks for an app or needs help, or an AI app proposes a change. Each parent turns them on in their own browsers; on an iPhone, add Belay to the Home Screen first."
          links={<a href="/settings#notifications">Notifications, in Settings</a>}
        >
          <p class="small">{step.state === "done" ? `On for you in ${some(step.browsers)}.` : "Not on in any of your browsers yet."}</p>
        </Step>
      );
    case "ai_reads": {
      const on = step.on.length ? `AI apps may read: ${list(step.on.map(category))}.` : "AI apps may read none of the categories.";
      return (
        <Step
          title="Decide what AI apps may read"
          state={step.state}
          optional
          why="Whatever an AI app like Claude reads goes to its provider. Location, calls and network activity start off; your kid's phone shows which are on."
          links={<a href="/settings#ai-reads">What AI apps may read, in Settings</a>}
        >
          <p class="small">
            {step.added.length > 0
              ? `Belay added ${list(step.added.map(category))} since you last saved: look ${step.added.length === 1 ? "it" : "them"} over, then save.`
              : step.saved
                ? `Saved. ${on}`
                : `Not saved yet, so Belay's defaults apply. ${on}`}
          </p>
        </Step>
      );
    }
    case "claude":
      return (
        <Step
          title="Connect Claude"
          state={step.state}
          optional
          why="Ask Claude what changed this week, have it look an app up, or block one. Anything that loosens a rule waits until a parent approves it here."
          links={
            <>
              <a href="/settings#ai">AI access, in Settings</a>
              <a href={`${GUIDE}#5-connect-claude`}>Connect Claude, in the guide</a>
            </>
          }
        >
          <p class="small">{step.state === "done" ? `Connected for you: ${some(step.connections)}.` : "Not connected for you yet."}</p>
        </Step>
      );
    case "backups":
      return (
        <Step
          title="Backups with a passphrase"
          state={step.state}
          why="Belay backs itself up every day. Encrypted, a copy is safe to keep off the server, on a USB stick or in a cloud drive: without the passphrase, nobody can read it. It's set where the server runs, not on this page."
          links={step.state === "done" ? null : <a href={`${SERVER_DOCS}#encrypted-backups`}>Encrypted backups, in the server's docs</a>}
        >
          <p class="small">
            {step.passphrase === "set"
              ? "Set: the daily backups are encrypted."
              : step.passphrase === "unusable"
                ? `A passphrase is set, but it can't be used: ${step.problem ?? "it can't be read."} The daily backups fail until it's fixed.`
                : "Not set: the daily backups aren't encrypted."}
          </p>
        </Step>
      );
  }
};

/** The optional parts, each off until a parent turns it on: its page (the first phone's, for a phone's own), and the guide's section. */
const LATER: { name: string; what: string; page: (phone: StartPhone | null) => string | null; guide: string }[] = [
  { name: "Calls", what: "who can call the kid and whom they can call, and quiet times at bedtime and school.", page: (p) => p && `/devices/${p.id}/calls`, guide: "calls-with-belay-as-the-phone-app" },
  { name: "Location", what: "where the phone is, when you check or on a schedule, with arrivals at your places.", page: (p) => p && `/devices/${p.id}/location`, guide: "location-off-by-default" },
  { name: "Network logging", what: "which websites and online services its apps look up, by name.", page: (p) => p && `/devices/${p.id}#network-logging`, guide: "network-logging-off-by-default" },
  { name: "Mobile data", what: "apps kept to Wi-Fi, and how much mobile data each app uses.", page: (p) => p && `/devices/${p.id}/mobile-data`, guide: "mobile-data-off-by-default" },
  { name: "Caregivers", what: "a grandparent's or a babysitter's own sign-in, for a while.", page: () => "/caregivers", guide: "someone-else-looking-after-the-kid" },
  { name: "The family agreement", what: "your rules in your words, which your kid can agree to or ask to talk about.", page: (p) => p && `/devices/${p.id}/agreement`, guide: "talk-about-it" },
];

export const GettingStartedCard: FC<{ view: View; start: GettingStarted }> = ({ view, start }) => (
  <section class="card start" id="start" aria-labelledby="start-title">
    <h2 id="start-title" class="in-card">
      Getting started
    </h2>
    <p>
      Setting Belay up, step by step: {progress(start.essential)}. Each tick comes from what the server sees, and this card hides itself once the
      essential ones are done. <a href={GUIDE}>The whole path, in the guide</a>.
    </p>
    <ol class="start-steps" role="list">
      {start.steps.map((step) => (
        <StepItem view={view} step={step} />
      ))}
    </ol>
    <h3>When you're ready</h3>
    <p class="small muted">
      Each is off until you turn it on.{start.phone ? "" : " A phone's own parts are on its pages, once it's added."}
    </p>
    <ul class="later small">
      {LATER.map((part) => {
        const page = part.page(start.phone);
        return (
          <li>
            {page ? <a href={page}>{part.name}</a> : <strong>{part.name}</strong>}: {part.what}{" "}
            <a href={`${GUIDE}#${part.guide}`} aria-label={`${part.name}, in the guide`}>
              In the guide
            </a>
          </li>
        );
      })}
    </ul>
    <form method="post" action="/start/hide" class="row">
      <Csrf view={view} />
      <button type="submit" class="quiet">
        Hide Getting started
      </button>
      <span class="small muted">Only on your Phones page. Settings brings it back.</span>
    </form>
  </section>
);

/** Settings, under Your account: bringing Getting started back, once this parent hid it while a step was left. */
export const StartHiddenCard: FC<{ view: View }> = ({ view }) => (
  <div class="card" id="start">
    <p>Getting started is hidden on your Phones page: the steps of setting Belay up, with the ones done ticked.</p>
    <PostButton view={view} action="/start/show" kind="quiet">
      Show Getting started again
    </PostButton>
  </div>
);
