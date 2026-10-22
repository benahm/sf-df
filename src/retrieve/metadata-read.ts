import type { Connection } from '@salesforce/core';

// Metadata API readMetadata, kept as raw XML text: jsforce would turn a 1.6 MB Profile into a large object tree
// (and casts some booleans but not others), whereas the SOAP response already holds the record in the order and
// with the escaping a retrieve writes. Only the indentation differs, so the record is re-indented as text.

const METADATA_NS = 'http://soap.sforce.com/2006/04/metadata';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const buildEnvelope = (sessionId: string, body: string): string =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="${METADATA_NS}">` +
  `<soapenv:Header><m:SessionHeader><m:sessionId>${escapeXml(
    sessionId
  )}</m:sessionId></m:SessionHeader></soapenv:Header>` +
  `<soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

export const buildReadMetadataEnvelope = (sessionId: string, type: string, fullNames: string[]): string =>
  buildEnvelope(
    sessionId,
    `<m:readMetadata><m:type>${escapeXml(type)}</m:type>` +
      fullNames.map((fullName) => `<m:fullNames>${escapeXml(fullName)}</m:fullNames>`).join('') +
      '</m:readMetadata>'
  );

export const buildListMetadataEnvelope = (sessionId: string, type: string): string =>
  buildEnvelope(
    sessionId,
    `<m:listMetadata><m:queries><m:type>${escapeXml(type)}</m:type></m:queries></m:listMetadata>`
  );

export class SoapFaultError extends Error {
  public constructor(public readonly faultCode: string, message: string) {
    super(message);
    this.name = 'SoapFaultError';
  }
}

const decodeText = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const FAULT = /<faultcode>([^<]*)<\/faultcode>\s*<faultstring>([^<]*)<\/faultstring>/;
const RECORD = /<records(?:\s+xsi:type="[^"]*")?\s*(\/>|xsi:nil="true"\s*\/>|>([\s\S]*?)<\/records>)/g;
const FULL_NAME = /^\s*<fullName>([^<]*)<\/fullName>/;

export type ReadMetadataRecord = { fullName: string; body: string };

// Records of a readMetadata response, in request order. A name unknown to the org comes back as
// `<records xsi:nil="true"/>`: it is returned as undefined, never as an empty record (writing it would wipe the file).
const assertResponse = (response: string, call: string): void => {
  const fault = FAULT.exec(response);
  if (fault) {
    throw new SoapFaultError(fault[1], decodeText(fault[2]));
  }

  if (!response.includes(`${call}Response`)) {
    throw new Error(`Unexpected ${call} response: ${response.slice(0, 200)}`);
  }
};

const LIST_RESULT = /<result>([\s\S]*?)<\/result>/g;
const LISTED_FULL_NAME = /<fullName>([^<]*)<\/fullName>/;

// Full names of a listMetadata response, as the org returns them.
export const parseListMetadataResponse = (response: string): string[] => {
  assertResponse(response, 'listMetadata');
  return [...response.matchAll(LIST_RESULT)]
    .map((match) => LISTED_FULL_NAME.exec(match[1])?.[1])
    .filter((fullName): fullName is string => fullName !== undefined)
    .map(decodeText);
};

export const parseReadMetadataResponse = (response: string): Array<ReadMetadataRecord | undefined> => {
  assertResponse(response, 'readMetadata');
  return [...response.matchAll(RECORD)].map((match) => {
    const content = match[2];
    const fullName = content === undefined ? undefined : FULL_NAME.exec(content);
    if (!content || !fullName) {
      return undefined;
    }

    return { fullName: decodeText(fullName[1]), body: content.slice(fullName[0].length) };
  });
};

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|([^<]+)/g;

