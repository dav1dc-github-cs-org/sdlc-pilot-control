import { Octokit } from '@octokit/rest';
import { readFileSync } from 'node:fs';
import { Controller } from './controller.ts';
import { parseIntakeEvent, resolvePolicy } from './contracts.ts';
import { GitHub } from './github.ts';
import { parseRunTitle } from './targets.ts';

const policy = resolvePolicy(JSON.parse(readFileSync('.github/sdlc/policy.json', 'utf8')), process.env.SDLC_AIC_CREDIT_LIMIT);
if (!process.env.GH_TOKEN) throw new Error('A scoped GitHub App token is required');
const github = new GitHub(process.env.GITHUB_REPOSITORY ?? '', policy, process.env.SDLC_BOT_LOGIN ?? '',
  new Octokit({ auth: process.env.GH_TOKEN, request: { timeout: 30_000 } }), process.env.SDLC_MODEL);
const controller = new Controller(github, policy);
if (process.env.GITHUB_SHA && (await github.baseline()).sha !== process.env.GITHUB_SHA) {
  throw new Error('Controller revision is stale; the next reconciliation must run on the current default branch');
}
const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
const intake = parseIntakeEvent(event, policy.label);
const run = parseRunTitle(event.workflow_run?.display_title ?? '');
const selected = process.env.SDLC_ISSUE || intake?.issueNumber ||
  (!event.issue?.pull_request ? event.issue?.number : undefined) || run?.issue;
// Issue numbers repeat across repositories, so a target-qualified run never selects a control-repository issue.
if (event.issue?.pull_request || run?.targetId !== undefined) process.exit(0);
const numbers = selected ? [Number(selected)] : await github.activeIssues();
for (const number of numbers) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid issue number');
  try {
    await controller.tick(number, intake?.issueNumber === number ? intake : undefined);
    console.log(`Reconciled issue #${number}`);
  } catch (error) {
    console.error(`Issue #${number}: ${error instanceof Error ? error.message : 'controller failure'}`);
    process.exitCode = 1;
  }
}