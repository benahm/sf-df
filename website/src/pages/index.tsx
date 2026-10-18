import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import styles from './index.module.css';

type Feature = {title: string; description: ReactNode};

const features: Feature[] = [
  {
    title: 'One command to deliver',
    description: (
      <>
        <code>sf df deploy</code> merges the feature, deploys only what changed in one atomic job, and pushes the merge
        only if the deployment succeeded.
      </>
    ),
  },
  {
    title: 'The branch is the org',
    description: (
      <>
        Each org is mapped to one branch. Its tip is exactly what the org holds: no tag, no state file, nothing stored
        in the org.
      </>
    ),
  },
  {
    title: 'Metadata merged by key',
    description: (
      <>
        Profiles, permission sets, labels and translations are merged item by item. Two features touching the same file
        no longer conflict.
      </>
    ),
  },
  {
    title: 'Never deletes more than git',
    description: (
      <>
        Deletion rules come from real sandbox deployments. Types the API can't delete are deactivated, and deletions
        require <code>--allow-destructive</code>.
      </>
    ),
  },
];

function Hero(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.hero)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className={clsx('hero__subtitle', styles.tagline)}>{siteConfig.tagline}</p>
        <div className={styles.command}>
          <CodeBlock language="bash">{'sf df deploy --source feature/JIRA-123 --target-org int'}</CodeBlock>
        </div>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/getting-started">
            Get started
          </Link>
          <Link className="button button--secondary button--lg" to="/docs/category/commands">
            Commands
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout description="Salesforce CLI plugin: deliver a git branch to a Salesforce org in one command.">
      <Hero />
      <main className="container margin-vert--xl">
        <div className="row">
          {features.map((feature) => (
            <div key={feature.title} className={clsx('col col--3', styles.feature)}>
              <Heading as="h3">{feature.title}</Heading>
              <p>{feature.description}</p>
            </div>
          ))}
        </div>
      </main>
    </Layout>
  );
}
