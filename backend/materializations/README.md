# Tinybird Materializations

Pre-aggregated views over `canonical_events` for faster analytics.

- **cost_daily_by_model**: Cost by day and model. Query with `sumMerge(total_cost)`, `countMerge(event_count)`.
- **latency_daily_by_model**: Latency percentiles by day and model. Query with `quantileMerge(0.5)(latency_p50)`, `quantileMerge(0.95)(latency_p95)`.

To add error-rate or token-usage materializations, create a target datasource with `AggregatingMergeTree` and a pipe that reads from `canonical_events` filtered by `event_type = 'error'` or extracts `$.llm_call.total_tokens`, then run `tb build` and attach the materialized pipe to the `canonical_events` datasource in Tinybird.
