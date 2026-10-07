Synthetic publisher/client interoperability fixture, generated on 2026-10-06 by
`faa-regs` `writeObstacleArtifacts` (obstruction index v1). The CSV contains a
filtered 499-foot tower, an eligible 500-foot tower with precise coordinates, and
an unverified grouped 2,000-foot wind turbine with high-intensity lighting.

`publisher-v1.bin` is the actual publisher output; `publisher-v1.json` describes
its digest/count and the parent gzip source identity. No real FAA observations
are represented. Client tests read these bytes independently of their own encoder.
