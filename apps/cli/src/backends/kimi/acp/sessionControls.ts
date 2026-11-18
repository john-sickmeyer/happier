import {
  buildVendorSessionWorkStateItemId, lazySchema, mergeSessionWorkStateMetadataV1,
  readDisplayableSessionWorkStateV1, type SessionWorkStateItemV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

import type { AcpGoalRuntimeControls, AcpNegotiatedSessionControls, AcpSessionGoalHost } from '@/agent/acp/AcpBackend';
import { defineAcpExtensionNotification } from '@/agent/acp/connection/types';

const capabilityKey = 'dev.happier/kimiControls';
const methodPrefix = '_dev.happier/kimi';
const goalItemPrefix = 'goal:kimi:';
const identifier = lazySchema(() => z.string().refine(value => value.trim().length > 0));
const capability = lazySchema(() => z.object({
  _meta: z.object({ [capabilityKey]: z.object({ version: z.literal(1), steer: z.boolean().optional(), goal: z.boolean().optional(), goalTurns: z.boolean().optional() }) }),
}));
const admission = lazySchema(() => z.object({
  accepted: z.literal(true), disposition: z.literal('steered'), sessionId: identifier,
  promptId: identifier, turnId: z.string().regex(/^(0|[1-9]\d*)$/),
}));
const refusal = lazySchema(() => z.object({
  accepted: z.literal(false), sessionId: identifier, disposition: z.enum(['not_active', 'not_consumed']),
}));
const nativeGoal = lazySchema(() => z.object({
  goalId: identifier, objective: z.string().trim().min(1),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  tokenBudget: z.number().int().positive().nullable(), tokensUsed: z.number().int().nonnegative(),
  wallClockMs: z.number().finite().nonnegative(),
}));
type NativeGoal = z.infer<typeof nativeGoal>;
const goalResponse = lazySchema(() => z.object({
  sessionId: identifier, goal: nativeGoal.nullable(), completedGoalId: identifier.optional(),
}));

export const kimiControlNotifications = [
  defineAcpExtensionNotification({
    method: `${methodPrefix}/goal/turn`,
    params: lazySchema(() => z.object({ sessionId: identifier, turnId: z.string().regex(/^(0|[1-9]\d*)$/), goalId: identifier })),
    handler: ({ turnId, goalId }, context) => context.goalTurns?.witness(turnId, goalId),
  }),
  defineAcpExtensionNotification({
    method: `${methodPrefix}/goal/changed`,
    params: lazySchema(() => z.object({ sessionId: identifier })),
    handler: (_params, context) => context.goalTurns?.changed(),
  }),
];

function createKimiGoalControls(host: AcpSessionGoalHost): AcpGoalRuntimeControls {
  let previous: NativeGoal | null | undefined;
  let tail = Promise.resolve();
  const serialize = (run: () => Promise<void>): Promise<void> => {
    const next = tail.then(run);
    tail = next.catch(() => {});
    return next;
  };
  const request = async (operation: 'get' | 'set' | 'clear', fields?: Record<string, unknown>) => {
    const reply = goalResponse.safeParse(await host.request(`${methodPrefix}/goal/${operation}`, fields));
    if (!reply.success || reply.data.sessionId !== host.sessionId) {
      throw new Error('Kimi goal readback did not identify the active session');
    }
    return reply.data;
  };
  const publish = async (goal: NativeGoal | null): Promise<void> => {
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(goal)) return;
    const updatedAt = Date.now();
    const items: SessionWorkStateItemV1[] = goal ? [{
      id: buildVendorSessionWorkStateItemId('goal', `kimi:${goal.goalId}`), kind: 'goal', origin: 'vendor',
      vendorRef: goal.goalId, backendId: 'kimi', title: goal.objective.slice(0, 4000), status: goal.status,
      tokenBudget: goal.tokenBudget, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.wallClockMs / 1000,
      goalCapabilities: { canEdit: true, canStop: true, canClear: true }, updatedAt,
    }] : [];
    await host.updateMetadata(metadata => {
      if (!goal) {
        const existing = readDisplayableSessionWorkStateV1((metadata as Record<string, unknown>).sessionWorkStateV1);
        if (!existing?.items.some(item => item.id.startsWith(goalItemPrefix))) return metadata;
      }
      return {
        ...metadata,
        ...mergeSessionWorkStateMetadataV1({
          metadata, nextOwned: { v: 1, backendId: 'kimi', updatedAt, items }, ownedItemIdPrefixes: [goalItemPrefix],
        }),
      };
    });
    previous = goal;
  };
  return {
    refreshGoal: () => serialize(async () => { await publish((await request('get')).goal); }),
    setGoal: (objective, options) => serialize(async () => {
      const explicitObjective = options?.objectiveFromMetadata ? undefined : objective;
      const expectedGoalId = previous?.goalId ?? null;
      const reply = await request('set', {
        expectedGoalId,
        ...(explicitObjective !== undefined ? { objective: explicitObjective } : {}),
        ...(options?.status !== undefined ? { status: options.status } : {}),
        ...(options?.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
      });
      const confirmed = options?.status === 'complete'
        ? expectedGoalId !== null && reply.completedGoalId === expectedGoalId && reply.goal === null
        : reply.goal !== null
          && (expectedGoalId === null || reply.goal.goalId === expectedGoalId)
          && (explicitObjective === undefined || reply.goal.objective === explicitObjective.trim())
          && (options?.status === undefined || reply.goal.status === options.status)
          && (options?.tokenBudget === undefined || reply.goal.tokenBudget === options.tokenBudget);
      if (!confirmed) throw new Error('Kimi did not confirm the requested goal update');
      await publish(reply.goal);
    }),
    clearGoal: () => serialize(async () => {
      const reply = await request('clear', { expectedGoalId: previous?.goalId ?? null });
      if (reply.goal !== null) throw new Error('Kimi did not confirm goal removal');
      await publish(null);
    }),
  };
}

export function negotiateKimiSessionControls(raw: unknown): AcpNegotiatedSessionControls {
  const parsed = capability.safeParse(raw);
  if (!parsed.success) return {};
  const controls = parsed.data._meta[capabilityKey];
  return {
    ...(controls.steer === true ? { inFlightSteer: {
      method: `${methodPrefix}/steer`,
      buildParams: ({ sessionId, content, deliveryIdentity, expectedTurnId }) => ({
        sessionId, prompt: content, ...(deliveryIdentity ? { deliveryIdentity } : {}),
        ...(expectedTurnId === undefined ? {} : { expectedTurnId }),
      }),
      isAccepted: (raw, sessionId, expectedTurnId) => {
        const parsed = admission.safeParse(raw);
        return parsed.success && parsed.data.sessionId === sessionId
          && (expectedTurnId === undefined || parsed.data.turnId === expectedTurnId);
      },
      isRejectedBeforeEffect: (raw, sessionId) => {
        const parsed = refusal.safeParse(raw);
        return parsed.success && parsed.data.sessionId === sessionId;
      },
    } } : {}),
    ...(controls.goal === true ? { createGoalControls: createKimiGoalControls } : {}),
    goalTurns: controls.goal === true && controls.goalTurns === true,
  };
}
