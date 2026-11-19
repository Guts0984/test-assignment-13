import { createMigratedDatabase } from '@auction/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    templateName: string;
  }
}

/** Vitest globalSetup: one migrated template database per test run; every test file clones it. */
export default async function setup(project: TestProject) {
  const template = await createMigratedDatabase('tpl');
  project.provide('templateName', template.name);
  return async () => {
    await template.drop();
  };
}
