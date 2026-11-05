import { expect, test } from "bun:test";
import { redactCredentials, redactValue } from "./redact.ts";

const fake = (...pieces: string[]) => pieces.join("");
const accessKeyId = fake("AKIA", "ZZZZ", "FAKE", "2345", "6789");
const sessionKeyId = fake("ASIA", "ZZZZ", "FAKE", "9876", "5432");
const secretKey = fake("wJalr", "FAKEsecret", "/K7MDENG", "+bPxRfiCY", "Fake42");
const sessionToken = fake("IQoJb3Jp", "Z2luX2Vj", "FAKEtoken", "Fake43==");
const keyHeader = (kind: string) => fake("-----", kind, " RSA PRI", "VATE KEY-----");
const keyBody = fake("MIIEow", "IBAAKCAQEA", "Fake42body", "x7Q2l9Zk");

const leaks = (output: string, ...secrets: string[]) => secrets.filter((secret) => output.includes(secret));

test("a double-quoted assignment that spans lines is redacted whole", () => {
  const output = redactCredentials('TOKEN="first-Fake42\nsecond-Fake43" && next');
  expect(leaks(output, "Fake42", "Fake43")).toEqual([]);
  expect(output).toBe("TOKEN=[redacted credential] && next");
});

test("single-quoted, spaced, escaped, and exported assignments are redacted", () => {
  const output = redactCredentials([
    "export API_TOKEN='one-Fake42\ntwo-Fake43'",
    'client_secret = "spaced-Fake44"',
    String.raw`echo "DB_PASSWORD=\"escaped-Fake45\""`,
    "export GITHUB_TOKEN=plain-Fake46",
    "--api-key=flag-Fake47",
  ].join("\n"));
  expect(leaks(output, "Fake42", "Fake43", "Fake44", "Fake45", "Fake46", "Fake47")).toEqual([]);
  expect(output).toContain("export API_TOKEN=[redacted credential]");
  expect(output).toContain("export GITHUB_TOKEN=[redacted credential]");
});

test("a JSON text is decoded, every string in it is redacted, and it is serialized again", () => {
  const command = JSON.stringify({ command: 'TOKEN="quoted-Fake42" bun run deploy', env: { NPM_TOKEN: "npm-Fake43", key: "Enter" } });
  const output = redactCredentials(command);
  expect(leaks(output, "Fake42", "Fake43")).toEqual([]);
  expect(JSON.parse(output)).toEqual({ command: "TOKEN=[redacted credential] bun run deploy", env: { NPM_TOKEN: "[redacted credential]", key: "[redacted credential]" } });
});

test("a private key block is redacted whole, also when it sits escaped inside nested JSON", () => {
  const block = `${keyHeader("BEGIN")}\n${keyBody}\n${keyBody}\n${keyHeader("END")}`;
  expect(redactCredentials(`key:\n${block}\nafter`)).toBe("key:\n[redacted private key]\nafter");
  const nested = JSON.stringify({ output: JSON.stringify({ files: [{ name: "id_rsa", text: block }] }) });
  const output = redactCredentials(nested);
  expect(leaks(output, "Fake42body", "PRIVATE KEY")).toEqual([]);
  expect(JSON.parse(JSON.parse(output).output)).toEqual({ files: [{ name: "id_rsa", text: "[redacted private key]" }] });
  const escaped = `cat key.json → {"pem": "${block.replaceAll("\n", "\\n")}", "next": 1`;
  expect(leaks(redactCredentials(escaped), "Fake42body", "PRIVATE KEY")).toEqual([]);
  expect(redactCredentials(escaped)).toContain('"next": 1');
});

test("AWS access key ids, secret keys, session tokens, and STS text output are redacted", () => {
  const sts = `CREDENTIALS\t${sessionKeyId}\t2026-11-05T05:10:00Z\t${secretKey}\t${sessionToken}`;
  const output = redactCredentials([
    `aws_access_key_id = ${accessKeyId}`,
    `aws_secret_access_key = ${secretKey}`,
    `aws configure set aws_session_token ${sessionToken}`,
    `AWS_SECRET_ACCESS_KEY=${secretKey}`,
    sts,
  ].join("\n"));
  expect(leaks(output, accessKeyId, sessionKeyId, secretKey, sessionToken)).toEqual([]);
  expect(output).toContain("CREDENTIALS\t[redacted AWS access key id]\t2026-11-05T05:10:00Z\t[redacted credential]\t[redacted credential]");
  const json = redactCredentials(JSON.stringify({ Credentials: { AccessKeyId: sessionKeyId, SecretAccessKey: secretKey, SessionToken: sessionToken, Expiration: "2026-11-05T05:10:00Z" } }));
  expect(leaks(json, sessionKeyId, secretKey, sessionToken)).toEqual([]);
  expect(JSON.parse(json)).toEqual({ Credentials: "[redacted credential]" });
});

