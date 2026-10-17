import type { Connection } from '@salesforce/core';

// readMetadata responses shaped like the ones of a real org (checked on a sandbox).
export const readMetadataResponse = (...records: Array<string | undefined>): string =>
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>' +
  '<readMetadataResponse><result>' +
  records
    .map((record) =>
      record === undefined ? '<records xsi:nil="true"/>' : `<records xsi:type="Profile">${record}</records>`
    )
    .join('') +
  '</result></readMetadataResponse></soapenv:Body></soapenv:Envelope>';

export type FakeOrg = Record<string, string | Error>;

// Answers readMetadata like the org: the profiles it knows, xsi:nil for the others.
export const fakeConnection = (
  org: FakeOrg,
  calls: string[][] = [],
  options: { expiredOnce?: boolean; onRequest?: () => Promise<void>; onRefresh?: () => void } = {}
): Connection => {
  let token = 'token-1';
  let expired = options.expiredOnce ?? false;
  const connection = {
    get accessToken() {
      return token;
    },
    getApiVersion: () => '64.0',
    refreshAuth: async () => {
      options.onRefresh?.();
      token = 'token-2';
      expired = false;
    },
    request: async (request: { body: string }) => {
      const names = [...request.body.matchAll(/<m:fullNames>([^<]*)<\/m:fullNames>/g)].map((match) => match[1]);
      calls.push(names);
      await options.onRequest?.();
      if (expired || !request.body.includes(`<m:sessionId>${token}</m:sessionId>`)) {
        throw new Error(
          '<soapenv:Envelope><soapenv:Body><soapenv:Fault><faultcode>sf:INVALID_SESSION_ID</faultcode><faultstring>INVALID_SESSION_ID: expired</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>'
        );
      }

      const answers = names.map((name) => {
        const answer = org[name.replace(/&amp;/g, '&')];
        if (answer instanceof Error) {
          throw answer;
        }

        return answer === undefined ? undefined : `<fullName>${name}</fullName>${answer}`;
      });
      return readMetadataResponse(...answers);
    },
  };
  return connection as unknown as Connection;
};
