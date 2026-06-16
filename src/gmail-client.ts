import { OAuth2Client, type Credentials } from 'google-auth-library';
import { google, type gmail_v1 } from 'googleapis';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { AccountConfig, type AccountPaths, getAccountPaths } from './config.js';

export const GMAIL_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
] as const;

// Least-privilege: this fork requests Gmail scopes only. The upstream Drive,
// Sheets, Docs, and Calendar scopes have been removed so the issued OAuth token
// cannot reach those APIs.
export const GOOGLE_ACCOUNT_SCOPES = [
  ...GMAIL_SCOPES,
] as const;

export interface AttachmentMetadata {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  isInline: boolean;
}

export interface ParsedEmail {
  id: string;
  threadId: string;
  snippet: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  internalDate: number;
  messageHeaderId: string;
  inReplyTo: string;
  references: string;
  body?: string;
  labels: string[];
  attachments: AttachmentMetadata[];
  accountId: string;
  accountEmail: string;
}

export interface ParsedThread {
  threadId: string;
  messages: ParsedEmail[];
}

export interface LabelInfo {
  id: string;
  name: string;
  type?: string;
  messagesTotal?: number;
}

interface OAuthClientOptions {
  credentials: unknown;
}

export interface EmailAttachment {
  path: string;
  filename?: string;
  contentType?: string;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function decodeBase64UrlBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function isInlineDisposition(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
): boolean {
  if (!headers) return false;
  const disposition = headers.find((h) => h.name?.toLowerCase() === 'content-disposition');
  return Boolean(disposition?.value?.trim().toLowerCase().startsWith('inline'));
}

function extractAttachmentsMetadata(
  payload: gmail_v1.Schema$MessagePart | undefined,
): AttachmentMetadata[] {
  if (!payload) return [];

  const out: AttachmentMetadata[] = [];
  const consider = (part: gmail_v1.Schema$MessagePart) => {
    if (!part.filename) return;
    if (part.body?.attachmentId) {
      out.push({
        id: part.body.attachmentId,
        filename: part.filename,
        contentType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: Number(part.body.size ?? 0),
        isInline: isInlineDisposition(part.headers),
      });
    } else if (part.body?.data) {
      // Small attachment inlined by Gmail — use a synthetic ID so agents can fetch it
      out.push({
        id: `inline:${part.filename}`,
        filename: part.filename,
        contentType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: Number(part.body.size ?? 0),
        isInline: isInlineDisposition(part.headers),
      });
    }
  };

  consider(payload);

  const stack: gmail_v1.Schema$MessagePart[] = payload.parts ? [...payload.parts] : [];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;
    consider(part);
    if (part.parts?.length) stack.push(...part.parts);
  }

  return out;
}

function collectAttachmentParts(
  payload: gmail_v1.Schema$MessagePart | undefined,
): gmail_v1.Schema$MessagePart[] {
  if (!payload) return [];

  const out: gmail_v1.Schema$MessagePart[] = [];
  const consider = (part: gmail_v1.Schema$MessagePart) => {
    if (part.filename && part.body?.attachmentId && !isInlineDisposition(part.headers)) {
      out.push(part);
    }
  };

  consider(payload);
  const stack: gmail_v1.Schema$MessagePart[] = payload.parts ? [...payload.parts] : [];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;
    consider(part);
    if (part.parts?.length) stack.push(...part.parts);
  }

  return out;
}

function findAttachmentPart(
  payload: gmail_v1.Schema$MessagePart | undefined,
  attachmentId: string,
): gmail_v1.Schema$MessagePart | null {
  if (!payload) return null;
  if (payload.body?.attachmentId === attachmentId) return payload;

  const stack: gmail_v1.Schema$MessagePart[] = payload.parts ? [...payload.parts] : [];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;
    if (part.body?.attachmentId === attachmentId) return part;
    if (part.parts?.length) stack.push(...part.parts);
  }

  return null;
}

