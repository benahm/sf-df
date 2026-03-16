import type { MetadataDeltaStrategy } from '../types.js';
import { CustomLabelsStrategy } from './custom-labels-strategy.js';
import { GenericFileStrategy } from './generic-file-strategy.js';
import { ProfileStrategy } from './profile-strategy.js';
import { RecordTypeStrategy } from './record-type-strategy.js';
import { TranslationsStrategy } from './translations-strategy.js';
import { WorkflowStrategy } from './workflow-strategy.js';

export class StrategyRegistry {
  private readonly strategies: MetadataDeltaStrategy[];

  public constructor(sourceDir = 'force-app/main/default') {
    this.strategies = [
      new CustomLabelsStrategy(sourceDir),
      new WorkflowStrategy(sourceDir),
      new ProfileStrategy(sourceDir),
      new RecordTypeStrategy(sourceDir),
      new TranslationsStrategy(sourceDir),
      new GenericFileStrategy(),
    ];
  }

  public getStrategy(relativePath: string): MetadataDeltaStrategy {
    return this.strategies.find((strategy) => strategy.supports(relativePath)) ?? this.strategies.at(-1)!;
  }
}
