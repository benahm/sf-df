import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const repoUrl = 'https://github.com/benahm/sf-df';

const config: Config = {
  title: 'Deltaforce',
  tagline: 'Deliver a branch to a Salesforce org in one command: merge, delta, deploy, and push only if it worked.',
  favicon: 'img/logo.svg',

  future: {
    v4: true,
  },

  url: 'https://benahm.github.io',
  baseUrl: '/sf-df/',
  organizationName: 'benahm',
  projectName: 'sf-df',
  trailingSlash: false,

  onBrokenLinks: 'throw',

  // .md files are plain CommonMark (the command pages are generated from --help), .mdx files are MDX.
  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: `${repoUrl}/tree/main/website/`,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    announcementBar: {
      id: 'beta',
      content: `Deltaforce is in beta: review the delta before deploying to production, and <a href="${repoUrl}/issues">report issues</a>.`,
      isCloseable: true,
    },
    navbar: {
      title: 'Deltaforce',
      logo: {
        alt: 'Deltaforce',
        src: 'img/logo.svg',
        srcDark: 'img/logo-dark.svg',
      },
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {to: '/docs/category/commands', label: 'Commands', position: 'left'},
        {href: 'https://www.npmjs.com/package/sf-df', label: 'npm', position: 'right'},
        {href: repoUrl, label: 'GitHub', position: 'right'},
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Getting started', to: '/docs/getting-started'},
            {label: 'Deliver a branch', to: '/docs/guides/deliver-a-branch'},
            {label: 'Commands', to: '/docs/category/commands'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'GitHub', href: repoUrl},
            {label: 'Issues', href: `${repoUrl}/issues`},
            {label: 'Releases', href: `${repoUrl}/releases`},
          ],
        },
      ],
      copyright: `Deltaforce (sf-df), BSD-3-Clause license. Not affiliated with Salesforce.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
