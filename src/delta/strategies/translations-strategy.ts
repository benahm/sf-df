import { keyedCollectionRules } from '../xml.js';
import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

export const TRANSLATIONS_COLLECTION_KEYS: Record<string, string[]> = {
  customApplications: ['name'],
  customLabels: ['name'],
  customTabs: ['name'],
  fields: ['name'],
  flowDefinitions: ['name'],
  layouts: ['layout'],
  picklistValues: ['masterLabel'],
  quickActions: ['name'],
  recordTypes: ['name'],
  reportTypes: ['name'],
  validationRules: ['name'],
  webLinks: ['name'],
};

export class TranslationsStrategy extends XmlCollectionDeltaStrategy {
  public constructor() {
    super({
      name: 'translations',
      metadataTypes: ['Translations'],
      rootName: 'Translations',
      neverDelete: true,
      rules: keyedCollectionRules(TRANSLATIONS_COLLECTION_KEYS),
    });
  }
}