function findAttachmentPartByFilename(
  payload: gmail_v1.Schema$MessagePart | undefined,
  filename: string,
): gmail_v1.Schema$MessagePart | null {
  if (!payload) return null;
  if (payload.filename === filename && payload.body?.data) return payload;

  const stack: gmail_v1.Schema$MessagePart[] = payload.parts ? [...payload.parts] : [];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;
    if (part.filename === filename && part.body?.data) return part;
    if (part.parts?.length) stack.push(...part.parts);
  }

  return null;
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getHeaderValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string {
  if (!headers) return '';
  const found = headers.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return found?.value?.trim() ?? '';
}

function extractEmailBody(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return '';

  if (payload.body?.data && !payload.parts?.length) {
    return decodeBase64Url(payload.body.data);
  }

  if (!payload.parts || payload.parts.length === 0) {
    return '';
  }

  let textPlain = '';
  let textHtml = '';

  const stack = [...payload.parts];
  while (stack.length > 0) {
    const part = stack.shift();
    if (!part) continue;

    if (part.parts?.length) {
      stack.push(...part.parts);
    }

    if (!part.body?.data) continue;

    if (part.mimeType === 'text/plain' && !textPlain) {
      textPlain = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && !textHtml) {
      textHtml = decodeBase64Url(part.body.data);
    }
  }

  if (textPlain) return textPlain;
  if (textHtml) return stripHtmlTags(textHtml);

  return '';
}

function normalizeOutgoingAddressList(value?: string): string | null {
  if (!value || value.trim() === '') return null;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(', ');
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

function inferContentType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  switch (extension) {
    case '.pdf':
      return 'application/pdf';
    case '.txt':
      return 'text/plain';
    case '.csv':
      return 'text/csv';
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.doc':
      return 'application/msword';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      return 'application/octet-stream';
  }
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n"]/g, ' ').trim();
}

// RFC 2047 encode a header value when it contains non-ASCII characters.
// Without this, UTF-8 bytes in subjects appear as Mojibake in email clients.
function encodeMimeHeader(value: string): string {
  if (/[^\x00-\x7F]/.test(value)) {
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
  }
  return value;
}

