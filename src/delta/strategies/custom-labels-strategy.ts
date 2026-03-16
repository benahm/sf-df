import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

export class CustomLabelsStrategy extends XmlCollectionDeltaStrategy {
  public constructor(sourceDir = 'force-app/main/default') {
    super({
      name: 'customLabels',
      matcher: (relativePath) => relativePath.startsWith(`${sourceDir}/labels/`),
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
