These small schema-2 fixtures were generated with faa-regs `terrainBlocks` and
`encodeTerrainArchive`, using bounds `[-122.01, 37.01, -122.009, 37.011]`.
Every quadrant contains int16 metre values `[-12, -32768, 10000, 321, ...321]`;
`-32768` represents NoData. The geographic grid is anchored at (-180, 90), with
exactly 4.9 arc-seconds at level 10 and doubled spacing at each coarser level.
The tests check publisher/consumer geometry, hashes, quadrant decoding, format
validation, native sampling, legacy coexistence and offline selection.
