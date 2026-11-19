import type { TestProject } from 'vitest/node';
import { createMigratedDatabase } from '../src/testing.js';

declare module 'vitest' {
  export interface ProvidedContext {
    templateName: string;
  }
}

/** One migrated template database per test run; every test file clones it. */
export default async function setup(project: TestProject) {
  const template = await createMigratedDatabase('tpl');
  project.provide('templateName', template.name);
  return async () => {
    await template.drop();
  };
}
