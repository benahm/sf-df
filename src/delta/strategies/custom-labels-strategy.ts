import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

export class CustomLabelsStrategy extends XmlCollectionDeltaStrategy {
  public constructor() {
    super({
      name: 'customLabels',
      metadataTypes: ['CustomLabels'],
      rootName: 'CustomLabels',
      supportsDestructive: true,
      rules: {
        labels: {
          keySelector: (item) => String(item.fullName ?? ''),
          supportsDelete: true,
        },
      },
    });
  }
}
