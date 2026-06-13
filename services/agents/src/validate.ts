import { parseAgentTurnOutput, type AgentObservation, type AgentTurnOutput, type TradeAction } from '@darkbox/shared';

export interface ValidationResult {
  ok: boolean;
  output?: AgentTurnOutput;
  errors: string[];
}

function marketExists(observation: AgentObservation, marketId: string): boolean {
  return observation.markets.some((market) => market.marketId === marketId);
}

function hasOrder(observation: AgentObservation, orderId: string): boolean {
  return observation.orders.some((order) => order.orderId === orderId && Number(order.remainingSize) > 0);
}

function validateTradeAction(observation: AgentObservation, action: TradeAction): string[] {
  const errors: string[] = [];
  if ('marketId' in action && !marketExists(observation, action.marketId)) {
    errors.push(`${action.type}: unknown marketId ${action.marketId}`);
  }
  if (action.type === 'take_order' && !hasOrder(observation, action.orderId)) {
    errors.push(`take_order: unknown or empty orderId ${action.orderId}`);
  }
  if (action.type === 'cancel_order' && !hasOrder(observation, action.orderId)) {
    errors.push(`cancel_order: unknown or empty orderId ${action.orderId}`);
  }
  if (action.type === 'make_order') {
    const price = Number(action.price);
    const size = Number(action.size);
    if (!(price > 0 && price < 1)) errors.push('make_order: price must be between 0 and 1');
    if (!(size > 0)) errors.push('make_order: size must be positive');
  }
  if (['split', 'merge'].includes(action.type)) {
    const amount = Number((action as { amount: string }).amount);
    if (!(amount > 0)) errors.push(`${action.type}: amount must be positive`);
  }
  return errors;
}

export function validateTurnOutput(input: unknown, observation: AgentObservation): ValidationResult {
  try {
    const output = parseAgentTurnOutput(input);
    const errors = output.tradeActions.flatMap((action) => validateTradeAction(observation, action));
    if (output.billboardPost && output.billboardPost.message.trim().length === 0) {
      errors.push('billboardPost: message cannot be blank');
    }
    if (output.marketProposal && output.marketProposal.outcomes.join('/') !== 'YES/NO') {
      errors.push('marketProposal: outcomes must be YES/NO');
    }
    return { ok: errors.length === 0, output, errors };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
