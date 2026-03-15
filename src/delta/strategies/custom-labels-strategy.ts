import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

export class CustomLabelsStrategy extends XmlCollectionDeltaStrategy {
  public constructor() {
    super({
      name: 'customLabels',
      matcher: (relativePath) => relativePath.startsWith('force-app/main/default/labels/'),
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
