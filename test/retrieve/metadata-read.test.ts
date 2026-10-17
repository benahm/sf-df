import { expect } from 'chai';

import {
  buildReadMetadataEnvelope,
  formatMetadataFile,
  isTransientError,
  parseReadMetadataResponse,
  SoapFaultError,
} from '../../src/retrieve/metadata-read.js';
import { readMetadataResponse } from './fake-org.js';

describe('readMetadata as raw XML', () => {
  describe('buildReadMetadataEnvelope', () => {
    it('escapes the names', () => {
      const envelope = buildReadMetadataEnvelope('00D!token', 'Profile', ['R&D <Team>']);

      expect(envelope).to.contain('<m:sessionId>00D!token</m:sessionId>');
      expect(envelope).to.contain('<m:type>Profile</m:type><m:fullNames>R&amp;D &lt;Team&gt;</m:fullNames>');
    });
  });

  describe('parseReadMetadataResponse', () => {
    it('returns the records in request order, without their fullName', () => {
      const records = parseReadMetadataResponse(
        readMetadataResponse(
          '<fullName>Admin</fullName><custom>false</custom>',
          '<fullName>R&amp;D</fullName><custom>true</custom>'
        )
      );

      expect(records).to.deep.equal([
        { fullName: 'Admin', body: '<custom>false</custom>' },
        { fullName: 'R&D', body: '<custom>true</custom>' },
      ]);
    });

    it('returns undefined for a name unknown to the org, never an empty record', () => {
      const records = parseReadMetadataResponse(
        readMetadataResponse(undefined, '<fullName>Admin</fullName><custom>false</custom>')
      );

      expect(records).to.have.length(2);
      expect(records[0]).to.equal(undefined);
      expect(records[1]?.fullName).to.equal('Admin');
    });

    it('throws the SOAP fault', () => {
      const fault =
        '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault>' +
        '<faultcode>sf:INVALID_SESSION_ID</faultcode><faultstring>INVALID_SESSION_ID: Invalid Session ID &amp; more</faultstring>' +
        '</soapenv:Fault></soapenv:Body></soapenv:Envelope>';

      expect(() => parseReadMetadataResponse(fault))
        .to.throw(SoapFaultError, 'Invalid Session ID & more')
        .with.property('faultCode', 'sf:INVALID_SESSION_ID');
    });

    it('rejects a response that is not a readMetadata response', () => {
      expect(() => parseReadMetadataResponse('<html>Maintenance</html>')).to.throw('Unexpected readMetadata response');
    });
  });

  describe('formatMetadataFile', () => {
    it('writes the layout of sf project retrieve: one element per line, 4 spaces, leaf values inline', () => {
      const body =
        '<applicationVisibilities><application>App</application><default>false</default><visible>true</visible></applicationVisibilities>' +
        '<custom>false</custom><loginHours/><description></description>';

      expect(formatMetadataFile('Profile', body)).to.equal(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Profile xmlns="http://soap.sforce.com/2006/04/metadata">',
          '    <applicationVisibilities>',
          '        <application>App</application>',
          '        <default>false</default>',
          '        <visible>true</visible>',
          '    </applicationVisibilities>',
          '    <custom>false</custom>',
          '    <loginHours/>',
          '    <description></description>',
          '</Profile>',
          '',
        ].join('\n')
      );
    });

    it('keeps the escaping of the org untouched', () => {
      const file = formatMetadataFile(
        'Profile',
        '<description>R&amp;D &lt;team&gt; &quot;x&quot; it&apos;s</description>'
      );

      expect(file).to.contain('    <description>R&amp;D &lt;team&gt; &quot;x&quot; it&apos;s</description>\n');
    });

    it('declares the xsi prefix when an element keeps an xsi attribute', () => {
      const file = formatMetadataFile('Profile', '<description xsi:nil="true"/>');

      expect(file).to.contain(
        '<Profile xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      );
      expect(formatMetadataFile('Profile', '<custom>false</custom>')).to.not.contain('xmlns:xsi');
    });

    it('indents nested elements', () => {
      const file = formatMetadataFile(
        'Translations',
        '<reportTypes><name>R</name><sections><label>S</label><name>N</name></sections></reportTypes>'
      );

      expect(file).to.contain(
        [
          '    <reportTypes>',
          '        <name>R</name>',
          '        <sections>',
          '            <label>S</label>',
          '            <name>N</name>',
          '        </sections>',
          '    </reportTypes>',
        ].join('\n')
      );
    });
  });

  describe('isTransientError', () => {
    it('retries the failures of the org or the network, not the errors of the request', () => {
      const withCode = (code: string): Error => Object.assign(new Error(code), { code });
      const httpError = (name: string): Error => Object.assign(new Error('<html>'), { name });

      expect(isTransientError(new SoapFaultError('sf:UNKNOWN_EXCEPTION', 'x'))).to.equal(true);
      expect(isTransientError(new SoapFaultError('sf:REQUEST_LIMIT_EXCEEDED', 'x'))).to.equal(true);
      expect(isTransientError(withCode('ECONNRESET'))).to.equal(true);
      expect(isTransientError(new Error('socket hang up'))).to.equal(true);
      expect(isTransientError(httpError('ERROR_HTTP_503'))).to.equal(true);

      expect(isTransientError(new SoapFaultError('sf:INVALID_TYPE', 'x'))).to.equal(false);
      expect(isTransientError(new SoapFaultError('sf:INVALID_SESSION_ID', 'x'))).to.equal(false);
      expect(isTransientError(httpError('ERROR_HTTP_404'))).to.equal(false);
      expect(isTransientError(withCode('ENOENT'))).to.equal(false);
    });
  });
});
