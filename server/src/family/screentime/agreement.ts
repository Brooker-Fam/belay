/**
 * The family agreement, per phone and in versions: the family's own words, in sections (at most
 * 20 of 2000 characters). The parents agree to a version as they save it; the kid reads it on the
 * phone and answers "I agree" or "I want to talk about it" (an `agreement` request). A new version
 * asks the kid again. Reads and writes only: saving one goes through changes.ts.
 */
import type { DB } from "../../db.js";
import type { Policy } from "../../device/schemas.js";
import { cleanText } from "../../text.js";

export const AGREEMENT_LIMITS = { sections: 20, title: 200, text: 2000 } as const;

export interface Section {
  title: string;
  text: string;
}

export interface AgreementView {
  version: number;
  sections: Section[];
  createdAt: number;
  createdBy: string | null;
  parentsAgreedAt: number | null;
  /** The kid's latest answer to this version. */
  kidAnswer: "agree" | "talk" | null;
  kidAnsweredAt: number | null;
}

interface Row {
  version: number;
  sections: string;
  created_at: number;
  created_by_name: string | null;
  parents_agreed_at: number | null;
  kid_answer: "agree" | "talk" | null;
  kid_answered_at: number | null;
}

function sectionsOf(text: string): Section[] {
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((s): Section[] => {
      const o = s as { title?: unknown; text?: unknown } | null;
      return o && typeof o.title === "string" && typeof o.text === "string" ? [{ title: o.title, text: o.text }] : [];
    });
  } catch {
    return [];
  }
}

const toView = (r: Row): AgreementView => ({
  version: r.version,
  sections: sectionsOf(r.sections),
  createdAt: r.created_at,
  createdBy: r.created_by_name,
  parentsAgreedAt: r.parents_agreed_at,
  kidAnswer: r.kid_answer,
  kidAnsweredAt: r.kid_answered_at,
});

const SELECT = "SELECT a.version, a.sections, a.created_at, p.name AS created_by_name, a.parents_agreed_at, a.kid_answer, a.kid_answered_at FROM agreements a LEFT JOIN parents p ON p.id = a.created_by";

/** Every version for the phone, newest first. */
export function agreementVersions(db: DB, deviceId: string): AgreementView[] {
  return db.prepare<[string], Row>(`${SELECT} WHERE a.device_id = ? ORDER BY a.version DESC`).all(deviceId).map(toView);
}

export function currentAgreement(db: DB, deviceId: string): AgreementView | null {
  const row = db.prepare<[string], Row>(`${SELECT} WHERE a.device_id = ? ORDER BY a.version DESC LIMIT 1`).get(deviceId);
  return row ? toView(row) : null;
}

/** The policy's `agreement`: the current version, and when the kid agreed to it (their latest answer). */
export function agreementFor(db: DB, deviceId: string): Policy["agreement"] {
  const a = currentAgreement(db, deviceId);
  if (!a) return null;
  return {
    version: a.version,
    sections: a.sections.slice(0, AGREEMENT_LIMITS.sections).map((s) => ({ title: s.title.slice(0, AGREEMENT_LIMITS.title), text: s.text.slice(0, AGREEMENT_LIMITS.text) })),
    kid_agreed_at: a.kidAnswer === "agree" ? a.kidAnsweredAt : null,
    parents_agreed_at: a.parentsAgreedAt,
  };
}

/** Sections as the family wrote them, cleaned: a section without a title or text is left out. */
export function cleanSections(sections: Section[]): Section[] {
  return sections
    .map((s) => ({ title: cleanText(s.title.replace(/\s*\n\s*/g, " "), AGREEMENT_LIMITS.title), text: cleanText(s.text, AGREEMENT_LIMITS.text) }))
    .filter((s) => s.title || s.text)
    .slice(0, AGREEMENT_LIMITS.sections);
}

/** Saves a new version, agreed by the parents as they save it. Returns its number. */
export function insertAgreement(db: DB, deviceId: string, sections: Section[], now: number, parentId: string | null): number {
  const version = (db.prepare<[string], { v: number | null }>("SELECT MAX(version) AS v FROM agreements WHERE device_id = ?").get(deviceId)?.v ?? 0) + 1;
  db.prepare("INSERT INTO agreements (device_id, version, sections, created_at, created_by, parents_agreed_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    deviceId,
    version,
    JSON.stringify(sections),
    now,
    parentId,
    now,
  );
  return version;
}

/** The kid's answer to a version, the latest one counting. False when there's no such version. */
export function recordKidAnswer(db: DB, deviceId: string, version: number, answer: "agree" | "talk", at: number): boolean {
  return (
    db
      .prepare("UPDATE agreements SET kid_answer = ?, kid_answered_at = ? WHERE device_id = ? AND version = ? AND (kid_answered_at IS NULL OR kid_answered_at <= ?)")
      .run(answer, at, deviceId, version, at).changes === 1
  );
}
