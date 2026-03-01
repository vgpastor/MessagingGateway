# TODO

## @batchactions/core — Add `fromRecords()` to BatchEngine

**Repo:** https://github.com/vgpastor/batchactions

Currently `BatchEngine` requires `DataSource` + `parser` pipeline, designed for ETL from files/streams. For in-memory record processing (e.g. periodic health checks on accounts), this forces an unnecessary serialize/parse roundtrip.

### Proposal

```typescript
// Current: requires DataSource + parser
engine.from(new BufferSource(JSON.stringify(accounts)), jsonParser);

// Proposed: direct in-memory records
engine.fromRecords(accounts);
```

### Why

In MessagingGateway we need to batch-process accounts for health checks. `BatchEngine` would provide concurrency control (`maxConcurrentBatches`), retries (`maxRetries`), and error handling (`continueOnError`) — but the DataSource/parser requirement adds unnecessary complexity for in-memory data.

### Impact

Makes `@batchactions/core` useful beyond ETL — any batch operation on in-memory data. Once implemented, replace `HealthCheckScheduler.runAll()` with `BatchEngine.fromRecords(accounts).start(processor)`.