test("comparisons, identifiers, member expressions, and substitutions stay as they are", () => {
  const code = [
    "if (key===expected) return value;",
    "const key=event.key",
    "if (token!=previous || auth<=limit || secret>=floor || key==other) return;",
    "const token=options.token; apiKey=readKey(); PASSWORD=$DB_PASSWORD TOKEN=\"$GH_TOKEN\" SECRET=${SECRET}",
    "const tokens = countTokens(text); if (key === secret) return;",
  ].join("\n");
  expect(redactCredentials(code)).toBe(code);
});

test("redaction is idempotent, so a second pass leaves the marks alone", () => {
  const once = redactCredentials(`API_KEY=plain-Fake42 Authorization: Bearer bearer-Fake43 ${accessKeyId}`);
  expect(redactCredentials(once)).toBe(once);
  expect(redactValue({ text: once, access_token: "[redacted credential]" })).toEqual({ text: once, access_token: "[redacted credential]" });
});

const word = (...pieces: string[]) => pieces.join("");
const hunter = word("hun", "ter");
const jwt = word("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJGYWtlNDIifQ", ".", "c2lnRmFrZTQy_x-y");

test("finding 1: a value under a secret-sounding name is redacted by default, in every assignment shape", () => {
  const output = redactCredentials([
    `PASSWORD=${hunter}`,
    `SECRET="\${MISSING:-fallback-1234}"`,
    `db_pwd=${hunter}A`,
    `session_cookie=${hunter}B`,
    `"auth": "${hunter}C"`,
    `{ apiKey: '${hunter}D' }`,
    `password: ${hunter}E`,
    `  - client_secret: ${hunter}F`,
    `deploy --api-key=${hunter}G`,
  ].join("\n"));
  expect(leaks(output, hunter, "fallback-1234")).toEqual([]);
  expect(output.split("\n")).toEqual([
    "PASSWORD=[redacted credential]",
    "SECRET=[redacted credential]",
    "db_pwd=[redacted credential]",
    "session_cookie=[redacted credential]",
    '"auth": "[redacted credential]"',
    "{ apiKey: '[redacted credential]' }",
    "password: [redacted credential]",
    "  - client_secret: [redacted credential]",
    "deploy --api-key=[redacted credential]",
  ]);
  expect(redactCredentials(JSON.stringify({ password: hunter }))).toBe('{"password":"[redacted credential]"}');
  expect(redactCredentials(JSON.stringify({ env: { key: "Enter", NODE_ENV: "production" } }))).toBe('{"env":{"key":"[redacted credential]","NODE_ENV":"production"}}');
});

test("finding 2: a spaced, unquoted assignment is redacted, and comparisons are not", () => {
  const output = redactCredentials(`PASSWORD = ${hunter}2\napi_key = unquoted-123456\nif (key == other || token != last || auth <= cap || secret >= floor || key === mine) {}`);
  expect(leaks(output, hunter, "unquoted-123456")).toEqual([]);
  expect(output).toBe("PASSWORD = [redacted credential]\napi_key = [redacted credential]\nif (key == other || token != last || auth <= cap || secret >= floor || key === mine) {}");
});

test("finding 3: a header name inside JSON hides its value whatever its length or characters", () => {
  const headers = { Authorization: "Bearer abc", "Proxy-Authorization": "Basic x", Cookie: "a=b", "set-cookie": ["sid=1", "t=2"], "X-Goog-Api-Key": "k.v", "x-auth-token": "options.token", Accept: "text/html" };
  const output = redactCredentials(JSON.stringify({ request: { headers } }));
  expect(JSON.parse(output).request.headers).toEqual({
    Authorization: "[redacted credential]", "Proxy-Authorization": "[redacted credential]", Cookie: "[redacted credential]",
    "set-cookie": "[redacted credential]", "X-Goog-Api-Key": "[redacted credential]", "x-auth-token": "[redacted credential]", Accept: "text/html",
  });
});

test("finding 4: curl user passwords, secret-named flags with a separate value, and .netrc passwords are redacted", () => {
  const output = redactCredentials([
    `curl -u admin:${hunter}1 https://api.example.com`,
    `curl --user 'admin:${hunter}2' https://api.example.com`,
    `curl -uadmin:${hunter}3 https://api.example.com`,
    `curl --user=admin:${hunter}4 https://api.example.com`,
    `gh-like --token tok0042tok --password ${hunter}5 --verbose`,
    `machine api.example.com login admin password ${hunter}6`,
    "machine git.example.com",
    "  login admin",
    `  passwd ${hunter}7`,
    `password ${hunter}8`,
  ].join("\n"));
  expect(leaks(output, hunter, "tok0042tok")).toEqual([]);
  expect(output.split("\n")).toEqual([
    "curl -u admin:[redacted credential] https://api.example.com",
    "curl --user 'admin:[redacted credential]' https://api.example.com",
    "curl -uadmin:[redacted credential] https://api.example.com",
    "curl --user=admin:[redacted credential] https://api.example.com",
    "gh-like --token [redacted credential] --password [redacted credential] --verbose",
    "machine api.example.com login admin password [redacted credential]",
    "machine git.example.com",
    "  login admin",
    "  passwd [redacted credential]",
    "password [redacted credential]",
  ]);
  expect(redactCredentials("git push -u origin main && sort -u list.txt")).toBe("git push -u origin main && sort -u list.txt");
});

