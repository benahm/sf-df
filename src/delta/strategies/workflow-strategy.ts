import type { XmlKeyRule } from '../xml.js';
import { XmlCollectionDeltaStrategy } from './xml-collection-delta-strategy.js';

const keyedBy = (fieldName: string): XmlKeyRule => ({
  keySelector: (item: Record<string, unknown>) => String(item[fieldName] ?? ''),
  supportsDelete: true,
});

export class WorkflowStrategy extends XmlCollectionDeltaStrategy {
  public constructor() {
    super({
      name: 'workflow',
      matcher: (relativePath) => relativePath.startsWith('force-app/main/default/workflows/'),
      rootName: 'Workflow',
      supportsDestructive: true,
      rules: {
        alerts: keyedBy('fullName'),
        assignmentRules: keyedBy('fullName'),
        fieldUpdates: keyedBy('fullName'),
        flowActions: keyedBy('fullName'),
        knowledgePublishes: keyedBy('fullName'),
        outboundMessages: keyedBy('fullName'),
        rules: keyedBy('fullName'),
        tasks: keyedBy('fullName'),
      },
    });
  }
}
