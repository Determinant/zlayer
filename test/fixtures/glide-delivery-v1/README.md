# Glide delivery v1 conformance fixture

Copied from `faa-downloader/test/fixtures/glide-delivery-v1`, the complete publisher
release with two overlapping synthetic regions and a schema-8 record with a hole.
`expected-detail.json` preserves the original tuples and source IDs. The client
checks every archive independently; no publisher implementation is imported.
See `test/glide-packages.test.ts` and `test/e2e/glide-packages.spec.ts`.
