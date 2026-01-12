-- Tinybird UI-Compatible Schema
-- Copy this into Tinybird UI when creating the datasource
-- Note: Partitioning can be added later via SQL if needed

tenant_id String,
project_id String,
environment Enum8('dev' = 1, 'prod' = 2),
timestamp DateTime64(3),
date Date MATERIALIZED toDate(timestamp),
trace_id String,
span_id String,
parent_span_id Nullable(String),
query String,
context Nullable(String),
model Nullable(String),
metadata_json String,
response String,
response_length UInt32,
tokens_prompt Nullable(UInt32),
tokens_completion Nullable(UInt32),
tokens_total Nullable(UInt32),
latency_ms UInt32,
ttfb_ms Nullable(UInt32),
streaming_ms Nullable(UInt32),
status Nullable(UInt16),
status_text Nullable(String),
finish_reason Nullable(String),
response_id Nullable(String),
system_fingerprint Nullable(String),
headers_json String