async function buildRawEmailMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
  attachments?: EmailAttachment[];
  inReplyTo?: string;
  references?: string;
}): Promise<string> {
  const to = normalizeOutgoingAddressList(input.to);
  if (!to) {
    throw new Error('Recipient "to" is required.');
  }

  const attachments = (input.attachments ?? []).filter((attachment) => attachment.path.trim() !== '');

  if (attachments.length === 0) {
    const lines: string[] = [
      `To: ${to}`,
      `Subject: ${encodeMimeHeader(input.subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: text/${input.html ? 'html' : 'plain'}; charset=utf-8`,
    ];

    const cc = normalizeOutgoingAddressList(input.cc);
    if (cc) lines.push(`Cc: ${cc}`);

    const bcc = normalizeOutgoingAddressList(input.bcc);
    if (bcc) lines.push(`Bcc: ${bcc}`);

    if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
    if (input.references) lines.push(`References: ${input.references}`);

    lines.push('', input.body);
    return encodeBase64Url(lines.join('\r\n'));
  }

  const lines: string[] = [
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(input.subject)}`,
    'MIME-Version: 1.0',
  ];

  const cc = normalizeOutgoingAddressList(input.cc);
  if (cc) lines.push(`Cc: ${cc}`);

  const bcc = normalizeOutgoingAddressList(input.bcc);
  if (bcc) lines.push(`Bcc: ${bcc}`);

  const boundary = `gmail-multi-inbox-mcp-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');

  lines.push(
    `--${boundary}`,
    `Content-Type: text/${input.html ? 'html' : 'plain'}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(input.body, 'utf8').toString('base64'))
  );

  for (const attachment of attachments) {
    const filePath = attachment.path.trim();
    const fileBuffer = await fs.readFile(filePath);
    const filename = sanitizeHeaderValue(
      attachment.filename?.trim() || path.basename(filePath)
    );
    const contentType = attachment.contentType?.trim() || inferContentType(filename);

    lines.push(
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      wrapBase64(fileBuffer.toString('base64'))
    );
  }

  lines.push(`--${boundary}--`);

  return encodeBase64Url(lines.join('\r\n'));
}

function normalizeAttachments(attachments?: EmailAttachment[]): EmailAttachment[] {
  return (attachments ?? [])
    .map((attachment) => ({
      path: attachment.path.trim(),
      filename: attachment.filename?.trim() || undefined,
      contentType: attachment.contentType?.trim() || undefined,
    }))
    .filter((attachment) => attachment.path !== '');
}

async function createRawEmailMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
  attachments?: EmailAttachment[];
  inReplyTo?: string;
  references?: string;
}): Promise<string> {
  return buildRawEmailMessage({
    ...input,
    attachments: normalizeAttachments(input.attachments),
  });
}

export function createOAuthClientFromCredentials(options: OAuthClientOptions): OAuth2Client {
  if (!options.credentials || typeof options.credentials !== 'object') {
    throw new Error('Invalid credentials content.');
  }

  const credentialsObject = options.credentials as {
    installed?: {
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
    };
    web?: {
      client_id?: string;
      client_secret?: string;
      redirect_uris?: string[];
    };
  };

  const source = credentialsObject.installed ?? credentialsObject.web;
  if (!source?.client_id || !source.client_secret) {
    throw new Error('Credentials must include client_id and client_secret under "installed" or "web".');
  }

  const redirectUri = source.redirect_uris?.[0] ?? 'http://localhost';
  return new OAuth2Client(source.client_id, source.client_secret, redirectUri);
}

export async function readCredentialsFile(credentialsPath: string): Promise<unknown> {
  const raw = await fs.readFile(credentialsPath, 'utf8');
  return JSON.parse(raw);
}

export async function buildOAuthClientFromCredentialsFile(
  credentialsPath: string
): Promise<OAuth2Client> {
  const credentials = await readCredentialsFile(credentialsPath);
  return createOAuthClientFromCredentials({ credentials });
}

export function generateAuthUrlFromCredentials(credentials: unknown): {
  oauth2Client: OAuth2Client;
  authUrl: string;
} {
  const oauth2Client = createOAuthClientFromCredentials({ credentials });
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [...GOOGLE_ACCOUNT_SCOPES],
    prompt: 'consent',
  });
  return { oauth2Client, authUrl };
}

export async function exchangeCodeForToken(
  credentials: unknown,
  authorizationCode: string
): Promise<Credentials> {
  const oauth2Client = createOAuthClientFromCredentials({ credentials });
  const { tokens } = await oauth2Client.getToken(authorizationCode);
  return tokens;
}

function sanitizeMessageIds(messageIds: string[]): string[] {
  return Array.from(
    new Set(
      messageIds
        .map((messageId) => messageId.trim())
        .filter((messageId) => messageId.length > 0)
    )
  );
}

export class GmailAccountClient {
  readonly account: AccountConfig;
  readonly paths: AccountPaths;
  private readonly gmail: gmail_v1.Gmail;

  private constructor(
    account: AccountConfig,
    paths: AccountPaths,
    gmail: gmail_v1.Gmail,
  ) {
    this.account = account;
    this.paths = paths;
    this.gmail = gmail;
  }

  static async create(configRoot: string, account: AccountConfig): Promise<GmailAccountClient> {
    const paths = getAccountPaths(configRoot, account);

    const oauth2Client = await buildOAuthClientFromCredentialsFile(paths.credentialsPath);

    let cachedTokens: Credentials;
    try {
      const rawToken = await fs.readFile(paths.tokenPath, 'utf8');
      cachedTokens = JSON.parse(rawToken) as Credentials;
    } catch (error) {
      throw new Error(
        `Token file missing or invalid for account "${account.id}" at ${paths.tokenPath}: ${(error as Error).message}`
      );
    }

    oauth2Client.setCredentials(cachedTokens);
    oauth2Client.on('tokens', (incomingTokens) => {
      cachedTokens = { ...cachedTokens, ...incomingTokens };
      void fs
        .writeFile(paths.tokenPath, `${JSON.stringify(cachedTokens, null, 2)}\n`, 'utf8')
        .catch((error) => {
          console.error(
            `[ghub] Failed to persist refreshed token for account ${account.id}:`,
            error
          );
        });
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    return new GmailAccountClient(account, paths, gmail);
  }

  async getProfileEmail(): Promise<string> {
    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    if (!profile.data.emailAddress) {
      throw new Error(`Gmail profile did not return an email address for account "${this.account.id}".`);
    }
    return profile.data.emailAddress;
  }

  async readEmails(query: string, maxResults: number, includeBody: boolean): Promise<ParsedEmail[]> {
    return this.fetchMessages(query, maxResults, includeBody);
  }

  async searchEmails(query: string, maxResults: number): Promise<ParsedEmail[]> {
    if (!query || query.trim() === '') {
      throw new Error('Search query is required.');
    }
    return this.fetchMessages(query, maxResults, false);
  }

  private async fetchMessages(
    query: string,
    maxResults: number,
    includeBody: boolean
  ): Promise<ParsedEmail[]> {
    const boundedMax = Math.max(1, Math.min(maxResults, 500));

    const listResponse = await this.gmail.users.messages.list({
      userId: 'me',
      q: query.trim() === '' ? undefined : query,
      maxResults: boundedMax,
    });

    const messageIds = (listResponse.data.messages ?? [])
      .map((message) => message.id)
      .filter((id): id is string => Boolean(id));

    if (messageIds.length === 0) {
      return [];
    }

    const fullMessages = await Promise.all(
      messageIds.map((messageId) =>
        this.gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        })
      )
    );

    return fullMessages
      .map((response) => this.parseMessage(response.data, includeBody))
      .sort((a, b) => b.internalDate - a.internalDate);
  }

  async listAttachments(messageId: string): Promise<AttachmentMetadata[]> {
    if (!messageId || messageId.trim() === '') {
      throw new Error('message_id is required.');
    }

    const response = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    return extractAttachmentsMetadata(response.data.payload).filter((a) => !a.isInline);
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
    filenameHint?: string,
  ): Promise<{ bytes: Buffer; metadata: AttachmentMetadata }> {
    if (!messageId || messageId.trim() === '') {
      throw new Error('message_id is required.');
    }
    if (!attachmentId || attachmentId.trim() === '') {
      throw new Error('attachment_id is required.');
    }

    const messageResponse = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    // Handle synthetic inline IDs (small attachments Gmail embeds as body.data)
    const isInlineId = attachmentId.startsWith('inline:');
    let part: gmail_v1.Schema$MessagePart | null;

    if (isInlineId) {
      const filename = attachmentId.slice('inline:'.length);
      part = findAttachmentPartByFilename(messageResponse.data.payload, filename);
    } else {
      part = findAttachmentPart(messageResponse.data.payload, attachmentId);

      // Gmail rotates attachment IDs on every messages.get, so an ID obtained
      // from an earlier fetch routinely fails exact matching. Fall back to
      // stable identifiers: the filename, then the sole attachment part.
      if (!part) {
        const candidates = collectAttachmentParts(messageResponse.data.payload);
        if (filenameHint) {
          part = candidates.find((p) => p.filename === filenameHint) ?? null;
        }
        if (!part && candidates.length === 1) {
          part = candidates[0];
        }
      }
    }

    if (!part || !part.filename) {
      const available = extractAttachmentsMetadata(messageResponse.data.payload)
        .map((a) => a.filename)
        .join(', ');
      throw new Error(
        `Attachment ${attachmentId} not found on message ${messageId}.` +
          (available ? ` Available attachments: ${available}.` : ''),
      );
    }

    // If the part has inline data (no external attachmentId), decode it directly
    if (part.body?.data && !part.body?.attachmentId) {
      const bytes = decodeBase64UrlBuffer(part.body.data);
      return {
        bytes,
        metadata: {
          id: attachmentId,
          filename: part.filename,
          contentType: part.mimeType ?? 'application/octet-stream',
          sizeBytes: Number(part.body?.size ?? bytes.length),
          isInline: isInlineDisposition(part.headers),
        },
      };
    }

    // Use the FRESH attachment ID from the re-fetched message, not the (possibly stale) passed-in one
    const freshAttachmentId = part.body?.attachmentId ?? attachmentId;

    const attachmentResponse = await this.gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: freshAttachmentId,
    });

    const data = attachmentResponse.data.data;
    if (!data) {
      throw new Error(`Attachment ${attachmentId} has no data payload.`);
    }

    const bytes = decodeBase64UrlBuffer(data);

    return {
      bytes,
      metadata: {
        id: attachmentId,
        filename: part.filename,
        contentType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: Number(part.body?.size ?? bytes.length),
        isInline: isInlineDisposition(part.headers),
      },
    };
  }

  async getThread(threadId: string): Promise<ParsedThread> {
    if (!threadId || threadId.trim() === '') {
      throw new Error('thread_id is required.');
    }

    const threadResponse = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });

    const messages = (threadResponse.data.messages ?? [])
      .map((message) => this.parseMessage(message, true))
      .sort((a, b) => a.internalDate - b.internalDate);

    return {
      threadId,
      messages,
    };
  }

  async getLabels(): Promise<LabelInfo[]> {
    const labelsResponse = await this.gmail.users.labels.list({ userId: 'me' });
    return (labelsResponse.data.labels ?? []).map((label) => ({
      id: label.id ?? '',
      name: label.name ?? '(unnamed)',
      type: label.type ?? undefined,
      messagesTotal: label.messagesTotal ?? undefined,
    }));
  }

  async markAsRead(messageIds: string[]): Promise<number> {
    const ids = sanitizeMessageIds(messageIds);
    if (ids.length === 0) {
      throw new Error('message_ids must include at least one value.');
    }

    await this.gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids,
        removeLabelIds: ['UNREAD'],
      },
    });

    return ids.length;
  }

  async addLabels(messageIds: string[], labelIds: string[]): Promise<number> {
    const ids = sanitizeMessageIds(messageIds);
    const labels = labelIds.map((labelId) => labelId.trim()).filter(Boolean);

    if (ids.length === 0) throw new Error('message_ids must include at least one value.');
    if (labels.length === 0) throw new Error('label_ids must include at least one value.');

    await this.gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids,
        addLabelIds: labels,
      },
    });

    return ids.length;
  }

  async removeLabels(messageIds: string[], labelIds: string[]): Promise<number> {
    const ids = sanitizeMessageIds(messageIds);
    const labels = labelIds.map((labelId) => labelId.trim()).filter(Boolean);

    if (ids.length === 0) throw new Error('message_ids must include at least one value.');
    if (labels.length === 0) throw new Error('label_ids must include at least one value.');

    await this.gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids,
        removeLabelIds: labels,
      },
    });

    return ids.length;
  }

  async archiveEmails(messageIds: string[]): Promise<number> {
    const ids = sanitizeMessageIds(messageIds);
    if (ids.length === 0) throw new Error('message_ids must include at least one value.');

    await this.gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids,
        removeLabelIds: ['INBOX'],
      },
    });

    return ids.length;
  }

  async trashEmails(messageIds: string[]): Promise<number> {
    const ids = sanitizeMessageIds(messageIds);
    if (ids.length === 0) throw new Error('message_ids must include at least one value.');

    await Promise.all(
      ids.map((messageId) =>
        this.gmail.users.messages.trash({
          userId: 'me',
          id: messageId,
        })
      )
    );

    return ids.length;
  }

  async createLabel(
    name: string,
    labelListVisibility = 'labelShow',
    messageListVisibility = 'show'
  ): Promise<LabelInfo> {
    if (!name || name.trim() === '') {
      throw new Error('Label name is required.');
    }

    const response = await this.gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: name.trim(),
        labelListVisibility,
        messageListVisibility,
      },
    });

    return {
      id: response.data.id ?? '',
      name: response.data.name ?? name,
      type: response.data.type ?? undefined,
      messagesTotal: response.data.messagesTotal ?? undefined,
    };
  }

  async deleteLabel(labelId: string): Promise<void> {
    if (!labelId || labelId.trim() === '') {
      throw new Error('label_id is required.');
    }

    await this.gmail.users.labels.delete({
      userId: 'me',
      id: labelId,
    });
  }

  async createFilter(
    criteria: gmail_v1.Schema$FilterCriteria,
    action: gmail_v1.Schema$FilterAction
  ): Promise<gmail_v1.Schema$Filter> {
    const response = await this.gmail.users.settings.filters.create({
      userId: 'me',
      requestBody: { criteria, action },
    });
    return response.data;
  }

  async listFilters(): Promise<gmail_v1.Schema$Filter[]> {
    const response = await this.gmail.users.settings.filters.list({ userId: 'me' });
    return response.data.filter ?? [];
  }

  async deleteFilter(filterId: string): Promise<void> {
    if (!filterId || filterId.trim() === '') {
      throw new Error('filter_id is required.');
    }
    await this.gmail.users.settings.filters.delete({
      userId: 'me',
      id: filterId.trim(),
    });
  }

  async createBlockFilter(
    sender: string,
    action: 'trash' | 'archive' | 'spam'
  ): Promise<gmail_v1.Schema$Filter> {
    const trimmed = sender.trim();
    if (!trimmed) throw new Error('sender is required.');

    const criteria: gmail_v1.Schema$FilterCriteria = { from: trimmed };
    const filterAction: gmail_v1.Schema$FilterAction =
      action === 'archive'
        ? { removeLabelIds: ['INBOX'] }
        : action === 'spam'
          ? { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }
          : { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX', 'UNREAD'] };

    return this.createFilter(criteria, filterAction);
  }

  async modifyThread(
    threadId: string,
    modifications: { addLabelIds?: string[]; removeLabelIds?: string[] }
  ): Promise<void> {
    if (!threadId || threadId.trim() === '') {
      throw new Error('thread_id is required.');
    }
    const addLabelIds = (modifications.addLabelIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean);
    const removeLabelIds = (modifications.removeLabelIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean);
    if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
      throw new Error('modifyThread requires at least one label add or remove.');
    }

    await this.gmail.users.threads.modify({
      userId: 'me',
      id: threadId.trim(),
      requestBody: { addLabelIds, removeLabelIds },
    });
  }

  async getThreadSubject(threadId: string): Promise<string> {
    if (!threadId || threadId.trim() === '') {
      throw new Error('thread_id is required.');
    }

    const response = await this.gmail.users.threads.get({
      userId: 'me',
      id: threadId.trim(),
      format: 'metadata',
      metadataHeaders: ['Subject'],
    });

    const firstMessage = response.data.messages?.[0];
    const raw = getHeaderValue(firstMessage?.payload?.headers, 'Subject');
    return raw.replace(/^(?:\s*(?:re|fwd?|aw)\s*:\s*)+/i, '').trim();
  }

  async getMessageHeaders(
    messageId: string,
    headerNames: string[]
  ): Promise<Record<string, string>> {
    if (!messageId || messageId.trim() === '') {
      throw new Error('message_id is required.');
    }
    const names = headerNames.map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) {
      throw new Error('headerNames must include at least one value.');
    }

    const response = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId.trim(),
      format: 'metadata',
      metadataHeaders: names,
    });

    const headers = response.data.payload?.headers ?? [];
    const result: Record<string, string> = {};
    for (const name of names) {
      result[name] = getHeaderValue(headers, name);
    }
    return result;
  }

  async createDraft(input: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    html?: boolean;
    attachments?: EmailAttachment[];
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<{ draftId: string; threadId?: string }> {
    const raw = await createRawEmailMessage(input);

    const message: { raw: string; threadId?: string } = { raw };
    if (input.threadId) message.threadId = input.threadId;

    const response = await this.gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message },
    });

    return {
      draftId: response.data.id ?? '',
      threadId: response.data.message?.threadId ?? undefined,
    };
  }

  async deleteDrafts(draftIds: string[]): Promise<number> {
    const ids = draftIds.map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) throw new Error('draft_ids must include at least one value.');

    await Promise.all(
      ids.map((draftId) =>
        this.gmail.users.drafts.delete({
          userId: 'me',
          id: draftId,
        })
      )
    );

    return ids.length;
  }

  async sendDraft(draftId: string): Promise<{ messageId: string; threadId?: string }> {
    const response = await this.gmail.users.drafts.send({
      userId: 'me',
      requestBody: { id: draftId },
    });

    return {
      messageId: response.data.id ?? '',
      threadId: response.data.threadId ?? undefined,
    };
  }

  async listDrafts(maxResults = 20): Promise<Array<{ draftId: string; messageId: string; threadId?: string; subject: string; to: string; internalDate: number }>> {
    const listRes = await this.gmail.users.drafts.list({
      userId: 'me',
      maxResults,
    });

    const drafts = listRes.data.drafts ?? [];
    if (drafts.length === 0) return [];

    const details = await Promise.all(
      drafts.map((d) =>
        this.gmail.users.drafts.get({
          userId: 'me',
          id: d.id!,
          format: 'metadata',
        })
      )
    );

    const results = details.map((res) => {
      const headers = res.data.message?.payload?.headers ?? [];
      const get = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
      return {
        draftId: res.data.id ?? '',
        messageId: res.data.message?.id ?? '',
        threadId: res.data.message?.threadId ?? undefined,
        subject: get('Subject'),
        to: get('To'),
        internalDate: Number(res.data.message?.internalDate ?? 0),
      };
    });

    return results.sort((a, b) => a.internalDate - b.internalDate);
  }

  async searchDrafts(query: string, maxResults = 20): Promise<Array<{ draftId: string; messageId: string; threadId?: string; subject: string; to: string; snippet: string }>> {
    const listRes = await this.gmail.users.drafts.list({
      userId: 'me',
      maxResults,
      q: query,
    });

    const drafts = listRes.data.drafts ?? [];
    if (drafts.length === 0) return [];

    const details = await Promise.all(
      drafts.map((d) =>
        this.gmail.users.drafts.get({
          userId: 'me',
          id: d.id!,
          format: 'metadata',
        })
      )
    );

    return details.map((res) => {
      const headers = res.data.message?.payload?.headers ?? [];
      const get = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
      return {
        draftId: res.data.id ?? '',
        messageId: res.data.message?.id ?? '',
        threadId: res.data.message?.threadId ?? undefined,
        subject: get('Subject'),
        to: get('To'),
        snippet: res.data.message?.snippet ?? '',
      };
    });
  }

  async sendEmail(input: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    html?: boolean;
    attachments?: EmailAttachment[];
  }): Promise<{ messageId: string; threadId?: string }> {
    const raw = await createRawEmailMessage(input);

    const response = await this.gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return {
      messageId: response.data.id ?? '',
      threadId: response.data.threadId ?? undefined,
    };
  }

  private parseMessage(message: gmail_v1.Schema$Message, includeBody: boolean): ParsedEmail {
    const headers = message.payload?.headers;
    const internalDate = Number(message.internalDate ?? 0);
    const attachments = extractAttachmentsMetadata(message.payload).filter(
      (a) => !a.isInline,
    );

    return {
      id: message.id ?? '',
      threadId: message.threadId ?? '',
      snippet: message.snippet ?? '',
      from: getHeaderValue(headers, 'From'),
      to: getHeaderValue(headers, 'To'),
      cc: getHeaderValue(headers, 'Cc'),
      subject: getHeaderValue(headers, 'Subject') || '(no subject)',
      date: getHeaderValue(headers, 'Date'),
      internalDate: Number.isFinite(internalDate) ? internalDate : 0,
      messageHeaderId: getHeaderValue(headers, 'Message-ID'),
      inReplyTo: getHeaderValue(headers, 'In-Reply-To'),
      references: getHeaderValue(headers, 'References'),
      body: includeBody ? extractEmailBody(message.payload) : undefined,
      labels: message.labelIds ?? [],
      attachments,
      accountId: this.account.id,
      accountEmail: this.account.email,
    };
  }

}
