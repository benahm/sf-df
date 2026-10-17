import salesforceTypescript from 'eslint-config-salesforce-typescript';
import sfPlugin from 'eslint-plugin-sf-plugin';

export default [
  ...salesforceTypescript,
  ...sfPlugin.configs.recommended,
  {
    // The Salesforce config enforces Salesforce's own Apache license header; this plugin is not a Salesforce project.
    rules: { 'header/header': 'off' },
  },
  {
    // Metadata strategies implement a shared interface; a stateless one still has to provide its methods.
    rules: {
      'class-methods-use-this': 'off',
      '@typescript-eslint/class-methods-use-this': ['error', { ignoreClassesThatImplementAnInterface: true }],
    },
  },
];
