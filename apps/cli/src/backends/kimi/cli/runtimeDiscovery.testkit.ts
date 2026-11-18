import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';

/** Vendor process boundary fixture; Happier discovery and ACP logic remain real. */
export function writeKimiFixture(dir: string, kind: 'current' | 'legacy' | 'malformed', controlsVersion?: number): string {
  const initialize = JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${kind}.initialize.ndjson`, import.meta.url)), 'utf8')).result;
  if (controlsVersion !== undefined) {
    initialize.agentCapabilities._meta = { 'dev.happier/kimiControls': { version: controlsVersion, steer: true, goal: true, goalTurns: true } };
  }
  const path = writeAcpTestAgentScript({ dir, fileName: 'kimi', source: `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync, mkdirSync, existsSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const initialize = ${JSON.stringify(initialize)};
const record = ${JSON.stringify(join(dir, 'requests.ndjson'))};
let goal = null;
let goalTurnHeld = false;
function notify(method, params) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n'); }
function journal(sessionId, event) {
  const path = join(process.env.KIMI_CODE_HOME, 'sessions', 'fixture-workspace', sessionId, 'agents', 'main', 'wire.jsonl');
  appendFileSync(path, JSON.stringify({ agentId: 'main', ...event }) + '\\n');
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(record, JSON.stringify({ method: request.method, params: request.params, cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = initialize;
  if (['session/new', 'session/load', 'session/fork'].includes(request.method)) result = {
    sessionId: request.method === 'session/fork' ? 'kimi-fixture-fork' : request.params.sessionId || 'kimi-fixture-session',
    modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'auto', name: 'Auto' }] },
    configOptions: [
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'auto', name: 'Auto' }] },
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'kimi-for-coding', options: [{ value: 'kimi-for-coding', name: 'Kimi for Coding' }] },
    ],
  };
  if (['session/new', 'session/load', 'session/fork'].includes(request.method)) {
    const home = process.env.KIMI_CODE_HOME || ${JSON.stringify(join(dir, 'kimi-home'))};
    const sessionDir = join(home, 'sessions', 'fixture-workspace', result.sessionId);
    mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
    appendFileSync(join(home, 'session_index.jsonl'), JSON.stringify({
      sessionId: result.sessionId, sessionDir, workDir: process.cwd(),
    }) + '\\n');
    const wire = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!existsSync(wire)) writeFileSync(wire, JSON.stringify({ type: 'metadata', protocol_version: '1.5' }) + '\\n');
  }
  if (request.method === 'session/prompt') result = { stopReason: 'end_turn' };
  if (request.method === '_dev.happier/kimi/steer') {
    result = {
      sessionId: request.params.sessionId, turnId: '0', promptId: 'prompt-owner',
      accepted: true, disposition: request.params.prompt[0].text === 'queued' ? 'queued' : 'steered',
    };
  }
  if (request.method.startsWith('_dev.happier/kimi/goal/')) {
    const { sessionId, objective, status, tokenBudget } = request.params;
    if (request.method.endsWith('/set')) goal = {
      goalId: 'goal-owner', objective: objective ?? goal.objective, status: status ?? 'active',
      tokenBudget: tokenBudget ?? null, tokensUsed: 17, turnsUsed: 1, wallClockMs: 1200,
    };
    if (request.method.endsWith('/set') && objective === 'Autonomous native goal') {
      goalTurnHeld = true;
      notify('_dev.happier/kimi/goal/turn', { sessionId: 'foreign', turnId: '0', goalId: goal.goalId });
      journal(sessionId, { type: 'turn.prompt', turnId: 0, origin: { kind: 'system_trigger', name: 'goal_continuation' } });
      journal(sessionId, { type: 'context.append_loop_event', event: { type: 'content.part', turnId: 0, part: { type: 'text', text: 'owned goal output' } } });
    }
    if (request.method.endsWith('/get') && goalTurnHeld) {
      notify('_dev.happier/kimi/goal/turn', { sessionId, turnId: '0', goalId: goal.goalId });
    }
    if (request.method.endsWith('/clear')) {
      goal = null;
      if (goalTurnHeld) {
        goalTurnHeld = false;
        journal(sessionId, { type: 'turn.ended', turnId: 0, reason: 'completed' });
        notify('_dev.happier/kimi/goal/changed', { sessionId });
      }
    }
    result = { sessionId, goal };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
` });
  chmodSync(path, 0o755);
  return path;
}
