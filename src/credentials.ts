export function withoutCredentials(line: string) {
  return line.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, (address) => {
    try {
      const url = new URL(address);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`;
    } catch {
      return "the remote";
    }
  });
}
