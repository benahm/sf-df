import { RegistryCollectionStrategy } from './registry-collection-strategy.js';

export class CustomLabelsStrategy extends RegistryCollectionStrategy {
  public constructor() {
    super('customLabels', 'CustomLabels');
  }
}
