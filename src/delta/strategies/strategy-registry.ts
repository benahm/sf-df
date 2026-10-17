import type { MetadataDeltaStrategy } from '../types.js';
import { CustomLabelsStrategy } from './custom-labels-strategy.js';
import { FlowStrategy } from './flow-strategy.js';
import { GenericFileStrategy } from './generic-file-strategy.js';
import { ProfileStrategy } from './profile-strategy.js';
import { RecordTypeStrategy } from './record-type-strategy.js';
import { RegistryCollectionStrategy } from './registry-collection-strategy.js';
import { TranslationsStrategy } from './translations-strategy.js';
import { WorkflowStrategy } from './workflow-strategy.js';

export class StrategyRegistry {
  private readonly strategies: MetadataDeltaStrategy[];

  public constructor() {
    this.strategies = [
      new CustomLabelsStrategy(),
      new WorkflowStrategy(),
      new RegistryCollectionStrategy('sharingRules', 'SharingRules'),
      new RegistryCollectionStrategy('assignmentRules', 'AssignmentRules'),
      new RegistryCollectionStrategy('autoResponseRules', 'AutoResponseRules'),
      new RegistryCollectionStrategy('matchingRules', 'MatchingRules'),
      new ProfileStrategy(),
      new RecordTypeStrategy(),
      new TranslationsStrategy(),
      new FlowStrategy(),
      new GenericFileStrategy(),
    ];
  }

  public getStrategy(operation: Parameters<MetadataDeltaStrategy['supports']>[0]): MetadataDeltaStrategy {
    return (
      this.strategies.find((strategy) => !strategy.isFallback && strategy.supports(operation)) ??
      this.strategies.find((strategy) => strategy.isFallback) ??
      this.strategies.at(-1)!
    );
  }
}