test("finding 5: a bare JWT is redacted anywhere", () => {
  const output = redactCredentials(`the session was ${jwt} until noon; cookie jar: [${jwt}]`);
  expect(leaks(output, jwt, "c2lnRmFrZTQy")).toEqual([]);
  expect(output).toBe("the session was [redacted JWT] until noon; cookie jar: [[redacted JWT]]");
});

test("finding 7: member and call expressions with digits, and pure substitutions, stay as they are", () => {
  const code = [
    "const key=event.key1;",
    "const apiKey=deriveKey2();",
    "const tokens = countTokens(text);",
    "if (key===expected) return value;",
    "PORT=8080 TOKEN=$GH_TOKEN SECRET=${SECRET} PASSWORD=$(cat ~/.pw) deploy --token \"$TOKEN\"",
    "git clone ssh://git@host/owner/repo.git",
  ].join("\n");
  expect(redactCredentials(code)).toBe(code);
});

test("the third-round shapes are idempotent", () => {
  const once = redactCredentials(`PASSWORD = ${hunter}\npassword: ${hunter}\ncurl -u a:${hunter} --token ${hunter}\nmachine h login u password ${hunter}\n${jwt}`);
  expect(leaks(once, hunter)).toEqual([]);
  expect(redactCredentials(once)).toBe(once);
});

const hidden = "[redacted credential]";
const cookies = [fake("theme", "=light"), fake("sessionid=", "fakeSession42"), fake("csrftoken=", "fakeCsrf43")].join("; ");
const bearer = fake("Bearer ", "fake", "Bearer44", ".x");
const basic = fake("Basic ", "dXNl", "cjpGYWtl", "NDU=");
const headerSecrets = ["light", "fakeSession42", "fakeCsrf43", "Bearer44", "cjpGYWtl", "Digest46"];

test("final finding 1: a Cookie, Set-Cookie, Authorization, or Proxy-Authorization header is redacted whole, quoted or not", () => {
  const output = redactCredentials([
    `curl -H "Cookie: ${cookies}" https://api.example.com`,
    `curl -H 'Set-Cookie: ${cookies}; Path=/; HttpOnly' https://api.example.com`,
    `curl -H "Authorization: ${bearer} extra" -H "Proxy-Authorization: ${basic}" https://api.example.com`,
    `Cookie: ${cookies}`,
    `set-cookie: ${cookies}; Secure`,
    `  proxy-authorization: Digest username="u", response="${fake("fake", "Digest46")}"`,
    String.raw`{"command": "curl -H \"Cookie: ${cookies}\" https://api.example.com", "next": 1`,
  ].join("\n"));
  expect(leaks(output, ...headerSecrets)).toEqual([]);
  expect(output.split("\n")).toEqual([
    `curl -H "Cookie: ${hidden}" https://api.example.com`,
    `curl -H 'Set-Cookie: ${hidden}' https://api.example.com`,
    `curl -H "Authorization: ${hidden}" -H "Proxy-Authorization: ${hidden}" https://api.example.com`,
    `Cookie: ${hidden}`,
    `set-cookie: ${hidden}`,
    String.raw`{"command": "curl -H \"Cookie: ${hidden}\" https://api.example.com", "next": 1`,
  ]);
  expect(redactCredentials(output)).toBe(output);
});

test("final finding 1: a whole header is redacted inside decoded JSON too, and a second pass changes nothing", () => {
  const output = redactCredentials(JSON.stringify({ command: `curl -H "Cookie: ${cookies}" -H 'Authorization: ${bearer}' https://api.example.com`, headers: { Cookie: cookies } }));
  expect(leaks(output, ...headerSecrets)).toEqual([]);
  expect(JSON.parse(output)).toEqual({ command: `curl -H "Cookie: ${hidden}" -H 'Authorization: ${hidden}' https://api.example.com`, headers: { Cookie: hidden } });
  expect(redactCredentials(output)).toBe(output);
});

