// The return paths a sign-in may and may not go back to (docs/specs/m4-sign-in.md section 2, Proof). One list for
// the page's safeReturn (tests/studio-auth.test.mjs) and the issuer that runs it on return= (apps/server
// test/identity.test.mjs), so the two can never drift apart.
export const ALLOWED = ['/', '/#chat', '/account', '/t/acme/cards/card_1?x=1#a', '/a/b%20c', '/v0.9.2/notes', '/a.b/c', '/...', '/?q=../x'];
export const REFUSED = [
  '//evil.example', '/\\evil.example', '\\\\evil', '/%2F%2Fevil.example', '/%2f%2fevil', '/%5Cevil', '/%5c%5cevil', '/a%2F..%2F..',
  '/%252F%252Fevil', 'https://evil.example', 'javascript:alert(1)', 'evil.example', '', ' /', '/\tx', '/\nevil', '/%0d%0aSet-Cookie:x',
  '/%00', '/%7f', '/.//evil.com', '/a/..//evil.com', '/..//evil.com', '/a/../%2e%2e//evil.com', '/./x', '/a/.', '/%2e/x', '/%2E%2E/x', '/a/..?x', `/${'a'.repeat(3000)}`, null, undefined, 42,
];
