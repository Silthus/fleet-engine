export const esc = (text: unknown) => String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const fmt = (text: string) => esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");

export const t3Link = (prompt: string) => `https://app.t3.codes/new?prompt=${encodeURIComponent(prompt)}`;

const pickLine = /^(- [^:]+: |Add th(?:is|ese) Fleet packs? to my setup with me: )(.*)$/;
const commandLine = /^( +)(fleet packs --add .*)$/;

export function promptHtml(text: string, before: string[] = []) {
  return text
    .split("\n")
    .map((line) => {
      const parts = line.match(pickLine) ?? line.match(commandLine);
      const body = parts ? `${esc(parts[1])}<span class="tok">${esc(parts[2])}</span>` : esc(line);
      return before.length && !before.includes(line) ? `<span class="fresh">${body}</span>` : body;
    })
    .join("\n");
}
