import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeKimiFixture } from '../cli/runtimeDiscovery.testkit';
import { createKimiBackend } from './backend';
import type { AgentMessage } from '@/agent/core';
import type { AgentState, PermissionMode } from '@/api/types';
import { AcpBackend } from '@/agent/acp/AcpBackend';
import { getExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendRegistry';
import { createTestAcpRuntime } from '@/testkit/backends/acpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createSessionClientWithMetadata } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

describe.skipIf(process.platform === 'win32')('Kimi ACP backend', () => {
  it('restores the native goal and current steer window when an offline runner attaches to the relay', async () => {
    await withTempDir('happier-kimi-rebind-', async dir => {
      const command = writeKimiFixture(dir, 'current', 1);
      const backend = createKimiBackend({ cwd: dir, env: { HAPPIER_KIMI_PATH: command, KIMI_CODE_HOME: join(dir, 'kimi-home') } });
      if (!(backend instanceof AcpBackend)) throw new Error('Expected shared ACP backend');
      const relay = createSessionClientWithMetadata();
      let agentState: AgentState = { requests: {}, completedRequests: {} };
      const live = {
        ...relay.session, updateAgentState: (update: (state: AgentState) => AgentState) => { agentState = update(agentState); },
        setSessionRuntimeControls: vi.fn(),
      };
      const offline = { ...live, updateMetadata: () => {}, updateAgentState: () => {}, setSessionRuntimeControls: vi.fn() };
      let session: typeof live = offline;
      const runtime = createTestAcpRuntime({
        provider: 'kimi', directory: dir, session, getCurrentSession: () => session,
        messageBuffer: new MessageBuffer(), mcpServers: {}, permissionHandler: createApprovedPermissionHandler(),
        onThinkingChange: () => {}, ensureBackend: async () => backend,
      });
      try {
        await runtime.startOrLoad({});
        await vi.waitFor(() => expect(runtime.setGoal).toBeTypeOf('function'));
        await runtime.setGoal?.('Restore this native goal', { status: 'paused' });
        runtime.beginTurn();
        session = live;
        runtime.republishSessionControls?.();
        await vi.waitFor(() => expect(relay.getMetadata()).toMatchObject({ sessionWorkStateV1: { items: [{
          title: 'Restore this native goal', status: 'paused', vendorRef: 'goal-owner',
        }] } }));
        expect(agentState.capabilities).toMatchObject({ inFlightSteerSupported: true, inFlightSteerAvailable: true });
        const writes = relay.metadataUpdates.length;
        await runtime.refreshGoal?.();
        expect(relay.metadataUpdates).toHaveLength(writes);
      } finally { await runtime.reset(); }
    });
  });

  it('admits native autonomous goal output and steer only after the matching live owner witness', async () => {
    await withTempDir('happier-kimi-goal-turn-', async (dir) => {
      const command = writeKimiFixture(dir, 'current', 1);
      const backend = createKimiBackend({ cwd: dir, env: { HAPPIER_KIMI_PATH: command, KIMI_CODE_HOME: join(dir, 'kimi-home') } });
      if (!(backend instanceof AcpBackend)) throw new Error('Expected shared ACP backend');
      const fixture = createSessionClientWithMetadata();
      const runtime = createTestAcpRuntime({
        provider: 'kimi', directory: dir, session: fixture.session, messageBuffer: new MessageBuffer(), mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      });
      try {
        const sessionId = await runtime.startOrLoad({});
        await vi.waitFor(() => expect(runtime.setGoal).toBeTypeOf('function'));
        await runtime.setGoal?.('Autonomous native goal');
        expect(runtime.isTurnInFlight()).toBe(false);
        await runtime.refreshGoal?.();
        await vi.waitFor(() => expect(runtime.isTurnInFlight()).toBe(true));
        await runtime.steerPrompt('change direction');
        const calls = readFileSync(join(dir, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        expect(calls).toContainEqual(expect.objectContaining({ method: '_dev.happier/kimi/steer', params: {
          sessionId, expectedTurnId: '0', prompt: [{ type: 'text', text: 'change direction' }],
        } }));
        await runtime.clearGoal?.();
        await vi.waitFor(() => expect(fixture.committed.filter(message =>
          message.type === 'message' && message.message === 'owned goal output')).toHaveLength(1));
        await vi.waitFor(() => expect(runtime.isTurnInFlight()).toBe(false));
      } finally { await runtime.reset(); }
    });
  });

  it.each([undefined, 2, 1])('only binds and projects controls from the negotiated Kimi process (v%s)', async (version) => {
    await withTempDir('happier-kimi-controls-', async (dir) => {
      const command = writeKimiFixture(dir, 'current', version);
      const backend = createKimiBackend({ cwd: dir, env: { HAPPIER_KIMI_PATH: command, KIMI_CODE_HOME: join(dir, 'kimi-home') } });
      if (!(backend instanceof AcpBackend)) throw new Error('Expected shared ACP backend');
      const fixture = createSessionClientWithMetadata();
      const runtime = createTestAcpRuntime({
        provider: 'kimi', directory: dir, session: fixture.session, messageBuffer: new MessageBuffer(), mcpServers: {},
        permissionHandler: createApprovedPermissionHandler(), onThinkingChange: () => {}, ensureBackend: async () => backend,
      });
      const accepted = vi.fn();
      try {
        expect(runtime.supportsInFlightSteer()).toBe(false);
        expect(runtime.setGoal).toBeUndefined();
        const sessionId = await runtime.startOrLoad({});
        expect(runtime.supportsInFlightSteer()).toBe(version === 1);
        if (version === 1) {
          await vi.waitFor(() => expect(runtime.setGoal).toBeTypeOf('function'));
          expect(fixture.getMetadata()).not.toHaveProperty('sessionWorkStateV1');
          await runtime.setGoal?.('Verify the goal', { tokenBudget: 8000 });
          expect(fixture.getMetadata()).toMatchObject({ sessionWorkStateV1: { items: [{
            title: 'Verify the goal', status: 'active', vendorRef: 'goal-owner', tokenBudget: 8000, tokensUsed: 17,
          }] } });
          await runtime.clearGoal?.();
          expect(fixture.getMetadata()).toMatchObject({ sessionWorkStateV1: { items: [] } });
          runtime.beginTurn();
          await runtime.steerPrompt('change direction', { localId: 'user-17', onProviderPromptAccepted: accepted });
          await expect(runtime.steerPrompt('queued', { onProviderPromptAccepted: accepted })).rejects.toThrow();
          expect(accepted).toHaveBeenCalledTimes(1);
          const calls = readFileSync(join(dir, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
          expect(calls).toContainEqual(expect.objectContaining({ method: '_dev.happier/kimi/steer', params: {
            sessionId, prompt: [{ type: 'text', text: 'change direction' }], deliveryIdentity: { localId: 'user-17' },
          } }));
          expect(calls.filter((call) => call.method === 'session/prompt')).toHaveLength(0);
        } else {
          expect(runtime.setGoal).toBeUndefined();
          expect(runtime.clearGoal).toBeUndefined();
          await expect(runtime.steerPrompt('change direction')).rejects.toThrow();
        }
      } finally { await runtime.reset(); }
      expect(runtime.supportsInFlightSteer()).toBe(false);
      expect(runtime.setGoal).toBeUndefined();
    });
  });

  it('keeps native approvals manual across lifecycle and host policy changes while preserving ACP and MCP', async () => {
    await withTempDir('happier-kimi-backend-', async (dir) => {
      const physicalDir = realpathSync(dir);
      const command = writeKimiFixture(dir, 'current');
      let permissionMode: PermissionMode = 'yolo';
      const options = {
        cwd: dir, env: { HAPPIER_KIMI_PATH: command, KIMI_CODE_HOME: join(dir, 'kimi-home') }, permissionMode,
        getPermissionMode: () => permissionMode,
        mcpServers: { happier: { command: '/bin/echo', args: ['noop'] } },
      };
      const fresh = createKimiBackend(options);
      const events: AgentMessage[] = [];
      fresh.onMessage((event) => events.push(event));
      try {
        expect(await fresh.startSession()).toMatchObject({ sessionId: 'kimi-fixture-session' });
        expect(events.some((event) => event.type === 'event' && event.name === 'session_modes_state')).toBe(false);
        expect(events.filter((event) => event.type === 'event' && event.name === 'config_options_state'))
          .toEqual([expect.objectContaining({ payload: { configOptions: [expect.objectContaining({ id: 'model' })] } })]);
        if (!(fresh instanceof AcpBackend)) throw new Error('Expected shared ACP backend');
        await expect(fresh.setSessionMode('kimi-fixture-session', 'yolo')).rejects.toThrow(/disabled/);
        await expect(fresh.setSessionConfigOption('kimi-fixture-session', 'mode', 'auto')).rejects.toThrow(/disabled/);
        for (const nextMode of ['default', 'plan', 'yolo'] as const) {
          permissionMode = nextMode;
          await fresh.sendPrompt('kimi-fixture-session', 'fixture policy change');
          await fresh.waitForResponseComplete();
        }
      } finally { await fresh.dispose(); }
      const resumed = createKimiBackend(options);
      try {
        expect(await resumed.loadSession?.('kimi-fixture-session')).toMatchObject({ sessionId: 'kimi-fixture-session' });
      } finally { await resumed.dispose(); }
      const requests = readFileSync(join(dir, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(requests.filter((request) => ['session/new', 'session/load'].includes(request.method))).toEqual([
        expect.objectContaining({ method: 'session/new', cwd: physicalDir, args: ['acp'], params: expect.objectContaining({ mcpServers: [expect.objectContaining({ name: 'happier', command: '/bin/echo' })] }) }),
        expect.objectContaining({ method: 'session/load', cwd: physicalDir, args: ['acp'], params: expect.objectContaining({ sessionId: 'kimi-fixture-session', mcpServers: [expect.objectContaining({ name: 'happier' })] }) }),
      ]);
      expect(requests.filter((request) => request.method === 'session/set_mode').map((request) => request.params))
        .toEqual([
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
        ]);
      const forked = createKimiBackend(options);
      try {
        if (!(forked instanceof AcpBackend)) throw new Error('Expected shared ACP backend');
        expect(await forked.forkSession({ sessionId: 'kimi-fixture-session' }))
          .toMatchObject({ sessionId: 'kimi-fixture-fork' });
      } finally { await forked.dispose(); }
      const executionRunBackendFactory = getExecutionRunBackendFactory('kimi');
      if (!executionRunBackendFactory) throw new Error('Expected Kimi execution-run backend factory');
      const executionRun = executionRunBackendFactory({
        backendId: 'kimi', cwd: dir, modelId: 'kimi-for-coding', permissionMode: 'default',
        permissionHandler: { handleToolCall: async () => ({ decision: 'denied' }) },
        isolation: { env: { HAPPIER_KIMI_PATH: command, KIMI_CODE_HOME: join(dir, 'kimi-home') } },
      });
      try {
        expect(await executionRun.startSession()).toMatchObject({ sessionId: 'kimi-fixture-session' });
      } finally { await executionRun.dispose(); }
      const executionRunRequests = readFileSync(join(dir, 'requests.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(executionRunRequests).toContainEqual(expect.objectContaining({
        method: 'session/set_config_option',
        params: expect.objectContaining({ sessionId: 'kimi-fixture-session', configId: 'model', value: 'kimi-for-coding' }),
      }));
      expect(executionRunRequests.some((request) => request.method === 'session/set_model')).toBe(false);
      expect(executionRunRequests.filter((request) => request.method === 'session/set_mode').map((request) => request.params))
        .toEqual([
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
          { sessionId: 'kimi-fixture-fork', modeId: 'default' },
          { sessionId: 'kimi-fixture-session', modeId: 'default' },
        ]);
    });
  });
});
