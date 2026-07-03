import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEmailBody, stripHtmlTags } from '../dist/gmail-client.js';

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

test('extractEmailBody returns full text/plain body from multipart/alternative', () => {
  const body = 'We have ants coming from the church into the lounge. Heat perhaps. '.repeat(30);
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url(body) } },
      { mimeType: 'text/html', body: { data: b64url(`<p>${body}</p>`) } },
    ],
  };
  assert.equal(extractEmailBody(payload), body);
});

test('extractEmailBody concatenates text parts split by inline images', () => {
  // Apple Mail with an inline image splits the body around the image
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('Before the image, heat perhaps. W') } },
          { mimeType: 'image/png', filename: 'photo.png', body: { attachmentId: 'att1' } },
          { mimeType: 'text/plain', body: { data: b64url('e also wanted an update on the land registration.') } },
        ],
      },
    ],
  };
  const result = extractEmailBody(payload);
  assert.ok(result.includes('Before the image'), 'first part present');
  assert.ok(result.includes('update on the land registration'), 'text after inline image present');
});

test('extractEmailBody preserves document order for nested parts', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/plain', body: { data: b64url('first') } }],
      },
      { mimeType: 'text/plain', body: { data: b64url('second') } },
    ],
  };
  assert.equal(extractEmailBody(payload), 'first\nsecond');
});

test('extractEmailBody skips text/plain attachments (filename present)', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: b64url('the actual body') } },
      { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64url('attachment contents') } },
    ],
  };
  assert.equal(extractEmailBody(payload), 'the actual body');
});

test('extractEmailBody strips tags from single-part text/html message', () => {
  const payload = {
    mimeType: 'text/html',
    body: { data: b64url('<html><head><style>p{color:red}</style></head><body><p>Hi Steve</p></body></html>') },
  };
  assert.equal(extractEmailBody(payload), 'Hi Steve');
});

test('extractEmailBody falls back to stripped HTML when no text/plain part', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/html', body: { data: b64url('<div>Hello &amp; welcome</div>') } }],
  };
  assert.equal(extractEmailBody(payload), 'Hello & welcome');
});

test('stripHtmlTags removes style/script/head content', () => {
  const html = '<head><title>x</title><style>body { margin: 0; }</style></head><script>alert(1)</script><p>Visible text</p>';
  assert.equal(stripHtmlTags(html), 'Visible text');
});

test('stripHtmlTags preserves line structure', () => {
  const html = '<p>Line one</p><p>Line two</p>Line three<br>Line four';
  const result = stripHtmlTags(html);
  assert.deepEqual(result.split('\n').map((l) => l.trim()).filter(Boolean), [
    'Line one',
    'Line two',
    'Line three',
    'Line four',
  ]);
});

test('stripHtmlTags decodes entities', () => {
  assert.equal(stripHtmlTags('Tom &amp; Jerry &lt;3 &quot;cheese&quot;'), 'Tom & Jerry <3 "cheese"');
  assert.equal(stripHtmlTags('caf&#233; &#x1F41C;'), 'café \u{1F41C}');
  assert.equal(stripHtmlTags('a&nbsp;b'), 'a b');
});

test('stripHtmlTags does not double-decode &amp;lt;', () => {
  assert.equal(stripHtmlTags('&amp;lt;'), '&lt;');
});
