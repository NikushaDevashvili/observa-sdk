-- Optional: Add partitioning after datasource creation
-- Run this SQL in Tinybird UI after creating the datasource
-- Note: This may require admin access or may not be supported in all Tinybird plans

-- Tinybird typically handles partitioning automatically based on ORDER BY
-- But if you need explicit partitioning, you can try:
-- ALTER TABLE traces MODIFY PARTITION BY (tenant_id, toYYYYMM(date))

-- For most use cases, the ORDER BY (tenant_id, project_id, timestamp, trace_id)
-- provides sufficient query performance without explicit partitioning


