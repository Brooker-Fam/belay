/**
 * Text from the kid or an app developer, made safe to keep and show: control characters
 * (except new lines) and the characters that hide or reorder text are removed, and it's capped.
 * Pages escape it as well; this keeps a label from rearranging what's around it.
 */
export function cleanText(value: string, max: number): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u{0}-\u{9}\u{b}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu, "")
    .trim()
    .slice(0, max);
}

/** The same, on one line: new lines become spaces. For notices and short labels. */
export function oneLine(value: string, max: number): string {
  return cleanText(value.replace(/\s*\n\s*/g, " "), max);
}

/**
 * Whether a name a parent typed to confirm something (a hand-over, the locks that can strand a
 * phone) is the phone's name, as a person means it: case, spaces around and between words, and the
 * curly quotes a phone's keyboard puts in for ' and " don't count. "Sam’s  phone" is "Sam's phone".
 */
export function sameName(typed: string, name: string): boolean {
  const plain = (value: string) =>
    value
      .normalize("NFKC")
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const want = plain(name);
  return want.length > 0 && plain(typed) === want;
}
