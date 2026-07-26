import {defineConfig} from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    // The purity harness loads a real MV3 extension into a persistent context and shares
    // that context across fixtures. Running files in parallel would mean several browsers
    // fighting over the same extension profile, so it is serial by design.
    fullyParallel: false,
    workers: 1,
    // A purity failure means the code is wrong, not that the run was flaky. Retrying would
    // turn an intermittent violation — the worst kind — into a green run.
    retries: 0,
    forbidOnly: Boolean(process.env.CI),
    reporter: process.env.CI ? [['github'], ['list']] : [['list']],
    timeout: 60_000,
    expect: {timeout: 10_000},
    projects: [
        {name: 'purity', testMatch: /purity\/.*\.spec\.ts/},
        {name: 'e2e', testMatch: /e2e\/.*\.spec\.ts/},
    ],
});