// Writes a record body (the elements under <records>) as a source file: XML declaration, root with the metadata
// namespace, one element per line indented by 4 spaces, leaf values inline. Same layout as `sf project retrieve`.
export const formatMetadataFile = (rootName: string, body: string): string => {
  // The xsi prefix is declared on the SOAP envelope: an element keeping an xsi attribute needs it on the root.
  const xsi = body.includes('xsi:') ? ` xmlns:xsi="${XSI_NS}"` : '';
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<${rootName} xmlns="${METADATA_NS}"${xsi}>`];
  const indent = (depth: number): string => '    '.repeat(depth);
  let depth = 1;
  // Opening tag not written yet: it is written with its text and closing tag on one line if it is a leaf.
  let pendingOpen: string | undefined;
  let text = '';

  for (const [token, closing, , selfClosing, textToken] of body.matchAll(TOKEN)) {
    if (textToken !== undefined) {
      text += textToken;
      continue;
    }

    if (closing) {
      depth -= 1;
      if (pendingOpen !== undefined) {
        lines.push(`${indent(depth)}${pendingOpen}${text}${token}`);
        pendingOpen = undefined;
      } else {
        lines.push(`${indent(depth)}${token}`);
      }

      text = '';
      continue;
    }

    if (pendingOpen !== undefined) {
      lines.push(`${indent(depth - 1)}${pendingOpen}`);
      pendingOpen = undefined;
    }

    text = '';
    if (selfClosing || token.startsWith('<!--')) {
      lines.push(`${indent(depth)}${token}`);
    } else {
      pendingOpen = token;
      depth += 1;
    }
  }

  lines.push(`</${rootName}>`);
  return `${lines.join('\n')}\n`;
};

// Errors worth a new attempt: the org or the network failed, not the request. Faults of the org (UNKNOWN_EXCEPTION,
// SERVER_UNAVAILABLE, REQUEST_LIMIT_EXCEEDED), an HTTP 5xx that is not a SOAP fault, a dropped connection.
const TRANSIENT_FAULTS = ['REQUEST_LIMIT_EXCEEDED', 'SERVER_UNAVAILABLE', 'UNKNOWN_EXCEPTION'];
const TRANSIENT_NETWORK_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'];

export const isTransientError = (error: unknown): boolean => {
  if (error instanceof SoapFaultError) {
    return TRANSIENT_FAULTS.some((code) => error.faultCode.endsWith(code));
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === 'string' && TRANSIENT_NETWORK_CODES.includes(code)) ||
    error.name.startsWith('ERROR_HTTP_5') ||
    error.message.includes('socket hang up')
  );
};

const isExpiredSession = (error: unknown): boolean =>
  error instanceof SoapFaultError && error.faultCode.endsWith('INVALID_SESSION_ID');

// Parallel calls see the session expire together: they share one refresh, and a call that sent a token already
// replaced only retries.
const refreshing = new WeakMap<Connection, Promise<void>>();

const refreshSession = async (connection: Connection, expiredToken: string): Promise<void> => {
  if ((connection.accessToken ?? '') !== expiredToken) {
    return;
  }

  let refresh = refreshing.get(connection);
  if (!refresh) {
    refresh = connection.refreshAuth().finally(() => refreshing.delete(connection));
    refreshing.set(connection, refresh);
  }

  await refresh;
};

export type ReadMetadataOptions = {
  // New attempts after a transient error, waiting retryDelayMs, then twice as long each time.
  retries?: number;
  retryDelayMs?: number;
};

const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 2000;

// One readMetadata call. Sent through the connection so that the proxy settings and the token refresh of the
// CLI apply; the body is asked as plain text so that jsforce does not parse it.
export const readMetadataRaw = async (
  connection: Connection,
  type: string,
  fullNames: string[],
  options: ReadMetadataOptions = {}
): Promise<Array<ReadMetadataRecord | undefined>> =>
  callMetadataSoap(
    connection,
    (token) => buildReadMetadataEnvelope(token, type, fullNames),
    parseReadMetadataResponse,
    options
  );

// Full names of the components of a type in the org. Sent like readMetadata, for the same session refresh and
// retries: jsforce metadata.list uses its own transport.
export const listMetadataNames = async (
  connection: Connection,
  type: string,
  options: ReadMetadataOptions = {}
): Promise<string[]> =>
  callMetadataSoap(connection, (token) => buildListMetadataEnvelope(token, type), parseListMetadataResponse, options);

const callMetadataSoap = async <T>(
  connection: Connection,
  envelope: (sessionId: string) => string,
  parse: (response: string) => T,
  options: ReadMetadataOptions
): Promise<T> => {
  const send = async (token: string): Promise<string> =>
    connection.request<string>(
      {
        method: 'POST',
        url: `/services/Soap/m/${connection.getApiVersion()}`,
        body: envelope(token),
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
      },
      { responseType: 'text/plain' }
    );

  const responseText = async (token: string): Promise<string> => {
    try {
      return await send(token);
    } catch (error) {
      // A SOAP fault comes back as HTTP 500: jsforce puts the unparsed body in the error message.
      const body = error instanceof Error ? error.message : '';
      if (body.includes('<faultcode>')) {
        return body;
      }

      throw error;
    }
  };

  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const attempt = async (retriesLeft: number, refreshed: boolean): Promise<T> => {
    const token = connection.accessToken ?? '';
    try {
      return parse(await responseText(token));
    } catch (error) {
      // The session id travels in the SOAP envelope, which jsforce does not refresh: refresh once and retry.
      if (!refreshed && isExpiredSession(error)) {
        await refreshSession(connection, token);
        return attempt(retriesLeft, true);
      }

      if (retriesLeft > 0 && isTransientError(error)) {
        const done = (options.retries ?? DEFAULT_RETRIES) - retriesLeft;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** done));
        return attempt(retriesLeft - 1, refreshed);
      }

      throw error;
    }
  };

  return attempt(options.retries ?? DEFAULT_RETRIES, false);
};
