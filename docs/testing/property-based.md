# Property-based testing

This policy implements `TST-038` inside the unit-test gate. Generated cases use
[`checkProperty`](../../tests/support/property.ts), which runs 200 cases by
default with a deterministic seed derived from the property identifier. The
optional `PROPERTY_SEED` environment value and per-call `seedOffset` are integer
offsets; wall-clock time and ambient randomness never select a run.

The governed properties cover:

- money: gross/net/tax conservation and bounds, monotonic gross splitting,
  quote and discount consistency, aggregate totals, quantity rules and
  non-increasing volume tiers;
- inventory: the sellable-stock formula, monotonic reservations and the exact
  equivalence between reservation decisions and assertions, including
  backorders;
- states: every declared transition, every undeclared pair and all terminal
  states across order, payment, inventory, fulfilment, invoice and return maps;
- addresses: fiscal-ID normalization idempotence, country-specific postal,
  fiscal and phone grammars, formatting tolerance and repeated validation of
  generated Spanish addresses;
- catalog parser/import: arbitrary quoted UTF-8 CSV cells, spreadsheet-formula
  sanitization, total validation over arbitrary textual records and equality of
  valid datasets before and after CSV transport.

## Failure seeds

On failure the helper writes
`test-results/property-failures/<property-id>.json` with the property ID, seed,
shrunk `counterexamplePath`, shrink count and a safely serializable
counterexample. The normal CI evidence upload retains `test-results/` on failed
runs. After review, the seed and path are copied to the versioned
[`property-seeds.json`](../../tests/fixtures/property-seeds.json). Every later run
replays persisted entries before exploring its deterministic base seed, so a
regression cannot disappear behind a different generated sequence.

The initial expanded suite found that a quoted CSV cell ending in a literal
carriage return lost that character during parsing. Its seed and fully shrunk
path are persisted under `TST038-catalog-csv-roundtrip`; the parser fix therefore
has a permanent generated regression replay rather than only an example test.

Run the focused suite with:

```bash
npx vitest run --project unit tests/unit/property-helper.test.ts tests/unit/money.test.ts tests/unit/inventory.test.ts tests/unit/states.test.ts tests/unit/customer.test.ts tests/unit/catalog-tabular.test.ts
```