test("final finding 2: a number or boolean under a secret name is redacted, and other scalars stay", () => {
  const pin = Number(fake("8675", "309"));
  expect(redactValue({ password: pin, access_token: [pin, pin], "x-api-key": pin, auth: true, retries: 3, verbose: false, token: null })).toEqual({
    password: hidden, access_token: hidden, "x-api-key": hidden, auth: hidden, retries: 3, verbose: false, token: null,
  });
  const once = redactCredentials(JSON.stringify({ password: pin, nested: { pin_token: pin } }));
  expect(once).toBe(`{"password":"${hidden}","nested":{"pin_token":"${hidden}"}}`);
  expect(redactCredentials(once)).toBe(once);
});

test("final finding 2: a number or boolean under a quoted secret name in plain text is redacted, and a second pass changes nothing", () => {
  const pin = fake("8675", "309");
  const once = redactCredentials(String.raw`exit code 1 {"password": ${pin}, "auth":true, "retries": 3} and {\"access_token\":${pin}}`);
  expect(once).toBe(String.raw`exit code 1 {"password": "${hidden}", "auth":"${hidden}", "retries": 3} and {\"access_token\":\"${hidden}\"}`);
  expect(redactCredentials(once)).toBe(once);
});

const folded = fake("sessionid=", "fakeFolded", "99117");
const digestResponse = fake("fake", "Digest", "77118");

test("recheck finding 1: a quoted header is redacted up to its closing quote across lines, and a raw header with every folded line after it", () => {
  const output = redactCredentials([
    `Cookie: theme=light;\r\n\t${folded}`,
    `curl -H 'Cookie: theme=light;\n  ${folded}' https://api.example.com`,
    `curl -H "Authorization: Digest username=\\"u\\",\n  response=\\"${digestResponse}\\"" https://api.example.com`,
    String.raw`{"command": "curl -H \"Cookie: theme=light;\n\t${folded}\" https://api.example.com", "next": 1`,
    `Authorization: Digest username="u",\n  response="${digestResponse}"`,
    `Cookie:\n\t${folded}`,
    "Host: example.com",
  ].join("\n"));
  expect(leaks(output, "fakeFolded", digestResponse)).toEqual([]);
  expect(output.split("\n")).toEqual([
    `Cookie: ${hidden}`,
    `curl -H 'Cookie: ${hidden}' https://api.example.com`,
    `curl -H "Authorization: ${hidden}" https://api.example.com`,
    String.raw`{"command": "curl -H \"Cookie: ${hidden}\" https://api.example.com", "next": 1`,
    `Authorization: ${hidden}`,
    `Cookie:${hidden}`,
    "Host: example.com",
  ]);
  expect(redactCredentials(output)).toBe(output);
});

test("recheck finding 2: a secret name hides its whole value, scalar, array or object, in parsed JSON", () => {
  const pin = Number(fake("8675", "309"));
  const other = Number(fake("1234", "5678"));
  const deep = fake("fake", "Nested", "55");
  expect(redactValue({
    password: [{ value: pin }], access_token: [pin, other], credentials: { user: "u", inner: { value: deep } }, auth: { list: [pin] },
    session: { cookie: [{ value: deep }] }, retries: [3, 4], token: null,
  })).toEqual({ password: hidden, access_token: hidden, credentials: hidden, auth: hidden, session: { cookie: hidden }, retries: [3, 4], token: null });
  const once = redactCredentials(JSON.stringify({ request: { password: [{ value: pin }], api_key: [pin, other], note: "ok" } }));
  expect(once).toBe(`{"request":{"password":"${hidden}","api_key":"${hidden}","note":"ok"}}`);
  expect(redactCredentials(once)).toBe(once);
});

test("recheck finding 2: a secret name hides its whole array or object in JSON inside text, escaped, single-quoted, multi-line, or cut off", () => {
  const pin = fake("8675", "309");
  const other = fake("1234", "5678");
  const text = [
    `exit code 1 {"access_token":[${pin},${other}],"retries":3}`,
    `then {"password": [{"value": ${pin}}], "note": "ok"}`,
    String.raw`and {\"secret\":{\"v\":\"a]b\",\"n\":[${pin}]},\"next\":1}`,
    `and {'auth_key': [${pin}], 'next': 2}`,
    `{"credentials": {\n  "user": "u",\n  "pin": ${pin}\n}, "after": true}`,
    `last {"token": [${other}, `,
  ].join("\n");
  const once = redactCredentials(text);
  expect(leaks(once, pin, other)).toEqual([]);
  expect(once.split("\n")).toEqual([
    `exit code 1 {"access_token":"${hidden}","retries":3}`,
    `then {"password": "${hidden}", "note": "ok"}`,
    String.raw`and {\"secret\":\"${hidden}\",\"next\":1}`,
    `and {'auth_key': '${hidden}', 'next': 2}`,
    `{"credentials": "${hidden}", "after": true}`,
    `last {"token": "${hidden}"`,
  ]);
  expect(redactCredentials(once)).toBe(once);
});
