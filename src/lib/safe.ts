/**
 * JSON for inline <script> tags (JSON-LD, #st-hours, #st-avail). JSON.stringify alone lets a value such as a Square
 * item name `</script><script>…` close the tag and run code (QA 2026-10-28). `<`, `>`, `&` and U+2028/U+2029 become
 * \uXXXX escapes, which every JSON parser reads back as the same characters. Use with `set:html`.
 */
const UNSAFE = new RegExp('[<>&\\u2028\\u2029]', 'g');

export function jsonForScript(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(UNSAFE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
