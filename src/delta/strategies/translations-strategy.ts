import type { XmlKeyRule } from '../xml.js';
import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

const keyedBy = (fieldName: string): XmlKeyRule => ({
  keySelector: (item: Record<string, unknown>) => String(item[fieldName] ?? ''),
});

export class TranslationsStrategy extends XmlCollectionDeltaStrategy {
  public constructor() {
    super({
      name: 'translations',
      metadataTypes: ['Translations'],
      rootName: 'Translations',
      neverDelete: true,
      rules: {
        customApplications: keyedBy('name'),
        customLabels: keyedBy('name'),
        customTabs: keyedBy('name'),
        fields: keyedBy('name'),
        flowDefinitions: keyedBy('name'),
        layouts: keyedBy('layout'),
        picklistValues: keyedBy('masterLabel'),
        quickActions: keyedBy('name'),
        recordTypes: keyedBy('name'),
        reportTypes: keyedBy('name'),
        validationRules: keyedBy('name'),
        webLinks: keyedBy('name'),
      },
    });
  }
}
