export const optionStrategies = [
  { id: "long_call", label: "Long call", optionType: "call", contracts: 1 },
  { id: "long_put", label: "Long put", optionType: "put", contracts: 1 },
  { id: "bull_call_debit", label: "Bull call debit spread", optionType: "call", contracts: 2 },
  { id: "bear_put_debit", label: "Bear put debit spread", optionType: "put", contracts: 2 },
  { id: "bull_put_credit", label: "Bull put credit spread", optionType: "put", contracts: 2 },
  { id: "bear_call_credit", label: "Bear call credit spread", optionType: "call", contracts: 2 }
] as const;

export type OptionStrategyId = typeof optionStrategies[number]["id"];
export function strategyDefinition(id: string) { return optionStrategies.find(strategy => strategy.id === id); }
export function orderOptionLegs<T extends { strike: string }>(strategy: OptionStrategyId, contracts: readonly T[]) {
  const ascending = strategy === "bull_call_debit" || strategy === "bear_call_credit";
  const sorted = [...contracts].sort((left, right) => (Number(left.strike) - Number(right.strike)) * (ascending ? 1 : -1));
  const sides: Array<"long" | "short"> = strategy === "bull_put_credit" || strategy === "bear_call_credit" ? ["short", "long"] : ["long", "short"];
  return sorted.map((contract, index) => ({ contract, side: sides[index] ?? "long" as const }));
}
export function validContractSelection(ids: string[], required: number) {
  return ids.length === required && new Set(ids).size === required && ids.every(id => /^[0-9a-f-]{36}$/i.test(id));
}
