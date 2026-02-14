export type AgentMessageKind = "observation" | "summary";
export type AgentMetricName = "success" | "parse_fail" | "schema_fail" | "repair_fail" | "fallback_used";

type CounterMap = Record<AgentMetricName, number>;

function newCounters(): CounterMap {
  return {
    success: 0,
    parse_fail: 0,
    schema_fail: 0,
    repair_fail: 0,
    fallback_used: 0
  };
}

export class AgentMetrics {
  private readonly counters: Record<AgentMessageKind, CounterMap> = {
    observation: newCounters(),
    summary: newCounters()
  };

  incr(kind: AgentMessageKind, name: AgentMetricName): void {
    this.counters[kind][name] += 1;
  }

  snapshot(): Record<AgentMessageKind, CounterMap> {
    return {
      observation: { ...this.counters.observation },
      summary: { ...this.counters.summary }
    };
  }

  reset(): void {
    this.counters.observation = newCounters();
    this.counters.summary = newCounters();
  }
}

export const agentMetrics = new AgentMetrics();
