import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAuthUrlFromCredentials } from '../dist/gmail-client.js';

const sampleCredentials = {
  installed: {
    client_id: 'client-id',
    client_secret: 'client-secret',
    redirect_uris: ['http://localhost'],
  },
};

test('begin auth requests Gmail scopes only (no Drive, Sheets, Docs, or Calendar)', () => {
  const { authUrl } = generateAuthUrlFromCredentials(sampleCredentials);
  const url = new URL(authUrl);
  const scopes = url.searchParams.get('scope') ?? '';

  // Gmail scopes we keep.
  assert.match(scopes, /https:\/\/mail\.google\.com\//);
  assert.match(scopes, /https:\/\/www\.googleapis\.com\/auth\/gmail\.settings\.basic/);

  // Scopes removed in this fork must never be requested.
  assert.doesNotMatch(scopes, /https:\/\/www\.googleapis\.com\/auth\/drive/);
  assert.doesNotMatch(scopes, /https:\/\/www\.googleapis\.com\/auth\/spreadsheets/);
  assert.doesNotMatch(scopes, /https:\/\/www\.googleapis\.com\/auth\/documents/);
  assert.doesNotMatch(scopes, /https:\/\/www\.googleapis\.com\/auth\/calendar/);

  assert.notEqual(url.searchParams.get('include_granted_scopes'), 'true');
});
