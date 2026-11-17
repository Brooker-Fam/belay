/**
 * Stages: named sets of screen-time rules the family makes, so loosening is a visible step the
 * kid works toward. Each stage's page edits its rules (every phone on it gets them at once) and
 * shows what it changes from the stage before, as the kid sees it on the phone.
 */
import type { FC } from "hono/jsx";
import type { StageView } from "../../family/screentime/rules.js";
import { STAGE_LIMITS } from "../../family/screentime/changes.js";
import type { Labels } from "../../family/screentime/words.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";
import { type AppChoice, LimitsCard, OtherRulesCard, Preview, SchedulesCard } from "./screentime.js";

export interface StageSummary {
  stage: StageView;
  phones: { id: string; name: string }[];
}

const summary = (s: StageView) =>
  s.offBelay
    ? "The last stage: it blocks nothing"
    : `${s.rules.limits.length} limit${s.rules.limits.length === 1 ? "" : "s"}, ${s.rules.schedules.length} schedule${s.rules.schedules.length === 1 ? "" : "s"}`;

export const StagesPage: FC<{
  view: View;
  stages: StageSummary[];
  /** Phones whose rules a new stage can start from. */
  phones: { id: string; name: string }[];
  message?: string;
  error?: string;
}> = ({ view, stages, phones, message, error }) => (
  <Layout view={view} title="Stages">
    <h1>Stages</h1>
    <p class="muted">
      Stages bundle screen-time rules into named steps, so a change is a step the kid works toward: stage 1 first, then the next. Each phone on a stage
      gets its rules at once, and its own changes on top. The phone shows the kid its stage, what the next one changes, and how to get there in your
      words. Only a parent moves a phone to another stage; AI apps can only propose it. Every family's list ends with Off belay: it blocks nothing,
      and the kid's phone shows it, with your words for when it comes, from the first day.
    </p>
    {message && <Notice>{message}</Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    {stages.length === 0 && <p class="muted">No stages yet.</p>}
    {stages.map(({ stage, phones: on }) => (
      <a class="card" href={`/stages/${stage.id}`}>
        <div class="row spread">
          <strong>
            {stage.number}. {stage.name}
          </strong>
          <span class="small muted">{summary(stage)}</span>
        </div>
        <p class="small muted">{on.length ? `On it: ${on.map((p) => p.name).join(", ")}` : "No phone is on it."}</p>
      </a>
    ))}
    <h2>Add a stage</h2>
    <form class="card stack" method="post" action="/stages">
      <Csrf view={view} />
      <label for="stage-name">Name</label>
      <input id="stage-name" type="text" name="name" maxlength={STAGE_LIMITS.name} required placeholder="Explorer" />
      <label for="stage-how">How to reach it, in your words, shown to the kid at the stage before (optional)</label>
      <textarea id="stage-how" name="how" maxlength={STAGE_LIMITS.how} placeholder="A month of keeping to the limits"></textarea>
      <label for="stage-from">Start from</label>
      <select id="stage-from" name="from">
        <option value="">No rules</option>
        {stages
          .filter(({ stage }) => !stage.offBelay)
          .map(({ stage }) => (
            <option value={`stage:${stage.id}`}>The rules of {stage.name}</option>
          ))}
        {phones.map((p) => (
          <option value={`phone:${p.id}`}>{p.name}'s rules now</option>
        ))}
      </select>
      <p>
        <button type="submit">Add the stage</button>
      </p>
    </form>
  </Layout>
);

export const StagePage: FC<{
  view: View;
  stage: StageView;
  phones: { id: string; name: string }[];
  /** What it changes from the stage before, as the kid sees it; null for the first stage. */
  fromBefore: { name: string; unlocks: string[] } | null;
  apps: AppChoice[];
  labels: Labels;
  message?: string;
  error?: string;
}> = ({ view, stage, phones, fromBefore, apps, labels, message, error }) => {
  if (stage.offBelay) return <OffBelayPage view={view} stage={stage} phones={phones} fromBefore={fromBefore} message={message} error={error} />;
  const base = `/stages/${stage.id}`;
  const editor = { view, base, rules: stage.rules, apps, labels };
  return (
    <Layout view={view} title={stage.name}>
      <p class="small">
        <a href="/stages">Stages</a>
      </p>
      <h1>
        {stage.number}. {stage.name}
      </h1>
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <p class="muted small">
        {phones.length ? `On it: ${phones.map((p) => p.name).join(", ")}. A change here reaches them within seconds.` : "No phone is on it yet."} Changed{" "}
        <Time ms={stage.updatedAt} tz={view.tz} />
        {stage.updatedBy && ` by ${stage.updatedBy}`}.
      </p>
      <div class="card">
        <Preview rules={stage.rules} />
        {fromBefore && (
          <>
            <p class="small">What it changes from {fromBefore.name}, as the kid sees it:</p>
            {fromBefore.unlocks.length ? (
              <ul class="small">
                {fromBefore.unlocks.map((u) => (
                  <li>{u}</li>
                ))}
              </ul>
            ) : (
              <p class="small muted">Nothing in the rules.</p>
            )}
          </>
        )}
      </div>
      <h2>Name and place</h2>
      <form class="card stack" method="post" action={base}>
        <Csrf view={view} />
        <label for="stage-name">Name</label>
        <input id="stage-name" type="text" name="name" maxlength={STAGE_LIMITS.name} value={stage.name} required />
        <label for="stage-number">Number (1 is the first stage; a number another stage has swaps them)</label>
        <input id="stage-number" type="number" name="number" min={1} max={99} value={String(stage.number)} required />
        <label for="stage-how">How to reach it, in your words, shown to the kid at the stage before</label>
        <textarea id="stage-how" name="how" maxlength={STAGE_LIMITS.how}>
          {stage.how ?? ""}
        </textarea>
        <p>
          <button type="submit">Save</button>
        </p>
      </form>
      <h2>Time limits</h2>
      <LimitsCard {...editor} />
      <h2>Schedules</h2>
      <SchedulesCard {...editor} />
      <h2>Exempt apps, self-serve and more</h2>
      <OtherRulesCard {...editor} />
      <h2>Delete</h2>
      <div class="card danger-zone">
        {phones.length ? (
          <p class="muted">Move {phones.length === 1 ? "the phone" : "the phones"} on it to another stage first.</p>
        ) : (
          <PostButton view={view} action={`${base}/delete`} kind="danger" confirm={`Delete the stage ${stage.name}?`}>
            Delete this stage
          </PostButton>
        )}
      </div>
    </Layout>
  );
};

/**
 * Phase 11: Off belay, every family's last stage. It blocks nothing, keeps its name and place, and
 * can't be deleted; the family writes when it comes, which the kid's phone shows from the first day.
 */
const OffBelayPage: FC<{
  view: View;
  stage: StageView;
  phones: { id: string; name: string }[];
  fromBefore: { name: string; unlocks: string[] } | null;
  message?: string;
  error?: string;
}> = ({ view, stage, phones, fromBefore, message, error }) => (
  <Layout view={view} title={stage.name}>
    <p class="small">
      <a href="/stages">Stages</a>
    </p>
    <h1>
      {stage.number}. {stage.name}
    </h1>
    {message && <Notice>{message}</Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    <p>
      The last stage, the one every family's list ends with: the kid outgrows Belay, and the phone becomes simply theirs. On it, a phone has no time
      limits or schedules. Then you can stop collecting, and hand the phone over, on its page. Moving a phone here is yours alone: AI apps can't,
      not even as a proposal.
    </p>
    <p class="muted small">
      {phones.length ? `On it: ${phones.map((p) => p.name).join(", ")}.` : "No phone is on it yet."} Changed <Time ms={stage.updatedAt} tz={view.tz} />
      {stage.updatedBy && ` by ${stage.updatedBy}`}.
    </p>
    {fromBefore && (
      <div class="card">
        <p class="small">What it changes from {fromBefore.name}, as the kid sees it:</p>
        {fromBefore.unlocks.length ? (
          <ul class="small">
            {fromBefore.unlocks.map((u) => (
              <li>{u}</li>
            ))}
          </ul>
        ) : (
          <p class="small muted">Nothing in the rules.</p>
        )}
      </div>
    )}
    <h2>When it comes, in your words</h2>
    <form class="card stack" method="post" action={`/stages/${stage.id}`}>
      <Csrf view={view} />
      <label for="stage-how">
        Every phone shows these words from the first day, in "My stage": "Last stage: {stage.name}." and then yours, like "When you turn 16", or
        "When you've kept the agreement for a year".
      </label>
      <textarea id="stage-how" name="how" maxlength={STAGE_LIMITS.how}>
        {stage.how ?? ""}
      </textarea>
      <p>
        <button type="submit">Save</button>
      </p>
    </form>
  </Layout>
);
