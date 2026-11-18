import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';

export const KIMI_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    workState: {
        // Kimi's goal authority lives on the active ACP peer. The registry intersects
        // this policy with the live runner's negotiated set/clear capability bits.
        supportsEditableGoals: ({ session }) => session.active === true,
    },
};
