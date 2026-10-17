import { RegistryCollectionStrategy } from './registry-collection-strategy.js';

export class WorkflowStrategy extends RegistryCollectionStrategy {
  public constructor() {
    super('workflow', 'Workflow');
  }
}
